// The startup orphan sweep, driven through injected dependencies: a temp data
// directory holds the account layout, a fake `rm` records what would be
// deleted and a fake `stat`/`now` control the in-flight marker's age. No real
// config directory is ever touched.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNIN_FLOW_MARKER, accountDir, safeSegment } from "../lib/account-identity.mjs";
import { readAuthKeysResult } from "../lib/account-keys.mjs";
import {
  accountsRootDir,
  listAccountDirs,
  pruneOrphanAccounts,
} from "../lib/account-prune.mjs";
const tempDirs = [];

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-prune-"));
  tempDirs.push(dir);
  return { dir, env: { MAGPIE_CLEAN_LOGIN_DATA: dir } };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function account(env, provider, key) {
  const dir = accountDir(env, provider, key);
  await mkdir(dir, { recursive: true });
  return dir;
}

// An account directory with its ownership ledger: the account is known and
// merely signed out, so its pin must survive the sweep.
async function retiredAccount(env, provider, key, meta = {}) {
  const dir = await account(env, provider, key);
  await writeFile(
    join(dir, "account.json"),
    JSON.stringify({
      version: 1,
      provider,
      key,
      accountId: "me",
      uid: "u-1",
      signedInAt: "2026-11-03T10:00:00.000Z",
      ...meta,
    }),
  );
  return dir;
}

// A fully real environment: an on-disk data directory (for the account layout)
// and an on-disk magpie config directory (for plugin-auth.json). Both live
// under one temporary root, so the real `readAuthKeysResult` and the real `rm`
// are exercised and `~/.config/magpie` is never touched.
async function realEnv() {
  const root = await mkdtemp(join(tmpdir(), "clean-login-prune-real-"));
  tempDirs.push(root);
  const data = join(root, "data");
  const config = join(root, "config");
  await mkdir(data, { recursive: true });
  await mkdir(config, { recursive: true });
  return {
    root,
    config,
    env: { MAGPIE_CONFIG_DIR: config, MAGPIE_CLEAN_LOGIN_DATA: data },
  };
}

const noMarker = async () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

test("listAccountDirs decodes the account layout and skips junk", async () => {
  const { env } = await tempEnv();
  await account(env, "workbuddy", "workbuddy#ab12");
  await account(env, "workbuddy-ai", "workbuddy-ai");
  // A file at the provider level is not a directory.
  await writeFile(join(accountsRootDir(env), "notes.txt"), "x");
  // A provider segment the encoder could not have produced.
  await mkdir(join(accountsRootDir(env), "bad%zz"), { recursive: true });
  // A file and a bad key segment inside a real provider.
  await mkdir(join(accountsRootDir(env), "workbuddy"), { recursive: true });
  await writeFile(join(accountsRootDir(env), "workbuddy", "not-a-dir"), "x");
  await mkdir(join(accountsRootDir(env), "workbuddy", "%zz"), { recursive: true });

  const found = await listAccountDirs(env);
  expect(found.map((entry) => [entry.provider, entry.key]).sort()).toEqual([
    ["workbuddy", "workbuddy#ab12"],
    ["workbuddy-ai", "workbuddy-ai"],
  ]);
  expect(found.map((entry) => entry.keySegment).sort()).toEqual([
    safeSegment("workbuddy#ab12"),
    "workbuddy-ai",
  ]);
});

test("listAccountDirs on a missing root is empty and does not throw", async () => {
  const { env } = await tempEnv();
  expect(await listAccountDirs(env)).toEqual([]);
});

test("a directory whose key is in plugin-auth.json is kept and rm is never called", async () => {
  const { env } = await tempEnv();
  await account(env, "workbuddy", "workbuddy");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(["workbuddy"]),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 1_000,
    staleMs: 100,
  });
  expect(report.kept).toEqual([{ provider: "workbuddy", key: "workbuddy" }]);
  expect(report.removed).toEqual([]);
  expect(removed).toEqual([]);
});

test("a directory with no credential is removed", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(["workbuddy"]),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 1_000,
    staleMs: 100,
  });
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#orphan" }]);
  expect(report.kept).toEqual([]);
  expect(removed).toEqual([dir]);
});

test("a fresh in-flight marker is skipped", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#inflight");
  await writeFile(join(dir, SIGNIN_FLOW_MARKER), JSON.stringify({ flowId: "f" }));
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: async () => ({ mtimeMs: 1_000 }),
    now: () => 1_050,
    staleMs: 100,
  });
  expect(report.skippedLive).toEqual([{ provider: "workbuddy", key: "workbuddy#inflight" }]);
  expect(report.removed).toEqual([]);
  expect(removed).toEqual([]);
});

