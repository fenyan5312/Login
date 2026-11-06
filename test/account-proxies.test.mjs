// Unit tests for synchronizing magpie's `accountProxies` with clean-login exits.
// Driven through isolated temp roots; never touches ~/.config/magpie.

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProxyKey,
  backfillAccountProxies,
  createAccountProxySync,
  providersFile,
  proxyUrlFor,
  syncSignInProxy,
  writeAccountProxies,
} from "../lib/account-proxies.mjs";
import { writeAccountMeta } from "../lib/account-identity.mjs";
import { createProxyStore } from "../lib/proxies.mjs";

const tempDirs = [];

async function tempDir(prefix = "clean-login-proxies-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function seedProvidersJson(dir, providers = []) {
  const file = join(dir, "providers.json");
  const payload = {
    providers: [
      {
        id: "minimax-code",
        name: "",
        key: "",
        proxy: "http://127.0.0.1:17801",
        models: ["MiniMax-M3"],
      },
      {
        id: "workbuddy",
        name: "",
        proxy: "",
        accountProxies: {
          "user-hand": "http://127.0.0.1:9999",
        },
      },
      ...providers,
    ],
    groups: [],
  };
  return writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readProviders(dir) {
  return JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"));
}

test("accountProxyKey computes lower-cased user name, handles trimming and blanks", () => {
  expect(accountProxyKey("UserOne")).toBe("userone");
  expect(accountProxyKey("  User_Two  ")).toBe("user_two");
  expect(accountProxyKey("already_lower")).toBe("already_lower");
  expect(accountProxyKey("")).toBe("");
  expect(accountProxyKey(null)).toBe("");
  expect(accountProxyKey(undefined)).toBe("");
});

test("proxyUrlFor formats http, https, socks5 with credentials and handles IPv6", () => {
  expect(proxyUrlFor({ host: "127.0.0.1", port: 17803, type: "http" })).toBe(
    "http://127.0.0.1:17803",
  );
  expect(
    proxyUrlFor({
      host: "exit.proxy.test",
      port: 8443,
      type: "https",
      username: "user name",
      password: "p@ss:word",
    }),
  ).toBe("https://user%20name:p%40ss%3Aword@exit.proxy.test:8443");
  expect(proxyUrlFor({ host: "127.0.0.1", port: 1080, type: "socks5" })).toBe(
    "socks5://127.0.0.1:1080",
  );
  expect(proxyUrlFor({ host: "::1", port: 17802 })).toBe("http://[::1]:17802");
  expect(proxyUrlFor({ host: "[::1]", port: 17802 })).toBe("http://[::1]:17802");
  expect(proxyUrlFor({ url: "socks5://10.0.0.1:1080" })).toBe("socks5://10.0.0.1:1080");

  // Invalid inputs return null
  expect(proxyUrlFor(null)).toBeNull();
  expect(proxyUrlFor({})).toBeNull();
  expect(proxyUrlFor({ host: "127.0.0.1", port: 0 })).toBeNull();
  expect(proxyUrlFor({ host: "127.0.0.1", port: 70000 })).toBeNull();
  expect(proxyUrlFor({ host: "", port: 17801 })).toBeNull();
  expect(proxyUrlFor({ host: "127.0.0.1", port: 17801, type: "ftp" })).toBeNull();
});

test("writeAccountProxies reports missing or invalid providers.json without throwing", async () => {
  const cfg = await tempDir();
  const env = { MAGPIE_CONFIG_DIR: cfg };

  const missing = await writeAccountProxies({
    env,
    entries: [{ provider: "minimax-code", accountId: "u1", url: "http://127.0.0.1:17801" }],
  });
  expect(missing.ok).toBeFalse();
  expect(missing.reason).toBe("providers_missing");

  await writeFile(join(cfg, "providers.json"), "NOT JSON");
  const invalid = await writeAccountProxies({
    env,
    entries: [{ provider: "minimax-code", accountId: "u1", url: "http://127.0.0.1:17801" }],
  });
  expect(invalid.ok).toBeFalse();
  expect(invalid.reason).toBe("providers_invalid");
});

test("syncSignInProxy writes account's own entry, preserving other accounts", async () => {
  const cfg = await tempDir();
  await seedProvidersJson(cfg);
  const env = { MAGPIE_CONFIG_DIR: cfg };

  const res1 = await syncSignInProxy({
    env,
    provider: "minimax-code",
    accountId: "AlphaUser",
    proxy: { host: "127.0.0.1", port: 17803, type: "http" },
  });
  expect(res1.ok).toBeTrue();
  expect(res1.changed.length).toBe(1);

  const res2 = await syncSignInProxy({
    env,
    provider: "minimax-code",
    accountId: "BetaUser",
    proxy: { host: "127.0.0.1", port: 17802, type: "http" },
  });
  expect(res2.ok).toBeTrue();

  const doc = readProviders(cfg);
  const mm = doc.providers.find((p) => p.id === "minimax-code");
  expect(mm.accountProxies).toEqual({
    alphauser: "http://127.0.0.1:17803",
    betauser: "http://127.0.0.1:17802",
  });
  // Provider-wide proxy is untouched
  expect(mm.proxy).toBe("http://127.0.0.1:17801");
  // Other provider's accounts are untouched
  const wb = doc.providers.find((p) => p.id === "workbuddy");
  expect(wb.accountProxies["user-hand"]).toBe("http://127.0.0.1:9999");
});

test("syncSignInProxy with direct login (no proxy) leaves providers.json untouched", async () => {
  const cfg = await tempDir();
  await seedProvidersJson(cfg);
  const env = { MAGPIE_CONFIG_DIR: cfg };

  const res = await syncSignInProxy({
    env,
    provider: "minimax-code",
    accountId: "DirectUser",
    proxy: null,
  });
  expect(res.ok).toBeTrue();
  expect(res.reason).toBe("no_proxy");

  const doc = readProviders(cfg);
  const mm = doc.providers.find((p) => p.id === "minimax-code");
  expect(mm.accountProxies).toBeUndefined();
});

test("backfillAccountProxies populates absent keys and never overwrites hand-set entries", async () => {
  const root = await tempDir();
  const cfg = join(root, "config");
  const data = join(root, "data");
  await mkdir(cfg, { recursive: true });
  await mkdir(data, { recursive: true });
  await seedProvidersJson(cfg);

  // Pre-seed an existing account proxy in minimax-code to prove backfill
  // leaves it alone (the user hand-configured it in magpie).
  const initial = readProviders(cfg);
  initial.providers.find((p) => p.id === "minimax-code").accountProxies = {
    alreadythere: "http://127.0.0.1:1111",
  };
  await writeFile(join(cfg, "providers.json"), JSON.stringify(initial, null, 2));

  const env = {
    MAGPIE_CONFIG_DIR: cfg,
    MAGPIE_CLEAN_LOGIN_DATA: data,
  };

  // Create proxy store with two exits
  const store = createProxyStore({ dataDir: data });
  const p1 = await store.create({
    name: "R2-5",
    type: "http",
    host: "127.0.0.1",
    port: 17803,
    username: "",
    password: "",
  });
  const p2 = await store.create({
    name: "D1-3",
    type: "http",
    host: "127.0.0.1",
    port: 17802,
    username: "",
    password: "",
  });

  // Seed two account ledgers with lastLogin pointing at the proxies
  const dir1 = join(data, "accounts", "minimax-code", "slot1");
  await mkdir(dir1, { recursive: true });
  await writeAccountMeta(dir1, {
    version: 1,
    provider: "minimax-code",
    key: "slot1",
    accountId: "AlphaUser",
    lastLogin: { proxyId: p1.id, proxyName: "R2-5", type: "http" },
  });

  const dir2 = join(data, "accounts", "minimax-code", "slot2");
  await mkdir(dir2, { recursive: true });
  await writeAccountMeta(dir2, {
    version: 1,
    provider: "minimax-code",
    key: "slot2",
    accountId: "BetaUser",
    lastLogin: { proxyId: p2.id, proxyName: "D1-3", type: "http" },
  });

  // An account trying to backfill onto the already-set key: must be skipped
  const dir3 = join(data, "accounts", "minimax-code", "slot3");
  await mkdir(dir3, { recursive: true });
  await writeAccountMeta(dir3, {
    version: 1,
    provider: "minimax-code",
    key: "slot3",
    accountId: "AlreadyThere",
    lastLogin: { proxyId: p1.id, proxyName: "R2-5", type: "http" },
  });

  const report = await backfillAccountProxies({ env, store });
  expect(report.ok).toBeTrue();
  expect(report.changed.length).toBe(2);
  expect(report.skipped.some((s) => s.reason === "already_set")).toBeTrue();

  const doc = readProviders(cfg);
  const mm = doc.providers.find((p) => p.id === "minimax-code");
  expect(mm.accountProxies).toEqual({
    alreadythere: "http://127.0.0.1:1111",
    alphauser: "http://127.0.0.1:17803",
    betauser: "http://127.0.0.1:17802",
  });

  // Second run: everything is already up to date, 0 writes
  const report2 = await backfillAccountProxies({ env, store });
  expect(report2.ok).toBeTrue();
  expect(report2.changed.length).toBe(0);
  expect(report2.reason).toBe("up_to_date");
});

test("writeAccountProxies ignores prototype keys and reserved names", async () => {
  const cfg = await tempDir();
  await seedProvidersJson(cfg);
  const env = { MAGPIE_CONFIG_DIR: cfg };

  const res = await writeAccountProxies({
    env,
    entries: [
      { provider: "minimax-code", accountId: "__proto__", url: "http://127.0.0.1:6666" },
      { provider: "minimax-code", accountId: "constructor", url: "http://127.0.0.1:6666" },
    ],
  });
  expect(res.ok).toBeTrue();
  expect(res.reason).toBe("nothing_to_sync");

  const doc = readProviders(cfg);
  const mm = doc.providers.find((p) => p.id === "minimax-code");
  expect(mm.accountProxies).toBeUndefined();
});

test("createAccountProxySync lazily resolves proxy store when given only an id", async () => {
  const root = await tempDir();
  const cfg = join(root, "config");
  const data = join(root, "data");
  await mkdir(cfg, { recursive: true });
  await mkdir(data, { recursive: true });
  await seedProvidersJson(cfg);

  const store = createProxyStore({ dataDir: data });
  const created = await store.create({
    name: "Exit",
    type: "http",
    host: "127.0.0.1",
    port: 17805,
    username: "",
    password: "",
  });

  const env = {
    MAGPIE_CONFIG_DIR: cfg,
    MAGPIE_CLEAN_LOGIN_DATA: data,
  };

  const sync = createAccountProxySync({ env, store, dataDir: data });
  // Pass an object with only { id } to verify store lookup happens
  const res = await sync.syncSignIn({
    provider: "minimax-code",
    accountId: "LazyUser",
    proxy: { id: created.id },
  });
  expect(res.ok).toBeTrue();

  const doc = readProviders(cfg);
  const mm = doc.providers.find((p) => p.id === "minimax-code");
  expect(mm.accountProxies.lazyuser).toBe("http://127.0.0.1:17805");
});
