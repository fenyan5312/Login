// The cross-account guard. A directory that already carries a ledger belongs
// to a known identity; if a sign-in started for it comes back as a different
// account, nothing is written. Reusing a key must never put one account's
// credential under another account's pinned fingerprint.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_FILE,
  SIGNIN_FLOW_MARKER,
  accountDir,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";
import { createSignInFlow } from "../lib/signin-flow.mjs";

const tempDirs = [];

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-collision-"));
  tempDirs.push(dir);
  return { dir, env: { MAGPIE_CLEAN_LOGIN_DATA: dir } };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function seedDir(env, provider, key, { meta } = {}) {
  const dir = accountDir(env, provider, key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, IDENTITY_FILE), `${JSON.stringify({ tag: "pinned" }, null, 2)}\n`);
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

async function harness({ entries = {}, callback }) {
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
    identityGenerator: async () => ({ tag: "must-not-be-called" }),
    loadProvider: async () => ({ methods: [browserMethod(callback)] }),
    launchBrowser: async () => ({ pid: 1, close: async () => {} }),
    resolveExecutable: async () => "/fake/browser",
  });
  return { dir, env, calls, controller };
}

test("a claimed identity that comes back as a different uid is not written", async () => {
  const key = "workbuddy#retired";
  const { env, calls, controller } = await harness({
    // The callback says it is another account: a different stable uid.
    callback: async () => success({ uid: "u-2", accountId: "someone-else" }),
  });
  const dir = await seedDir(env, "workbuddy", key);

  await controller.startSignIn({ provider: "workbuddy", account: { key } });
  await controller.whenSettled();

  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error).toEqual({
    code: "identity_mismatch",
    message: "This sign-in returned a different account than the identity it was started for.",
  });
  // Nothing was handed to magpie: the credential of the other account never
  // meets this directory's pin.
  expect(calls).toHaveLength(0);

  // The directory, its pin and its ledger are untouched.
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(join(dir, IDENTITY_FILE))).toBe(true);
  expect(await readAccountMeta(dir)).toMatchObject({ uid: "u-1", accountId: "me" });
  // The flow's marker did not outlive the failed attempt.
  expect(existsSync(join(dir, SIGNIN_FLOW_MARKER))).toBe(false);
});

test("a fresh sign-in onto a directory that gains a ledger mid-flight is guarded the same way", async () => {
  // With an empty auth file and no ledger yet, the bare key is free, so a fresh
  // sign-in pre-allocates `workbuddy` (allocation only treats a ledgered
  // directory as taken). A ledger appearing on that directory before the
  // callback lands -- an adopted identity, a concurrent claim -- must turn the
  // non-claimed path into the same collision.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { env, calls, controller } = await harness({
    callback: async () => {
      await gate;
      return success({ uid: "u-2" });
    },
  });

  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy");
  const dir = await seedDir(env, "workbuddy", "workbuddy");
  release();
  await controller.whenSettled();

  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error.code).toBe("identity_mismatch");
  expect(flow.claimed).toBe(false);
  expect(calls).toHaveLength(0);
  expect(existsSync(dir)).toBe(true);
  expect(await readAccountMeta(dir)).toMatchObject({ uid: "u-1" });
});

test("a matching account still writes back normally", async () => {
  const key = "workbuddy#retired";
  const { env, calls, controller } = await harness({
    callback: async () => success({ uid: "u-1" }),
  });
  await seedDir(env, "workbuddy", key);

  await controller.startSignIn({ provider: "workbuddy", account: { key } });
  await controller.whenSettled();

  const flow = controller.status();
  expect(flow.state).toBe("done");
  expect(calls).toHaveLength(1);
  expect(calls[0].path.id).toBe(key);
  // The ledger now records the fresh sign-in for the same identity.
  expect(await readAccountMeta(accountDir(env, "workbuddy", key))).toMatchObject({
    provider: "workbuddy",
    key,
    accountId: "me",
    uid: "u-1",
  });
});
