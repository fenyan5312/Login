// Writing a successful sign-in back into magpie's `plugin-auth.json`, without
// the browser orchestration or the UI. This module is isomorphic to magpie's
// own `signInKey` + `save` + `settle` path, with one deliberate narrowing
// spelled out on `readAuthEntries` below.
//
// It never signs in, never opens a browser and never touches the auth file on
// its own: `writeBack` goes through the injected `client.auth.set`, exactly
// the call magpie's `save` makes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshAccountKey, providerOf } from "./account-keys.mjs";
import { magpieConfigDir } from "./paths.mjs";

// magpie's `accountsOf`: every key of a provider, the bare provider id first,
// then the `id#slot` keys in lexicographic order.
export function accountsOf(all, provider) {
  const keys = all instanceof Set ? [...all] : Array.isArray(all) ? all : Object.keys(all ?? {});
  return keys
    .filter((key) => key === provider || key.startsWith(provider + "#"))
    .sort((a, b) => (a === provider ? -1 : b === provider ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// magpie's `whoOf`: the account's human name, from `accountId`, then
// `metadata.email`, then `email`. Empty string means "unnamed".
export function whoOf(account) {
  return account?.accountId ?? account?.metadata?.email ?? account?.email ?? "";
}

// magpie's `uidOf`: the account's stable id, only when it really is a string.
export function uidOf(account) {
  return typeof account?.uid === "string" ? account.uid : "";
}

// magpie's `signInKey`: where a sign-in goes. `single` providers always keep
// their first account key; otherwise the named account is reused when it
// belongs to this provider, and a fresh key is allocated otherwise.
//
// `existingKeys` may be a Set, an array of keys or a key -> entry object (the
// shape `readAuthEntries` returns). `random` is injectable so tests can state
// the suffix rule instead of recording a draw.
export function signInKey(provider, account, existingKeys, { single = false, random = Math.random } = {}) {
  const keys =
    existingKeys instanceof Set
      ? existingKeys
      : new Set(Array.isArray(existingKeys) ? existingKeys : Object.keys(existingKeys ?? {}));
  if (single === true) return accountsOf(keys, provider)[0] ?? provider;
  if (account && account !== "new" && providerOf(account) === provider) return account;
  return freshAccountKey(provider, keys, random);
}

// magpie's `save` body: drop `type` and `provider`, keep `refresh`/`access`/
// `expires` at the top level and spread every other field flat. The account's
// name and uid survive inside `extra`, which is what makes `whoOf`/`uidOf`
// work on the stored entry later.
export function normalizeResult(result) {
  const { type: _type, provider: _provider, refresh, access, expires, ...extra } = result ?? {};
  return { type: "oauth", refresh, access, expires, ...extra };
}

// magpie's `settle` matching, minus the secret comparison (see
// `readAuthEntries`). Two entries are the same account when their name is
// non-empty and equal and their uids do not conflict, or when `renamedBy`:
// same non-empty uid, different names, and one of those names is the uid.
function sameAccount(existing, incoming) {
  const existingWho = whoOf(existing);
  const incomingWho = whoOf(incoming);
  const existingUid = uidOf(existing);
  const incomingUid = uidOf(incoming);
  const uidCompatible =
    !existingUid || !incomingUid || existingUid === incomingUid;
  if (existingWho && incomingWho && existingWho === incomingWho && uidCompatible) return true;
  return Boolean(
    existingUid &&
      incomingUid &&
      existingUid === incomingUid &&
      existingWho !== incomingWho &&
      (existingWho === existingUid || incomingWho === incomingUid),
  );
}

// The core: which key a callback's result should be written to. First the
// de-duplication magpie's `settle` does (reuse an existing key for the same
// account instead of adding one), then magpie's `signInKey` allocation.
//
// `opts.takenKeys` names keys that are occupied without a credential: a retired
// identity's key, whose directory still holds that account's pin. They are only
// added to the key set the allocation draws from -- they carry no entry, so
// they can never win the same-account match -- which keeps a write-back off a
// directory that belongs to another account. A caller that does not pass it
// gets exactly the old behavior.
export function chooseAccountKey(provider, result, existingEntries = {}, opts = {}) {
  const entries = existingEntries ?? {};
  const { single = false, random = Math.random, account, takenKeys = null } = opts;
  const body = normalizeResult(result);
  // magpie's `save`: `result.provider` overrides the provider the callback was
  // invoked for.
  const id =
    result && typeof result.provider === "string" && result.provider
      ? result.provider
      : provider;

  // A `single` provider has exactly one slot, so it always lands there, even
  // when another key happens to name the same account.
  if (single === true) return signInKey(id, account, entries, { single: true, random });

  if (whoOf(body) || uidOf(body)) {
    for (const key of accountsOf(entries, id)) {
      if (sameAccount(entries[key] ?? {}, body)) return key;
    }
  }
  let available = entries;
  if (takenKeys && takenKeys.size > 0) {
    available = new Set(Object.keys(entries));
    for (const key of takenKeys) available.add(key);
  }
  return signInKey(id, account, available, { single: false, random });
}

// Reads only non-credential fields of every entry: `accountId`, `uid`, `type`
// and `email`. Credential fields (`access`, `refresh`, `key`) and the whole
// `metadata` object are never returned. `email` is derived from
// `metadata.email` when the entry has no top-level `email`, so `whoOf` keeps
// magpie's fallback without exposing metadata.
//
// This is a deliberate narrowing of magpie's full `settle()`: magpie can also
// match two entries that both have no account name by comparing their secret.
// We give that rare branch up so we never have to read a credential value.
// The consequence: two signs-in that are both unnamed are treated as distinct
// accounts and get separate keys, where magpie might de-duplicate them.
//
// Any failure (missing file, unreadable, malformed JSON) yields `{}` and never
// throws.
export function readAuthEntries(env = process.env) {
  try {
    const text = readFileSync(join(magpieConfigDir(env), "plugin-auth.json"), "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = {};
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      const entry = {};
      if (value && typeof value === "object") {
        if (typeof value.accountId === "string") entry.accountId = value.accountId;
        if (typeof value.uid === "string") entry.uid = value.uid;
        if (typeof value.type === "string") entry.type = value.type;
        const email =
          typeof value.email === "string"
            ? value.email
            : typeof value.metadata?.email === "string"
              ? value.metadata.email
              : undefined;
        if (email !== undefined) entry.email = email;
      }
      entries[key] = entry;
    }
    return entries;
  } catch {
    return {};
  }
}

// Chooses the final key, builds the body magpie's `save` would write and hands
// both to `client.auth.set({ path: { id: key }, body })`. Nothing is thrown:
// the returned `{ ok, key, created, updated, error, entry }` carries the
// failure.
//
// `entry` is a non-credential summary of the written account -- `provider`,
// `key`, `accountId`, `uid`, `type` -- for the ownership ledger. It never
// contains `access`, `refresh`, `key` (the credential field) or `metadata`.
//
// `opts.forceKey` names the exact key to write to and skips `chooseAccountKey`
// entirely. A caller reusing a retired identity must land on the key the user
// picked, so the settle name match must not move the write to another key.
//
// `opts.takenKeys` (see `chooseAccountKey`) is forwarded, so the write-back
// allocates against the same key set the sign-in was allocated against.
//
// `entries` may be an entry object, a function that returns one, or omitted, in
// which case `opts.readEntries` (default `readAuthEntries`) is called. A read
// failure is treated as "no entries", so a write can still use the bare key or
// a fresh one; `created`/`updated` then reflect what was actually known.
export async function writeBack({ provider, result, entries, client, opts = {} }) {
  let existing = {};
  try {
    if (typeof entries === "function") existing = entries() ?? {};
    else if (entries && typeof entries === "object") existing = entries;
    else {
      const read = opts.readEntries ?? (() => readAuthEntries(opts.env ?? process.env));
      existing = read() ?? {};
    }
  } catch {
    existing = {};
  }

  const body = normalizeResult(result);
  const providerId =
    result && typeof result.provider === "string" && result.provider
      ? result.provider
      : provider;
  let key;
  try {
    key = opts.forceKey ? String(opts.forceKey) : chooseAccountKey(provider, result, existing, opts);
  } catch (error) {
    return { ok: false, key: null, created: false, updated: false, error: String(error?.message ?? error), entry: null };
  }

  const entry = {
    provider: providerId,
    key,
    accountId: typeof body.accountId === "string" ? body.accountId : null,
    uid: typeof body.uid === "string" ? body.uid : null,
    type: typeof body.type === "string" ? body.type : null,
  };

  const updated = Object.prototype.hasOwnProperty.call(existing, key);
  const created = !updated;
  try {
    await client.auth.set({ path: { id: key }, body });
    return { ok: true, key, created, updated, error: null, entry };
  } catch (error) {
    return { ok: false, key, created, updated, error: String(error?.message ?? error), entry };
  }
}
