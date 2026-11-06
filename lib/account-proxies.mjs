// Keeping magpie's per-account proxy in step with the exit the account signed
// in through.
//
// Why this module writes a file instead of calling an API: the plugin host
// hands a plugin `client.auth`, `client.app.log`, `client.config.get` and
// `input.magpie`, and none of them can set a provider's account proxy. The
// page itself is sandboxed to its declared reads, so it cannot POST
// `/api/provider/save` either. What magpie *does* do is watch its own config:
// `providers.json` is read through its file memo (keyed on the file's stat)
// and re-read when the file changes, so an atomic replace here is picked up
// without a restart. Verified on magpie 0.1.3001 by replacing the file and
// watching `/v1/models` reflect the new labels within a second.
//
// The shape written here is the one magpie's own editor saves:
//   providers[].accountProxies = { "<account user name, lower case>": "<url>" }
// (`accountProxyPicker` keys each row by `login.user.toLowerCase()`, and
// `accountProxiesOfDraft()` stores `"direct"` or the URL text). An account
// without an entry follows the provider-level proxy, which is exactly the
// behaviour this module replaces for the accounts it knows about.
//
// Two callers, two policies:
//   - a finished sign-in overwrites that account's own entry, because the
//     user has just picked the exit again;
//   - the startup backfill only fills entries that are absent, so a proxy the
//     user set by hand in magpie's editor is never clobbered.
//
// Nothing here may break a sign-in: a missing or unreadable providers.json is
// reported, never thrown, and every caller treats the result as best effort.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { magpieConfigDir, pluginDataDir } from "./paths.mjs";
import { listAccountDirsWithMeta } from "./account-identity.mjs";

export const PROVIDERS_FILE_NAME = "providers.json";
const URL_TYPES = new Set(["http", "https", "socks5"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// A user name that is also an object key with special meaning must never be
// written into magpie's map; such an account is left on the provider proxy.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function providersFile(env = process.env) {
  return join(magpieConfigDir(env), PROVIDERS_FILE_NAME);
}

// magpie keys the map by the account's user name in lower case. The name is
// always computed from the account the sign-in returned, never hard-coded.
export function accountProxyKey(user) {
  return String(user ?? "").trim().toLowerCase();
}

// The stored proxy record carries credentials; magpie's own editor expects
// them inline in the URL (`http://user:pass@host:port`), so they are encoded
// rather than dropped. A record without a usable address yields null and the
// account is simply left alone.
export function proxyUrlFor(record) {
  if (!record || typeof record !== "object") return null;
  const direct = typeof record.url === "string" ? record.url.trim() : "";
  if (direct && SCHEME.test(direct)) return direct;
  const host = String(record.host ?? "").trim();
  const port = Number(record.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const type = String(record.type ?? "http").trim().toLowerCase() || "http";
  if (!URL_TYPES.has(type)) return null;
  const username = String(record.username ?? "");
  const password = String(record.password ?? "");
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${type}://${auth}${address}:${port}`;
}

// Writes within this process are serialized per file, so a sign-in finishing
// while the startup backfill runs cannot interleave two read-modify-write
// cycles and lose one of them.
const chains = new Map();

function serialized(file, work) {
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function writeAtomic(file, text) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${PROVIDERS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temp, file);
    } catch (error) {
      // Windows cannot rename over an existing file that another process has
      // open; fall back to removing the target first, as the proxy store does.
      if (!["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code)) throw error;
      await rm(file, { force: true });
      await rename(temp, file);
    }
    try {
      await chmod(file, 0o600);
    } catch {
      // POSIX modes are not implemented everywhere; the file still holds only
      // proxy URLs inside the user's own config directory.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// `entries` is a list of `{ provider, accountId, url }`. Returns a report
// instead of throwing for the expected "nothing to do" cases, so a sign-in is
// never failed by a magpie installation that has no providers.json yet.
export async function writeAccountProxies({
  env = process.env,
  entries = [],
  onlyMissing = false,
  file = providersFile(env),
} = {}) {
  const wanted = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      provider: String(entry?.provider ?? "").trim(),
      key: accountProxyKey(entry?.accountId),
      url: String(entry?.url ?? "").trim(),
    }))
    .filter((entry) => entry.provider && entry.key && entry.url && !RESERVED_KEYS.has(entry.key));
  const report = { ok: false, file, changed: [], skipped: [], reason: null };
  if (!wanted.length) {
    report.ok = true;
    report.reason = "nothing_to_sync";
    return report;
  }

  return serialized(file, async () => {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      report.reason = error?.code === "ENOENT" ? "providers_missing" : "providers_unreadable";
      report.error = String(error?.message ?? error);
      return report;
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      // Never "repair" magpie's file: a malformed one is left exactly as it
      // is, which is also what magpie itself does.
      report.reason = "providers_invalid";
      return report;
    }
    if (!Array.isArray(doc?.providers)) {
      report.reason = "providers_invalid";
      return report;
    }

    for (const entry of wanted) {
      const provider = doc.providers.find((item) => item?.id === entry.provider);
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
        report.skipped.push({ ...entry, reason: "provider_missing" });
        continue;
      }
      const existing =
        provider.accountProxies &&
        typeof provider.accountProxies === "object" &&
        !Array.isArray(provider.accountProxies)
          ? provider.accountProxies
          : {};
      // `accountProxies` is an own-property map keyed by user name; only the
      // exact account key is ever read or written, never a prototype key.
      if (!Object.hasOwn(provider, "accountProxies") || provider.accountProxies !== existing) {
        provider.accountProxies = { ...existing };
      }
      if (onlyMissing && Object.hasOwn(provider.accountProxies, entry.key)) {
        report.skipped.push({ ...entry, reason: "already_set" });
        continue;
      }
      if (provider.accountProxies[entry.key] === entry.url) {
        report.skipped.push({ ...entry, reason: "unchanged" });
        continue;
      }
      provider.accountProxies[entry.key] = entry.url;
      report.changed.push(entry);
    }

    if (!report.changed.length) {
      report.ok = true;
      report.reason = "up_to_date";
      return report;
    }
    await writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
    report.ok = true;
    report.reason = "written";
    return report;
  });
}