test("a stale in-flight marker is reclaimed", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#stale");
  await writeFile(join(dir, SIGNIN_FLOW_MARKER), JSON.stringify({ flowId: "f" }));
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: async () => ({ mtimeMs: 1_000 }),
    now: () => 1_200,
    staleMs: 100,
  });
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#stale" }]);
  expect(report.skippedLive).toEqual([]);
  expect(removed).toEqual([dir]);
});

test("a removal failure is reported and the rest of the sweep continues", async () => {
  const { env } = await tempEnv();
  const locked = await account(env, "workbuddy", "workbuddy#locked");
  const gone = await account(env, "workbuddy", "workbuddy#gone");
  const attempts = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => {
      attempts.push(target);
      if (target === locked) throw new Error("EBUSY: resource busy or locked");
    },
    stat: noMarker,
    now: () => 0,
    staleMs: 100,
  });
  expect(attempts.sort()).toEqual([gone, locked].sort());
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0].dir).toBe(locked);
  expect(report.failed[0].error).toContain("EBUSY");
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#gone" }]);
});

test("a missing accounts root yields an empty report and never throws", async () => {
  const { env } = await tempEnv();
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(["x"]),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 0,
    staleMs: 1,
  });
  expect(report).toEqual({
    removed: [],
    kept: [],
    retired: [],
    skippedLive: [],
    failed: [],
    skipped: null,
  });
  expect(removed).toEqual([]);
});

test("files and undecodable segment names are ignored", async () => {
  const { env } = await tempEnv();
  const root = accountsRootDir(env);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "notes.txt"), "x");
  await mkdir(join(root, "bad%zz"), { recursive: true });
  await mkdir(join(root, "workbuddy", "%zz"), { recursive: true });
  await writeFile(join(root, "workbuddy", "not-a-dir"), "x");

  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 0,
    staleMs: 1,
  });
  expect(report).toEqual({
    removed: [],
    kept: [],
    retired: [],
    skippedLive: [],
    failed: [],
    skipped: null,
  });
  expect(removed).toEqual([]);
});

test("a key set that cannot be read leaves every directory alone", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  const removed = [];
  const logs = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => {
      throw new Error("auth file offline");
    },
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 0,
    staleMs: 1,
    log: (message) => logs.push(message),
  });
  expect(report).toEqual({
    removed: [],
    kept: [],
    retired: [],
    skippedLive: [],
    failed: [],
    skipped: "auth_unreadable",
  });
  expect(removed).toEqual([]);
  expect(dir).toBe(accountDir(env, "workbuddy", "workbuddy#orphan"));
  expect(logs.join(" ")).toContain("key set could not be read");
});

// --- Retired identities ----------------------------------------------------
//
// A directory that carries an ownership ledger belongs to a known account
// that is signed out. Its pin must survive: the same credential has to keep
// presenting the same machine. Only a directory without a ledger is an
// orphan and gets reclaimed.

test("a directory with a ledger is retired, never removed", async () => {
  const { env } = await tempEnv();
  const dir = await retiredAccount(env, "workbuddy", "workbuddy#retired");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 1_000,
    staleMs: 100,
  });
  expect(report.retired).toEqual([
    { provider: "workbuddy", key: "workbuddy#retired", accountId: "me", uid: "u-1" },
  ]);
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([]);
  expect(removed).toEqual([]);
  // The pin is still on disk: this is the whole point of the ledger.
  await expect(stat(dir)).resolves.toBeTruthy();
});

test("a directory without a ledger is still removed", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 1_000,
    staleMs: 100,
  });
  expect(report.retired).toEqual([]);
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#orphan" }]);
  expect(removed).toEqual([dir]);
});

test("a fresh in-flight marker on a ledgerless directory is skipped", async () => {
  const { env } = await tempEnv();
  const dir = await account(env, "workbuddy", "workbuddy#inflight");
  await writeFile(join(dir, SIGNIN_FLOW_MARKER), JSON.stringify({ flowId: "f" }));
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(),
    rm: async (target) => removed.push(target),
    stat: async () => ({ mtimeMs: 1_000 }),
    now: () => 1_050,
    staleMs: 100,
  });
  expect(report.skippedLive).toEqual([{ provider: "workbuddy", key: "workbuddy#inflight" }]);
  expect(report.retired).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(removed).toEqual([]);
});

