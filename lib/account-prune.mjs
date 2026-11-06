// Startup sweep for account directories.
//
// A sign-in allocates its account directory before the user has done anything
// in the browser (see lib/signin-flow.mjs): the key is reserved and the pin is
// written, but the credential is only written back after the callback. Any
// sign-in that is abandoned -- a callback timeout, an error, a magpie reload,
// a user who never finishes -- therefore leaves a directory behind that no
// credential points at. Left alone it is never reclaimed, and it is large: an
// `identity.json` plus a whole browser profile.
//
// This module distinguishes two kinds of directory that lack a credential:
//
//   * RETIRED. The directory carries an ownership ledger (`account.json`,
//     written by a completed sign-in). The account is known; it is simply
//     signed out right now. Its directory is never removed.
//   * ORPHAN. The directory has no ledger, so it was pre-allocated for a
//     sign-in that never completed. It is reclaimed.
//
// Retired identities are kept because the core invariant is "one credential,
// one fingerprint, forever". Deleting the pin on sign-out would make the next
// sign-in for that credential look like it moved to a new machine, which is
// exactly the pattern a provider's risk control challenges. The ledger is what
// makes that safe: without it, a directory whose key is simply not in the auth
// file is indistinguishable from an abandoned pre-allocation.
//
// The sweep is deliberately conservative:
//
//   * a directory whose key is present in magpie's `plugin-auth.json` is
//     always kept, in every circumstance (the key is still signed in);
//   * a directory carrying a fresh in-flight marker is skipped, so a login
//     can never be swept out from under itself.
//
// It only ever reads the key NAMES of the auth file (through
// `lib/account-keys.mjs`'s `readAuthKeysResult`), never a credential value. If
// that read does not yield a key set -- missing file, permissions, malformed
// JSON -- the whole sweep is skipped, because without the keys every directory
// would look like an orphan. The sweep is a side path on the startup route and
// never throws: a single directory that cannot be removed is reported and the
// rest still runs.

import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readAuthKeysResult } from "./account-keys.mjs";
import {
  SIGNIN_FLOW_MARKER,
  accountsRootDir,
  listAccountDirs,
  readAccountMeta,
  safeSegment,
} from "./account-identity.mjs";
import { CALLBACK_TIMEOUT_MS } from "./signin-flow.mjs";

// Re-exported so existing callers and tests can keep importing the account
// layout helpers from this module; the implementation now lives in
// account-identity.mjs, beside `accountDir`.
export { accountsRootDir, listAccountDirs };

// The empty report, so callers can shape a response even before the first run.
// `skipped` is `null` when the sweep ran, or a short reason string (for
// example "auth_unreadable") when it bailed out before removing anything. It
// lets a caller tell "nothing was an orphan" from "we could not read the
// keys, so we touched nothing". `retired` lists the directories kept because
// they carry an ownership ledger (see the module comment).
export function emptyPruneReport() {
  return { removed: [], kept: [], retired: [], skippedLive: [], failed: [], skipped: null };
}

// A directory is "in flight" when it carries a marker younger than the
// callback timeout. A missing marker, or one older than `staleMs`, is
// reclaimable. The marker's mtime is the age source; `stat` is injectable so
// tests use a fixed clock.
async function isInFlight(dir, { stat: statImpl, now, staleMs }) {
  let info;
  try {
    info = await statImpl(join(dir, SIGNIN_FLOW_MARKER));
  } catch {
    return false;
  }
  const startedAt = Number(info?.mtimeMs);
  if (!Number.isFinite(startedAt)) return false;
  return now() - startedAt < staleMs;
}

// Walks the account directories and removes the ones with no credential and
// no ownership ledger.
//
// Dependencies are injected (`rm`, `stat`, `readKeySet`, `readKeys`, `now`,
// `readMeta`, `list`) so the sweep is testable without touching a real config
// directory and without deleting anything for real. It never throws: listing,
// reading and removing all degrade to a report entry.
//
// `readKeySet` is the result-shaped reader: it returns `{ ok: true, keys }` or
// `{ ok: false, reason }`, and `ok: false` skips the whole sweep. The older
// `readKeys` injection (a bare Set, or one that throws) is still accepted for
// existing callers and tests; it is wrapped as `{ ok: true, keys }`.
export async function pruneOrphanAccounts({
  env = process.env,
  readKeySet = () => readAuthKeysResult(env),
  readKeys = null,
  readMeta = readAccountMeta,
  rm: rmImpl = rm,
  stat: statImpl = stat,
  now = () => Date.now(),
  staleMs = CALLBACK_TIMEOUT_MS,
  log = () => {},
  list = listAccountDirs,
} = {}) {
  const report = emptyPruneReport();

  let accounts;
  try {
    accounts = await list(env);
  } catch (error) {
    log(`orphan sweep skipped: ${String(error?.message ?? error)}`);
    return report;
  }

  // Read the key set in result form. A missing/unreadable/malformed auth file
  // must skip the entire sweep: with no keys, every directory would look like
  // an orphan and be removed.
  let keyResult;
  let keyError = null;
  try {
    keyResult = readKeys ? { ok: true, keys: readKeys() } : readKeySet();
  } catch (error) {
    keyError = error;
    keyResult = { ok: false, reason: "auth_unreadable" };
  }
  if (!keyResult || keyResult.ok !== true) {
    const reason = String(keyResult?.reason || "auth_unreadable");
    report.skipped = reason;
    const detail = keyError ? `: ${String(keyError?.message ?? keyError)}` : ` (${reason})`;
    log(`orphan sweep skipped: the account key set could not be read${detail}`);
    return report;
  }
  const keys = keyResult.keys;

  // Compare encoded segments, not decoded ones: `safeSegment` is not
  // injective (an escape has no length prefix), so `safeSegment(authKey)` is
  // the one exact way to ask "is this directory's raw segment a real key?".
  const keyed = new Map();
  for (const key of keys ?? []) keyed.set(safeSegment(key), key);

  for (const account of accounts) {
    if (keyed.has(account.keySegment)) {
      report.kept.push({ provider: account.provider, key: keyed.get(account.keySegment) });
      continue;
    }

    // A ledger means the account is known and merely signed out. Never remove
    // it: the pin must outlive the credential so signing in again reuses the
    // same fingerprint instead of looking like a new machine.
    let meta = null;
    try {
      meta = await readMeta(account.dir);
    } catch {
      meta = null;
    }
    if (meta) {
      report.retired.push({
        provider: account.provider,
        key: account.key,
        accountId: meta.accountId ?? null,
        uid: meta.uid ?? null,
      });
      continue;
    }

    let live = false;
    try {
      live = await isInFlight(account.dir, { stat: statImpl, now, staleMs });
    } catch {
      live = false;
    }
    if (live) {
      report.skippedLive.push({ provider: account.provider, key: account.key });
      continue;
    }

    try {
      await rmImpl(account.dir, { recursive: true, force: true });
      report.removed.push({ provider: account.provider, key: account.key });
    } catch (error) {
      const message = String(error?.message ?? error);
      report.failed.push({ dir: account.dir, error: message });
      log(`could not reclaim ${account.dir}: ${message}`);
    }
  }

  return report;
}
