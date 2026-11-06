// A retired identity owns its key even though magpie no longer holds a
// credential for it. Non-claimed allocation must therefore treat a ledgered
// directory's key as taken, or a new account would be allocated the directory
// of a signed-out account and open its browser with that account's pin and
// cookies. Everything here runs against a temp data directory with the browser
// and the provider plugin injected: no real config directory is read.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_FILE,
  accountDir,
  listAccountDirsWithMeta,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";
import { createSignInFlow, retiredAccountKeys } from "../lib/signin-flow.mjs";

const tempDirs = [];

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-retired-"));
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

// The retired directory of account A: a pin from an earlier sign-in, an
// ownership ledger, and no key in the auth file (it signed out).
async function seedRetired(env, provider, key, { identity = { tag: "a-pinned" }, meta } = {}) {
  const dir = accountDir(env, provider, key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, IDENTITY_FILE), `${JSON.stringify(identity, null, 2)}\n`);
  await writeAccountMeta(dir, {
    version: 1,
    provider,
    key,
    accountId: "a-account",
    uid: "u-a",
    signedInAt: "2026-11-02T09:00:00.000Z",
    ...meta,
  });
  return dir;
}

async function harness({ entries = {}, callback = async () => success(), overrides = {} } = {}) {
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
    identityGenerator: async () => ({ tag: "b-pin" }),
    loadProvider: async () => ({ methods: [browserMethod(callback)] }),
    launchBrowser: async () => ({ pid: 1, close: async () => {} }),
    resolveExecutable: async () => "/fake/browser",
    ...overrides,
  });
  return { dir, env, calls, controller };
}

test("retiredAccountKeys collects only this provider's ledgered keys", async () => {
  const { env } = await tempEnv();
  await seedRetired(env, "workbuddy", "workbuddy");
  await seedRetired(env, "workbuddy", "workbuddy#ab12");
  await seedRetired(env, "cursor", "cursor");
  // A pre-allocated directory with no ledger is not retired.
  await mkdir(accountDir(env, "workbuddy", "workbuddy#orphan"), { recursive: true });

  expect([...(await retiredAccountKeys(env, "workbuddy"))].sort()).toEqual([
    "workbuddy",
    "workbuddy#ab12",
  ]);
  expect([...(await retiredAccountKeys(env, "cursor"))]).toEqual(["cursor"]);
  expect([...(await retiredAccountKeys(env, "zcode"))]).toEqual([]);
});

test("a new identity is never allocated a retired key", async () => {
  // Account A signed out: its bare key is retired and the auth file is empty,
  // so `signInKey` would hand the bare key to account B.
  const { env, calls, controller } = await harness();
  const retiredDir = await seedRetired(env, "workbuddy", "workbuddy");
  const retiredPin = readFileSync(join(retiredDir, IDENTITY_FILE), "utf8");

  const started = await controller.startSignIn({ provider: "workbuddy" });

  // Not the retired bare key: a fresh `workbuddy#<slot>` instead.
  expect(started.key).not.toBe("workbuddy");
  expect(started.key).toBe("workbuddy#" + fixedSuffix);
  expect(started.key.startsWith("workbuddy#")).toBe(true);

  // The new identity really is new: its own directory and its own pin.
  const newDir = accountDir(env, "workbuddy", started.key);
  expect(newDir).not.toBe(retiredDir);
  expect(controller.status().identityCreated).toBe(true);
  expect(JSON.parse(readFileSync(join(newDir, IDENTITY_FILE), "utf8"))).toEqual({ tag: "b-pin" });

  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  // The write-back allocates against the same key set, so the credential never
  // lands on the retired bare key either.
  expect(calls).toHaveLength(1);
  expect(calls[0].path.id).not.toBe("workbuddy");
  expect(calls[0].path.id.startsWith("workbuddy#")).toBe(true);
  expect(controller.status().accountKey).toBe(calls[0].path.id);
  // Account B's new identity travels with its directory to the final key.
  const finalDir = accountDir(env, "workbuddy", calls[0].path.id);
  expect(JSON.parse(readFileSync(join(finalDir, IDENTITY_FILE), "utf8"))).toEqual({
    tag: "b-pin",
  });

  // Account A's directory, pin and ledger are untouched.
  expect(readFileSync(join(retiredDir, IDENTITY_FILE), "utf8")).toBe(retiredPin);
  expect(await readAccountMeta(retiredDir)).toMatchObject({ key: "workbuddy", uid: "u-a" });
});

