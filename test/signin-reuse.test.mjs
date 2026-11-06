// Continuing a retired identity: the flow must reuse the existing directory,
// its pinned fingerprint and its key instead of allocating a fresh one. The
// real filesystem holds the account layout; the browser, the provider plugin
// and the client are injected, so no browser is started and no network is
// touched.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_FILE,
  accountDir,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";
import { SignInFlowError, createSignInFlow } from "../lib/signin-flow.mjs";

const tempDirs = [];

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-reuse-"));
  tempDirs.push(dir);
  return { dir, env: { MAGPIE_CLEAN_LOGIN_DATA: dir } };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixedRandom = () => 0.123456789;
const fixedSuffix = (0.123456789).toString(36).slice(2, 8);

function browserMethod(callback) {
  return {
    type: "oauth",
    label: "Provider (browser)",
    authorize: async () => ({
      url: "https://provider/signin",
      instructions: "sign in",
      method: "auto",
      callback,
    }),
  };
}

function success(over = {}) {
  return {
    type: "success",
    provider: "workbuddy",
    refresh: "R",
    access: "A",
    expires: 1,
    accountId: "me",
    uid: "u-1",
    ...over,
  };
}

// A retired account directory: the pin was written by an earlier sign-in and
// the ownership ledger says which account it belongs to.
async function seedRetired(env, provider, key, { identity = { tag: "pinned" }, meta } = {}) {
  const dir = accountDir(env, provider, key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  await writeAccountMeta(dir, {
    version: 1,
    provider,
    key,
    accountId: "me",
    uid: "u-1",
    signedInAt: "2026-11-02T09:00:00.000Z",
    ...meta,
  });
  return dir;
}

async function harness({ entries = {}, callback = async () => success() } = {}) {
  const { dir, env } = await tempEnv();
  const calls = [];
  const client = {
    auth: {
      set: async (input) => {
        calls.push(input);
      },
    },
  };
  const controller = createSignInFlow({
    env,
    client,
    readKeys: () => new Set(Object.keys(entries)),
    readEntries: () => entries,
    random: fixedRandom,
    identityGenerator: async () => ({ tag: "must-not-be-called" }),
    loadProvider: async () => ({ methods: [browserMethod(callback)] }),
    launchBrowser: async () => ({ pid: 1, close: async () => {} }),
    resolveExecutable: async () => "/fake/browser",
  });
  return { dir, env, calls, controller };
}

test("a claimed identity keeps its key and its pin byte for byte", async () => {
  const { env, calls, controller } = await harness({
    // A different key already names the same account. Without forceKey the
    // write-back would settle onto it; a claim must not be moved.
    entries: { "workbuddy#other": { accountId: "me", uid: "u-1" } },
  });
  const key = "workbuddy#retired";
  const dir = await seedRetired(env, "workbuddy", key);
  const before = readFileSync(join(dir, IDENTITY_FILE), "utf8");

  const started = await controller.startSignIn({ provider: "workbuddy", account: { key } });
  // The pre-allocated key is the claimed one, not a fresh `workbuddy#…`.
  expect(started.key).toBe(key);
  expect(started.key).not.toBe("workbuddy#" + fixedSuffix);

  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("done");
  expect(flow.claimed).toBe(true);
  expect(flow.accountKey).toBe(key);
  // The pin was read, not regenerated.
  expect(flow.identityCreated).toBe(false);
  expect(readFileSync(join(dir, IDENTITY_FILE), "utf8")).toBe(before);

  // The credential was written to the claimed key, not the settle-matched one.
  expect(calls).toHaveLength(1);
  expect(calls[0].path.id).toBe(key);

  // The ledger records the successful sign-in and travels with the directory.
  // A successful sign-in also records its exit (a direct one here), so the
  // whitelisted lastLogin/loginHistory fields are part of that ledger.
  const directLogin = {
    at: expect.any(String),
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
  };
  expect(await readAccountMeta(dir)).toEqual({
    version: 1,
    provider: "workbuddy",
    key,
    accountId: "me",
    uid: "u-1",
    signedInAt: expect.any(String),
    lastLogin: directLogin,
    loginHistory: [directLogin],
  });
});

test("a claim with a key that has no ledger is refused before any browser opens", async () => {
  const { controller } = await harness();
  await expect(
    controller.startSignIn({ provider: "workbuddy", account: { key: "workbuddy#ghost" } }),
  ).rejects.toMatchObject({ code: "retired_missing", status: 400 });
  expect(controller.status()).toBeNull();
});

test("a ledger that names another provider is refused", async () => {
  const { env, controller } = await harness();
  const key = "workbuddy#foreign";
  await seedRetired(env, "workbuddy", key, {
    meta: { provider: "someone-else" },
  });
  await expect(
    controller.startSignIn({ provider: "workbuddy", account: { key } }),
  ).rejects.toMatchObject({ code: "retired_missing", status: 400 });
});

test("an account without a key is refused", async () => {
  const { controller } = await harness();
  await expect(
    controller.startSignIn({ provider: "workbuddy", account: { nope: true } }),
  ).rejects.toMatchObject({ code: "invalid_account", status: 400 });
});

test("a fresh account still allocates a new key", async () => {
  const { controller } = await harness({ entries: { workbuddy: { accountId: "someone" } } });
  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy#" + fixedSuffix);
  await controller.whenSettled();
  expect(controller.status().claimed).toBe(false);
});

test("a claimed key wins even on a single provider", async () => {
  // `single` would normally force the first slot; a claim must keep the
  // identity the user picked.
  const { env, calls, controller } = await harness({
    entries: { workbuddy: { accountId: "someone-else" } },
  });
  const key = "workbuddy#second";
  await seedRetired(env, "workbuddy", key);
  const started = await controller.startSignIn({
    provider: "workbuddy",
    account: { key },
    single: true,
  });
  expect(started.key).toBe(key);
  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  expect(calls.map((call) => call.path.id)).toEqual([key]);
});

test("the claim error is a SignInFlowError so the route can report its status", async () => {
  const { controller } = await harness();
  const error = await controller
    .startSignIn({ provider: "workbuddy", account: { key: "missing#1" } })
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(SignInFlowError);
  expect(error.status).toBe(400);
});