// A browser-free smoke test for the account identity routes.
//
// It starts the real service on a temporary data directory with a fake
// magpie auth file, then exercises the two routes the page uses:
//
//   GET    /api/accounts                  -> the known identities
//   DELETE /api/accounts/<provider>/<key> -> clears a signed-out identity
//
// Nothing of the real installation is touched: the data directory and the
// magpie config directory both live in a temporary root, and the temporary
// root is removed again at the end.
//
//   node scripts/smoke-accounts.mjs

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, TOKEN_HEADER } from "../lib/server.mjs";
import { accountDir, writeAccountMeta } from "../lib/account-identity.mjs";

const root = await mkdtemp(join(tmpdir(), "clean-login-smoke-"));
const dataDir = join(root, "data");
const configDir = join(root, "magpie-config");
await mkdir(dataDir, { recursive: true });
await mkdir(configDir, { recursive: true });

// The fake magpie auth file: one account is signed in, the other one is not.
await writeFile(
  join(configDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: { type: "oauth", access: "SECRET", refresh: "SECRET", accountId: "signed-in", uid: "u-1" },
  }),
);

// Two account directories with their ledgers: one still signed in, one retired.
await writeAccountMeta(accountDir({ MAGPIE_CLEAN_LOGIN_DATA: dataDir }, "workbuddy", "workbuddy"), {
  version: 1,
  provider: "workbuddy",
  key: "workbuddy",
  accountId: "signed-in",
  uid: "u-1",
  signedInAt: "2026-11-03T10:00:00.000Z",
});
await writeAccountMeta(accountDir({ MAGPIE_CLEAN_LOGIN_DATA: dataDir }, "workbuddy", "workbuddy#ab12"), {
  version: 1,
  provider: "workbuddy",
  key: "workbuddy#ab12",
  accountId: "retired",
  uid: "u-2",
  signedInAt: "2026-11-02T09:00:00.000Z",
});

const service = await startServer({
  port: 0,
  env: {
    ...process.env,
    MAGPIE_CONFIG_DIR: configDir,
    MAGPIE_CLEAN_LOGIN_DATA: dataDir,
  },
  dataDir,
  pluginScanner: {
    get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
    warm: () => {},
  },
  // A fake client: the service never signs in during this smoke test, but the
  // server asks for one when it builds the flow controller.
  client: { auth: { set: async () => {} } },
});

try {
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  const token = /content="([0-9a-f]{64})"/.exec(html)?.[1];

  const call = async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };

  console.log("=== GET /api/accounts ===");
  const list = await call("GET", "/api/accounts");
  console.log(`status: ${list.status}`);
  console.log(JSON.stringify(list.body, null, 2));

  console.log("\n=== DELETE /api/accounts/workbuddy/workbuddy (still signed in) ===");
  const signedIn = await call("DELETE", "/api/accounts/workbuddy/workbuddy");
  console.log(`status: ${signedIn.status}`);
  console.log(JSON.stringify(signedIn.body, null, 2));

  console.log("\n=== DELETE /api/accounts/workbuddy/workbuddy%23ab12 (signed out) ===");
  const retired = await call("DELETE", "/api/accounts/workbuddy/workbuddy%23ab12");
  console.log(`status: ${retired.status}`);
  console.log(JSON.stringify(retired.body, null, 2));

  console.log("\n=== GET /api/accounts (after the delete) ===");
  const after = await call("GET", "/api/accounts");
  console.log(`status: ${after.status}`);
  console.log(JSON.stringify(after.body, null, 2));
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
