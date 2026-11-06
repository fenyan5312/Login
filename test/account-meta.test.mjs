// The ownership ledger (`account.json`): the file that tells a signed-out
// account from a directory that was pre-allocated for a sign-in that never
// finished. Real files in a temp directory; no real config directory is ever
// touched and the fingerprint generator is never called.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_META_FILE,
  IDENTITY_FILE,
  accountDir,
  ensureIdentity,
  listAccountDirsWithMeta,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-meta-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const meta = {
  version: 1,
  provider: "workbuddy",
  key: "workbuddy#ab12",
  accountId: "me",
  uid: "u-1",
  signedInAt: "2026-11-03T10:00:00.000Z",
};

test("the ledger round-trips through write and read", async () => {
  const dir = await tempDir();
  await writeAccountMeta(dir, meta);
  expect(await readAccountMeta(dir)).toEqual(meta);
});

test("the ledger is written next to the pin, never over it", async () => {
  const dir = await tempDir();
  await ensureIdentity(dir, { generate: async () => ({ tag: "pinned" }) });
  const identityBefore = await readFile(join(dir, IDENTITY_FILE), "utf8");
  await writeAccountMeta(dir, meta);
  // The fingerprint is untouched: the ledger is a sibling of the pin.
  expect(await readFile(join(dir, IDENTITY_FILE), "utf8")).toBe(identityBefore);
  expect((await readdir(dir)).sort()).toEqual([ACCOUNT_META_FILE, IDENTITY_FILE]);
});

test("a missing ledger reads as null instead of throwing", async () => {
  const dir = await tempDir();
  expect(await readAccountMeta(dir)).toBeNull();
  expect(await readAccountMeta(join(dir, "does-not-exist"))).toBeNull();
});

test("a malformed ledger reads as null instead of throwing", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, ACCOUNT_META_FILE), "{ not json");
  expect(await readAccountMeta(dir)).toBeNull();
  // A JSON value that is not an object is not a ledger either.
  await writeFile(join(dir, ACCOUNT_META_FILE), "[1, 2, 3]");
  expect(await readAccountMeta(dir)).toBeNull();
  await writeFile(join(dir, ACCOUNT_META_FILE), "null");
  expect(await readAccountMeta(dir)).toBeNull();
});

test("the write is atomic: no temporary file is left behind", async () => {
  const dir = await tempDir();
  await writeAccountMeta(dir, meta);
  const files = await readdir(dir);
  expect(files).toEqual([ACCOUNT_META_FILE]);
  // A second write replaces the file in place and still leaves nothing behind.
  await writeAccountMeta(dir, { ...meta, accountId: "other" });
  expect(await readdir(dir)).toEqual([ACCOUNT_META_FILE]);
  expect((await readAccountMeta(dir)).accountId).toBe("other");
});

test("the ledger is written into a directory that does not exist yet", async () => {
  const dir = join(await tempDir(), "account");
  await writeAccountMeta(dir, meta);
  expect(await readAccountMeta(dir)).toEqual(meta);
});

test("listAccountDirsWithMeta pairs every directory with its ledger", async () => {
  const env = { MAGPIE_CLEAN_LOGIN_DATA: await tempDir() };
  const withLedger = accountDir(env, "workbuddy", "workbuddy#ab12");
  const withoutLedger = accountDir(env, "workbuddy", "workbuddy");
  await writeAccountMeta(withLedger, meta);
  await writeFile(join(withoutLedger, ".keep"), "").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(withoutLedger, { recursive: true });
    await writeFile(join(withoutLedger, ".keep"), "");
  });

  const found = await listAccountDirsWithMeta(env);
  expect(found.map((entry) => [entry.provider, entry.key]).sort()).toEqual([
    ["workbuddy", "workbuddy"],
    ["workbuddy", "workbuddy#ab12"],
  ]);
  const ledger = found.find((entry) => entry.key === "workbuddy#ab12");
  expect(ledger.meta).toEqual(meta);
  expect(ledger.dir).toBe(withLedger);
  const none = found.find((entry) => entry.key === "workbuddy");
  expect(none.meta).toBeNull();
});