// A finished sign-in: the account's own entry follows the exit it just used.
// `proxy` is the full stored record (credentials included) when the page named
// a stored exit; a direct sign-in has none and leaves magpie untouched.
export async function syncSignInProxy({ env = process.env, provider, accountId, proxy } = {}) {
  const url = proxyUrlFor(proxy);
  if (!url || !accountProxyKey(accountId) || !provider) {
    return { ok: true, changed: [], skipped: [], reason: "no_proxy" };
  }
  return writeAccountProxies({ env, entries: [{ provider, accountId, url }] });
}

// Startup backfill: every ledger that remembers which exit it signed in
// through gets that exit into magpie, but only where magpie has no entry yet.
// This is what repairs accounts signed in before this feature existed, without
// touching anything the user configured by hand.
export async function backfillAccountProxies({
  env = process.env,
  store,
  listAccounts = listAccountDirsWithMeta,
  file = providersFile(env),
} = {}) {
  const report = { ok: false, file, changed: [], skipped: [], reason: null, ledgers: 0 };
  let accounts;
  try {
    accounts = await listAccounts(env);
  } catch (error) {
    report.reason = "accounts_unreadable";
    report.error = String(error?.message ?? error);
    return report;
  }

  const wanted = [];
  const seen = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const meta = account?.meta;
    const proxyId = meta?.lastLogin?.proxyId;
    const accountId = meta?.accountId;
    const provider = meta?.provider ?? account?.provider;
    if (!proxyId || !accountProxyKey(accountId) || !provider) continue;
    report.ledgers += 1;
    let url = null;
    try {
      url = proxyUrlFor(await store?.get?.(proxyId));
    } catch {
      url = null;
    }
    if (!url) {
      // The exit was deleted from the proxy list; there is nothing honest to
      // write, so the account keeps following the provider-level proxy.
      report.skipped.push({ provider, accountId, reason: "proxy_missing" });
      continue;
    }
    const key = `${provider}${accountProxyKey(accountId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ provider, accountId, url });
  }

  if (!wanted.length) {
    report.ok = true;
    report.reason = report.ledgers ? "no_usable_exit" : "nothing_to_sync";
    return report;
  }
  const written = await writeAccountProxies({ env, entries: wanted, onlyMissing: true, file });
  return { ...written, ledgers: report.ledgers, skipped: [...report.skipped, ...written.skipped] };
}

// The flow's default: build the sync from the environment alone, so a sign-in
// driven without the HTTP service still lands in magpie. The proxy store is
// only read here, never written.
export function createAccountProxySync({ env = process.env, store, dataDir = pluginDataDir(env) } = {}) {
  let lazyStore = store ?? null;
  async function ensureStore() {
    if (!lazyStore) {
      const { createProxyStore } = await import("./proxies.mjs");
      lazyStore = createProxyStore({ dataDir });
    }
    return lazyStore;
  }
  return {
    syncSignIn: async ({ provider, accountId, proxy }) => {
      let record = proxy;
      if (record && !proxyUrlFor(record) && typeof record.id === "string" && record.id) {
        record = await (await ensureStore()).get(record.id);
      }
      return syncSignInProxy({ env, provider, accountId, proxy: record });
    },
    backfill: async () =>
      backfillAccountProxies({ env, store: await ensureStore() }),
  };
}
