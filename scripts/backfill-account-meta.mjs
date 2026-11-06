// Backfill the ownership ledger (`account.json`) for account directories that
// were created before the ledger existed.
//
// The ledger is what tells a signed-out account ("retired": keep the pinned
// fingerprint, it may sign in again) from a directory that was pre-allocated
// for a sign-in that never finished ("orphan": reclaim it). Accounts signed
// in before this feature landed have a directory but no ledger, so the startup
// sweep cannot tell the two apart and would delete their fingerprint.
//
// This script never touches `identity.json`, never deletes a directory and
// never writes a credential. It reads the account key names and the
// non-credential fields (`accountId`, `uid`) of magpie's `plugin-auth.json`
// through the plugin's own reader, and writes a ledger for every directory
// that lacks one.
//
// Default is a dry run: it prints what it would write and changes nothing.
// `--apply` performs the writes.
//
//   node scripts/backfill-account-meta.mjs [--apply]
//
// The auth file and the account directory are read from the same environment
// the service uses: `MAGPIE_CONFIG_DIR` (or `XDG_CONFIG_HOME`, or
// `~/.config/magpie`) and `MAGPIE_CLEAN_LOGIN_DATA`.

import { join } from "node:path";
import {
  ACCOUNT_META_FILE,
  accountDir,
  listAccountDirs,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";
import { magpieConfigDir, pluginDataDir } from "../lib/paths.mjs";
import { readAuthEntries } from "../lib/signin-writeback.mjs";

// The account's own name, taken from the auth entry's `accountId` and then
// its `uid`. Both are non-credential fields the plugin's reader already
// narrows down to.
function identityOf(entry) {
  const accountId = typeof entry?.accountId === "string" ? entry.accountId : null;
  const uid = typeof entry?.uid === "string" ? entry.uid : null;
  return { accountId, uid };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const env = process.env;
  const configDir = magpieConfigDir(env);
  const dataDir = pluginDataDir(env);
  const authFile = join(configDir, "plugin-auth.json");

  console.log(`auth file : ${authFile}`);
  console.log(`data dir  : ${dataDir}`);
  console.log(`mode      : ${apply ? "apply" : "dry run (nothing is written)"}`);

  let entries = {};
  try {
    entries = readAuthEntries(env);
  } catch {
    entries = {};
  }
  const keys = Object.keys(entries);
  console.log(`auth keys : ${keys.length}`);

  const dirs = await listAccountDirs(env);
  let written = 0;
  let skipped = 0;
  let unknown = 0;
  for (const account of dirs) {
    const dir = accountDir(env, account.provider, account.key);
    const existing = await readAccountMeta(dir);
    if (existing) {
      skipped += 1;
      console.log(`- keep    ${account.provider} / ${account.key} (ledger already present)`);
      continue;
    }
    const entry = entries[account.key];
    if (!entry) {
      // No auth key means the directory cannot be attributed to an account.
      // Writing a ledger for it would turn a possibly abandoned
      // pre-allocation into an identity that must never be reclaimed, so it
      // is left alone for the orphan sweep (and for a human) to decide.
      unknown += 1;
      console.log(
        `- skip    ${account.provider} / ${account.key} (not in plugin-auth.json) · ${ACCOUNT_META_FILE} not written`,
      );
      continue;
    }
    const identity = identityOf(entry);
    const meta = {
      version: 1,
      provider: account.provider,
      key: account.key,
      accountId: identity.accountId,
      uid: identity.uid,
      // Unknown: the auth file does not record when the account signed in.
      signedInAt: null,
    };
    console.log(
      `${apply ? "+ write  " : "+ would write"} ${account.provider} / ${account.key}` +
        ` · accountId=${meta.accountId ?? "-"} · uid=${meta.uid ?? "-"}`,
    );
    if (apply) await writeAccountMeta(dir, meta);
    written += 1;
  }

  console.log(
    `${apply ? "written" : "would write"}: ${written} · already present: ${skipped} · ` +
      `unknown: ${unknown} · directories: ${dirs.length}`,
  );
  if (!apply) {
    console.log("Nothing was written. Run again with --apply to write the ledgers.");
  }
}

// The script is a one-off maintenance tool; a failure must be visible.
main().catch((error) => {
  console.error(`backfill failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