test("a key that is still in the auth file is kept even with a ledger", async () => {
  const { env } = await tempEnv();
  await retiredAccount(env, "workbuddy", "workbuddy");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => new Set(["workbuddy"]),
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 1_000,
    staleMs: 100,
  });
  // Still signed in: it is kept, not retired, and never removed.
  expect(report.kept).toEqual([{ provider: "workbuddy", key: "workbuddy" }]);
  expect(report.retired).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(removed).toEqual([]);
});

test("an unreadable auth file leaves a retired identity alone too", async () => {
  const { env } = await tempEnv();
  const dir = await retiredAccount(env, "workbuddy", "workbuddy#retired");
  const removed = [];
  const report = await pruneOrphanAccounts({
    env,
    readKeys: () => {
      throw new Error("auth file offline");
    },
    rm: async (target) => removed.push(target),
    stat: noMarker,
    now: () => 0,
    staleMs: 1,
  });
  expect(report.skipped).toBe("auth_unreadable");
  expect(report.retired).toEqual([]);
  expect(report.removed).toEqual([]);
  expect(removed).toEqual([]);
  await expect(stat(dir)).resolves.toBeTruthy();
});

// --- Real filesystem, real readAuthKeysResult, real rm ---------------------
// These do NOT inject a fake `readKeys`: the key set is read from a temporary
// `plugin-auth.json` and the orphan directories are removed (or not) for real.

test("a missing plugin-auth.json leaves a real orphan on disk untouched", async () => {
  const { env } = await realEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");

  const result = readAuthKeysResult(env);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("auth_missing");

  const report = await pruneOrphanAccounts({ env, stat: noMarker, now: () => 0, staleMs: 1 });
  expect(report.removed).toEqual([]);
  expect(report.kept).toEqual([]);
  expect(report.skipped).toBe("auth_missing");
  // The pin is still there: this is the whole point of the fix.
  await expect(stat(dir)).resolves.toBeTruthy();
});

test("a corrupt plugin-auth.json leaves a real orphan on disk untouched", async () => {
  const { env, config } = await realEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  await writeFile(join(config, "plugin-auth.json"), "not json");

  const result = readAuthKeysResult(env);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("auth_invalid");

  const report = await pruneOrphanAccounts({ env, stat: noMarker, now: () => 0, staleMs: 1 });
  expect(report.removed).toEqual([]);
  expect(report.skipped).toBe("auth_invalid");
  await expect(stat(dir)).resolves.toBeTruthy();
});

test("a legitimate empty plugin-auth.json object still reclaims the orphan", async () => {
  const { env, config } = await realEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  await writeFile(join(config, "plugin-auth.json"), "{}");

  const result = readAuthKeysResult(env);
  expect(result.ok).toBe(true);
  expect(result.keys.size).toBe(0);

  const report = await pruneOrphanAccounts({ env, stat: noMarker, now: () => 0, staleMs: 1 });
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#orphan" }]);
  expect(report.skipped).toBeNull();
  await expect(stat(dir)).rejects.toBeTruthy();
});

test("a real key set keeps the keyed directory and removes only the orphan", async () => {
  const { env, config } = await realEnv();
  const kept = await account(env, "workbuddy", "workbuddy");
  const orphan = await account(env, "workbuddy", "workbuddy#orphan");
  await writeFile(
    join(config, "plugin-auth.json"),
    JSON.stringify({ workbuddy: { token: "secret" } }),
  );

  const report = await pruneOrphanAccounts({ env, stat: noMarker, now: () => 0, staleMs: 1 });
  expect(report.kept).toEqual([{ provider: "workbuddy", key: "workbuddy" }]);
  expect(report.removed).toEqual([{ provider: "workbuddy", key: "workbuddy#orphan" }]);
  expect(report.skipped).toBeNull();
  await expect(stat(kept)).resolves.toBeTruthy();
  await expect(stat(orphan)).rejects.toBeTruthy();
});

test("the real startup sweep leaves directories alone when auth is unreadable", async () => {
  const { env } = await realEnv();
  const dir = await account(env, "workbuddy", "workbuddy#orphan");
  const { startServer } = await import("../lib/server.mjs");
  const service = await startServer({
    port: 0,
    dataDir: env.MAGPIE_CLEAN_LOGIN_DATA,
    env,
    pluginScanner: {
      get: () => ({
        available: false,
        providers: [],
        scanned: false,
        stale: false,
        scanning: false,
        error: null,
      }),
      warm: () => {},
    },
  });
  try {
    // Wait for the fire-and-forget startup sweep instead of racing it.
    await service.prune();
    await expect(stat(dir)).resolves.toBeTruthy();
  } finally {
    await service.close();
  }
});