test("a slot key that is already retired is skipped as well", async () => {
  // The bare key is taken by someone still signed in, and the first slot the
  // random source offers is the retired one, so the allocator must keep going.
  const second = 0.987654321;
  const secondSuffix = second.toString(36).slice(2, 8);
  const draws = [0.123456789, second];
  let draw = 0;
  const { env, controller } = await harness({
    entries: { workbuddy: { accountId: "signed-in" } },
    overrides: { random: () => draws[draw++] ?? 0.5 },
  });
  await seedRetired(env, "workbuddy", "workbuddy#" + fixedSuffix);

  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy#" + secondSuffix);
  await controller.whenSettled();
});

test("claiming a retired identity still uses its bare key and its pin", async () => {
  const { env, calls, controller } = await harness({
    callback: async () => success({ accountId: "a-account", uid: "u-a" }),
  });
  const dir = await seedRetired(env, "workbuddy", "workbuddy");
  const before = readFileSync(join(dir, IDENTITY_FILE), "utf8");

  const started = await controller.startSignIn({
    provider: "workbuddy",
    account: { key: "workbuddy" },
  });

  // A claim bypasses allocation, so the retained key is still reachable.
  expect(started.key).toBe("workbuddy");
  await controller.whenSettled();

  const flow = controller.status();
  expect(flow.state).toBe("done");
  expect(flow.claimed).toBe(true);
  expect(flow.identityCreated).toBe(false);
  expect(readFileSync(join(dir, IDENTITY_FILE), "utf8")).toBe(before);
  expect(calls.map((call) => call.path.id)).toEqual(["workbuddy"]);
});

test("a ledger that cannot be listed degrades to the old allocation", async () => {
  const { env, calls, controller } = await harness({
    callback: async () => success({ accountId: "a-account", uid: "u-a" }),
    overrides: {
      retiredKeys: async () => {
        throw new Error("cannot list the account directories");
      },
    },
  });
  await seedRetired(env, "workbuddy", "workbuddy");

  // The login is not interrupted: the bare key is allocated exactly as before
  // this rule existed.
  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy");
  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  expect(calls.map((call) => call.path.id)).toEqual(["workbuddy"]);
});

test("a ledger that cannot be read degrades to the old allocation", async () => {
  // Real directory listing over the temp root, but every ledger read throws.
  const { env, calls, controller } = await harness({
    callback: async () => success({ accountId: "a-account", uid: "u-a" }),
    overrides: {
      retiredKeys: (provider) =>
        retiredAccountKeys(env, provider, {
          list: (envArg) =>
            listAccountDirsWithMeta(envArg, {
              readMeta: async () => {
                throw new Error("cannot read the ledger");
              },
            }),
        }),
    },
  });
  await seedRetired(env, "workbuddy", "workbuddy");

  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy");
  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  expect(calls.map((call) => call.path.id)).toEqual(["workbuddy"]);
});

test("a single provider keeps its one slot", async () => {
  // Unchanged behavior: a single provider has no second slot to move to, so a
  // retired key cannot be avoided here. A matching account still completes.
  const { env, calls, controller } = await harness({
    callback: async () => success({ accountId: "a-account", uid: "u-a" }),
  });
  await seedRetired(env, "workbuddy", "workbuddy");

  const started = await controller.startSignIn({ provider: "workbuddy", single: true });
  expect(started.key).toBe("workbuddy");
  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  expect(calls.map((call) => call.path.id)).toEqual(["workbuddy"]);
});
