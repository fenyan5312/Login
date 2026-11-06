// Account <-> browser profile <-> fingerprint pin, one to one and persistent.
//
// This is a hard invariant, not a convenience. A provider's risk control
// links the credential to the machine it signs in from. If the same
// credential is presented from several different fingerprints, it looks like
// the credential is being copied between machines and the account is likely to
// be challenged or restricted. Therefore:
//
//   * every account gets its own directory under the plugin's data directory;
//   * the profile directory and the pinned `identity.json` live inside it;
//   * `ensureIdentity` generates the pin exactly once, on first use, and from
//     then on returns the stored one byte for byte -- it never regenerates, and
//     a caller cannot make it draw a second fingerprint for the same account;
//   * the directory is removed only when the account itself is removed, so the
//     pin is born with the account and dies with it.
//
// camoufox and fpgen are imported lazily, so loading this module (and therefore
// the server) never pulls the browser stack into the process.

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fingerprintModelDir, isFingerprintModelInstalled } from "./browser-environment.mjs";
import { pluginDataDir } from "./paths.mjs";

export const IDENTITY_FILE = "identity.json";
export const PROFILE_DIR_NAME = "profile";
// Written by the sign-in flow into the pre-allocated account directory while a
// login is in flight, so the startup orphan sweep can tell a directory whose
// key has not been written yet from a directory that has been abandoned.
export const SIGNIN_FLOW_MARKER = ".signin-flow.json";

// One account = one directory. The provider and the account key are encoded
// into a single filesystem-safe segment each, so a key like `workbuddy#ab12`
// and a provider like `workbuddy-ai` cannot collide or escape the root.
export function accountDir(env = process.env, provider, key) {
  return join(pluginDataDir(env), "accounts", safeSegment(provider), safeSegment(key));
}

// The accounts root inside the plugin's data directory.
export function accountsRootDir(env = process.env) {
  return join(pluginDataDir(env), "accounts");
}

export function accountProfileDir(dir) {
  return join(dir, PROFILE_DIR_NAME);
}

export function safeSegment(value) {
  return String(value ?? "").replace(
    /[^A-Za-z0-9._-]/g,
    (character) => "%" + character.codePointAt(0).toString(16).padStart(2, "0"),
  );
}

// One character of the safe alphabet, or a run of hex digits after a `%`.
const SAFE_SEGMENT_CHAR = /^[A-Za-z0-9._-]$/;
const SEGMENT_HEX_DIGIT = /[0-9a-fA-F]/;

// Walks a segment and returns the text it encodes, or null when the segment
// was not produced by `safeSegment` (a stray unsafe character, a `%` with
// fewer than two hex digits, or no possible code point).
//
// `safeSegment` is not injective: `%23ab` is both `#ab` and `\u023a` + `b`,
// because an escape has no length prefix. The common magpie key shape makes
// the ambiguity real -- `<provider>#<base36 slot>` encodes to something like
// `workbuddy%23d6jtgo`, and reading the hex run greedily would turn `%23d6`
// into one foreign character. The inverse therefore takes the shortest escape
// whose code point is a character `safeSegment` would actually have escaped
// (an unsafe one), then parses the rest. Multi-digit escapes (non-ASCII code
// points above U+00FF) can still be read as an earlier, shorter escape; that
// is a property of the encoding, not of this parser. Callers that must decide
// whether a directory belongs to a known key compare `safeSegment(key)` to the
// raw segment (see account-prune.mjs) rather than trusting the decode.
function parseSegment(text, index) {
  if (index >= text.length) return "";
  const character = text[index];
  if (character !== "%") {
    if (!SAFE_SEGMENT_CHAR.test(character)) return null;
    const rest = parseSegment(text, index + 1);
    return rest === null ? null : character + rest;
  }
  let end = index + 1;
  while (end < text.length && SEGMENT_HEX_DIGIT.test(text[end])) end += 1;
  const run = text.slice(index + 1, end);
  if (run.length < 2) return null;
  for (let length = 2; length <= run.length; length += 1) {
    const codePoint = Number.parseInt(run.slice(0, length), 16);
    if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) continue;
    const decoded = String.fromCodePoint(codePoint);
    // The encoder never escapes a safe character, so such a parse cannot be
    // what `safeSegment` produced.
    if (SAFE_SEGMENT_CHAR.test(decoded)) continue;
    const rest = parseSegment(text, index + 1 + length);
    if (rest !== null) return decoded + rest;
  }
  return null;
}

// The inverse of `safeSegment` on its image: `decodeSegment(safeSegment(v))`
// returns `v`, except for the code points the encoding cannot tell apart (see
// `parseSegment`). Returns null for anything that is not a valid segment.
export function decodeSegment(value) {
  if (typeof value !== "string") return null;
  return parseSegment(value, 0);
}

// Every account directory on disk, as `{ provider, key, dir, keySegment }`.
// `provider` and `key` are decoded best-effort; a segment that is not a valid
// `safeSegment` is skipped. `keySegment` is the raw on-disk segment, which is
// what the orphan sweep compares against an encoded auth key. Non-directory
// entries and unreadable levels are skipped. `readdir` is injectable so tests
// never touch a real config directory.
export async function listAccountDirs(env = process.env, { readdir: readdirImpl = readdir } = {}) {
  const root = accountsRootDir(env);
  let providers;
  try {
    providers = await readdirImpl(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const providerEntry of providers) {
    if (!providerEntry.isDirectory()) continue;
    const provider = decodeSegment(providerEntry.name);
    if (provider === null) continue;
    const providerDir = join(root, providerEntry.name);
    let keys;
    try {
      keys = await readdirImpl(providerDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const keyEntry of keys) {
      if (!keyEntry.isDirectory()) continue;
      const key = decodeSegment(keyEntry.name);
      if (key === null) continue;
      found.push({
        provider,
        key,
        dir: join(providerDir, keyEntry.name),
        keySegment: keyEntry.name,
      });
    }
  }
  return found;
}

// The ownership ledger. A directory that carries one was written by a
// completed sign-in, so the account it belongs to is known even while the
// credential is absent (signed out). That is what tells a retired identity --
// keep the pin, it may sign in again as the same machine -- from a directory
// pre-allocated for a sign-in that never finished.
//
// It is written after a successful write-back, before `reconcileAccountDir`
// renames the directory onto the account's real key, so it travels with the
// directory instead of being copied.
export const ACCOUNT_META_FILE = "account.json";

// Atomic write: a temporary file in the same directory plus a rename, so a
// reader never sees a half-written ledger. Modes match `ensureIdentity`.
export async function writeAccountMeta(dir, meta) {
  if (!dir) throw new Error("writeAccountMeta: an account directory is required");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${ACCOUNT_META_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(dir, ACCOUNT_META_FILE));
}

// The ledger, or null. A missing, unreadable or malformed file is treated as
// "no ledger" and never throws: callers must not mistake a broken file for
// proof that a directory is safe to delete.
export async function readAccountMeta(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, ACCOUNT_META_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // No ledger.
  }
  return null;
}

// Every account directory paired with its ledger (or null). Built on
// `listAccountDirs` so the `safeSegment`/`decodeSegment` handling stays in one
// place. Both dependencies are injectable for tests.
export async function listAccountDirsWithMeta(
  env = process.env,
  { list = listAccountDirs, readMeta = readAccountMeta } = {},
) {
  const accounts = await list(env);
  const found = [];
  for (const account of accounts) {
    found.push({ ...account, meta: await readMeta(account.dir) });
  }
  return found;
}

// The OS name camoufox's fingerprint generator expects. Anything that is not
// Windows or macOS is presented as Linux; the generator accepts exactly those
// three names.
export function camoufoxOs(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

let camoufoxLoader = null;

function loadCamoufox() {
  camoufoxLoader ??= import("camoufox");
  return camoufoxLoader;
}

// `generateFingerprint` is exported by camoufox's fingerprints module but, in
// camoufox@0.5.9, not re-exported from the package index. Try the package
// first (what the task asked for and what a future version may export) and
// fall back to the subpath, which is reachable because the package declares no
// `exports` map.
export async function loadFingerprintGenerator() {
  const camoufox = await loadCamoufox();
  if (typeof camoufox.generateFingerprint === "function") return camoufox.generateFingerprint;
  const fingerprints = await import("camoufox/dist/fingerprints.js");
  if (typeof fingerprints.generateFingerprint === "function") return fingerprints.generateFingerprint;
  throw new Error("camoufox does not expose generateFingerprint");
}

async function defaultGenerate({ os } = {}) {
  const generateFingerprint = await loadFingerprintGenerator();
  await requireFingerprintModel();
  return generateFingerprint(os ? { os } : {});
}

let fpgenLoader = null;

function loadFpgen() {
  fpgenLoader ??= import("fpgen-js");
  return fpgenLoader;
}

// The model must be installed before a fingerprint can be drawn. fpgen-js's
// own error names internal functions; this one names the step the user missed.
// setModelDir is explicit for the same reason browser-environment sets it:
// camoufox's paths.js calls setModelDir(<INSTALL_DIR>/fpgen) at module
// evaluation, and INSTALL_DIR is fixed from LOCALAPPDATA then, so the model
// directory otherwise depends on import order. Pointing fpgen here after
// camoufox is loaded makes generation read the plugin's own copy.
// `fpgen` is injectable so tests never import the browser stack.
export async function requireFingerprintModel({
  fpgen,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  dir,
} = {}) {
  const lib = fpgen ?? (await loadFpgen());
  const modelPath = dir ? resolve(dir) : fingerprintModelDir(env, platform, home);
  lib.setModelDir(modelPath);
  if (!(await isFingerprintModelInstalled(modelPath, lib.MODEL_PIN))) {
    const tag = lib.MODEL_PIN?.tag ?? "fpgen";
    throw new Error(
      `The fingerprint model (${tag}) is not installed in ${modelPath}. ` +
        "Run the Prepare browser step on the Providers page " +
        "(POST /api/environment/prepare) before signing in; that step installs " +
        "the browser and its fingerprint model together.",
    );
  }
  return modelPath;
}

async function readStoredIdentity(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // A missing or unreadable pin is treated as "no pin"; the caller must not
    // act on a partial identity.
  }
  return null;
}

// Read-only: the account's stored pin, or null when it is missing or broken.
// Unlike `ensureIdentity`, this NEVER draws a new fingerprint. The identity
// check uses it to prove the account already has a pin before it opens a
// browser, without creating one as a side effect of looking.
export async function readIdentity(dir) {
  if (!dir) return null;
  return readStoredIdentity(join(dir, IDENTITY_FILE));
}

// Generates and stores the account's identity exactly once. On every later
// call the stored pin is returned untouched; the file is not rewritten, so its
// mtime and its bytes stay stable.
//
// `generate` is injectable so tests never import camoufox. It is first asked
// for the host OS, then, if that throws, for an OS-agnostic fingerprint -- the
// same fallback the task prescribes.
export async function ensureIdentity(dir, { generate = defaultGenerate } = {}) {
  if (!dir) throw new Error("ensureIdentity: an account directory is required");
  const file = join(dir, IDENTITY_FILE);
  const stored = await readStoredIdentity(file);
  if (stored) return { identity: stored, created: false };

  let identity;
  try {
    identity = await generate({ os: camoufoxOs() });
  } catch {
    identity = await generate({});
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("ensureIdentity: the fingerprint generator returned no identity");
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${IDENTITY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return { identity, created: true };
}

// Deletes the account's profile, pin and ledger together. Wired to the
// "clear identity" action for an account that is not signed in.
export async function removeAccountDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

// Best-effort move of a provisionally keyed account directory onto the key the
// write-back actually chose. A sign-in is pre-allocated a key before the
// account is known; when the account turns out to already exist, `writeBack`
// reuses the existing key instead. This keeps the pin beside the key the
// account really lives under. Failures are swallowed: a profile that could not
// be moved must not fail an otherwise completed sign-in.
export async function reconcileAccountDir(env, provider, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return { moved: false, removed: false };
  const from = accountDir(env, provider, fromKey);
  const to = accountDir(env, provider, toKey);
  try {
    await access(to);
    await rm(from, { recursive: true, force: true });
    return { moved: false, removed: true };
  } catch {
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return { moved: true, removed: false };
    } catch {
      return { moved: false, removed: false };
    }
  }
}
