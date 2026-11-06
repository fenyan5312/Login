// The sign-in flow, driven entirely through injected pieces: no browser is
// started, no provider plugin is imported and no network request is made. The
// real filesystem is used for the account directories (a temp root).
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIGNIN_FLOW_MARKER,
  accountDir,
  accountProfileDir,
  readAccountMeta,
  writeAccountMeta,
} from "../lib/account-identity.mjs";
import { SignInBrowserError } from "../lib/browser-launcher.mjs";
import {
  SIGNIN_STATES,
  SignInFlowError,
  chooseBrowserMethod,
  createSignInFlow,
} from "../lib/signin-flow.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-flow-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixedRandom = () => 0.123456789;

function browserMethod({ url = "https://provider/signin", instructions = "go", callback } = {}) {
  return {
    type: "oauth",
    label: "Provider account (browser)",
    authorize: async () => ({ url, instructions, method: "auto", callback }),
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
    ...over,
  };
}

async function harness(overrides = {}) {
  const dir = await tempDir();
  const env = { MAGPIE_CLEAN_LOGIN_DATA: dir };
  const entries = overrides.entries ?? {};
  const clientCalls = [];
  const client =
    overrides.client ?? {
      auth: {
        set: async (input) => {
          clientCalls.push(input);
        },
      },
    };
  const state = { launched: null, browserClosed: 0 };
  const browser = {
    pid: 4321,
    async close() {
      state.browserClosed += 1;
    },
  };
  const methods = overrides.methods ?? [browserMethod({ callback: async () => success() })];
  const controller = createSignInFlow({
    env,
    client,
    readKeys: () => new Set(Object.keys(entries)),
    readEntries: () => entries,
    random: fixedRandom,
    identityGenerator: overrides.identityGenerator ?? (async () => ({ tag: "pin" })),
    loadProvider: overrides.loadProvider ?? (async () => ({ methods })),
    launchBrowser:
      overrides.launchBrowser ??
      (async (args) => {
        state.launched = args;
        return browser;
      }),
    resolveExecutable: overrides.resolveExecutable ?? (async () => "/fake/browser"),
    callbackTimeoutMs: overrides.callbackTimeoutMs,
    writeFlowMarker: overrides.writeFlowMarker,
    clearFlowMarker: overrides.clearFlowMarker,
  });
  return { dir, env, entries, client, clientCalls, browser, state, controller };
}

test("the happy path pins the account and writes the result back", async () => {
  const { dir, env, clientCalls, state, controller } = await harness();
  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started).toEqual({
    flowId: expect.any(String),
    key: "workbuddy",
    url: "https://provider/signin",
    instructions: "go",
  });
  expect(state.launched.identity).toEqual({ tag: "pin" });
  expect(state.launched.profileDir).toBe(
    accountProfileDir(accountDir(env, "workbuddy", "workbuddy")),
  );
  expect(existsSync(join(accountDir(env, "workbuddy", "workbuddy"), "identity.json"))).toBe(true);

  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("done");
  expect(flow.accountKey).toBe("workbuddy");
  expect(flow.identityCreated).toBe(true);
  expect(flow.error).toBeNull();
  expect(state.browserClosed).toBe(1);

  expect(clientCalls).toHaveLength(1);
  expect(clientCalls[0].path.id).toBe("workbuddy");
  expect(clientCalls[0].body.access).toBe("A");
  expect(clientCalls[0].body.refresh).toBe("R");
  expect("provider" in clientCalls[0].body).toBe(false);
  // The public status never carries a credential.
  expect(flow.access).toBeUndefined();
  expect(flow.refresh).toBeUndefined();
});

test("a sign-in marks its pre-allocated directory in flight and clears it on done", async () => {
  const { env, controller } = await harness();
  const dir = accountDir(env, "workbuddy", "workbuddy");
  await controller.startSignIn({ provider: "workbuddy" });
  // Written after the directory exists and before the browser opens, so the
  // directory is already marked by the time startSignIn returns.
  const markerFile = join(dir, SIGNIN_FLOW_MARKER);
  expect(existsSync(markerFile)).toBe(true);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  expect(marker.flowId).toBe(controller.status().flowId);
  expect(typeof marker.pid).toBe("number");
  expect(marker.startedAt).toBe(controller.status().createdAt);

  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
  expect(existsSync(markerFile)).toBe(false);
});

test("a failed sign-in clears its in-flight marker too", async () => {
  const { env, controller } = await harness({
    methods: [browserMethod({ callback: async () => ({ type: "failed", error: "denied" }) })],
  });
  const dir = accountDir(env, "workbuddy", "workbuddy");
  await controller.startSignIn({ provider: "workbuddy" });
  expect(existsSync(join(dir, SIGNIN_FLOW_MARKER))).toBe(true);
  await controller.whenSettled();
  expect(controller.status().state).toBe("error");
  expect(existsSync(join(dir, SIGNIN_FLOW_MARKER))).toBe(false);
});

test("a cancelled sign-in clears its in-flight marker", async () => {
  const { env, controller } = await harness({
    methods: [browserMethod({ callback: () => new Promise(() => {}) })],
  });
  const dir = accountDir(env, "workbuddy", "workbuddy");
  await controller.startSignIn({ provider: "workbuddy" });
  await controller.cancel();
  await controller.whenSettled();
  expect(controller.status().state).toBe("cancelled");
  expect(existsSync(join(dir, SIGNIN_FLOW_MARKER))).toBe(false);
});

test("a marker that cannot be written does not fail the sign-in", async () => {
  const { controller } = await harness({
    writeFlowMarker: async () => {
      throw new Error("disk full");
    },
    clearFlowMarker: async () => {
      throw new Error("disk full");
    },
  });
  const started = await controller.startSignIn({ provider: "workbuddy" });
  expect(started.key).toBe("workbuddy");
  await controller.whenSettled();
  expect(controller.status().state).toBe("done");
});

test("a repeated account gets a fresh pre-allocated key but writes to the existing one", async () => {
  const entries = { workbuddy: { accountId: "me" } };
  const { env, clientCalls, controller } = await harness({ entries });
  const started = await controller.startSignIn({ provider: "workbuddy" });
  // magpie's signInKey sees the occupied bare key and allocates `workbuddy#…`.
  expect(started.key.startsWith("workbuddy#")).toBe(true);
  expect(started.key).not.toBe("workbuddy");

  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("done");
  // writeBack de-duplicated the account back onto its existing key.
  expect(flow.accountKey).toBe("workbuddy");
  expect(clientCalls).toHaveLength(1);
  expect(clientCalls[0].path.id).toBe("workbuddy");
  // The identity followed the account onto the existing key and the in-flight
  // marker did not outlive the sign-in.
  expect(existsSync(join(accountDir(env, "workbuddy", "workbuddy"), "identity.json"))).toBe(true);
  expect(existsSync(join(accountDir(env, "workbuddy", "workbuddy"), SIGNIN_FLOW_MARKER))).toBe(false);
  expect(existsSync(accountDir(env, "workbuddy", started.key))).toBe(false);
});

test("a failed callback is an error and never writes", async () => {
  const { clientCalls, state, controller } = await harness({
    methods: [browserMethod({ callback: async () => ({ type: "failed", error: "denied" }) })],
  });
  await controller.startSignIn({ provider: "workbuddy" });
  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error).toEqual({ code: "callback_failed", message: "denied" });
  expect(clientCalls).toHaveLength(0);
  expect(state.browserClosed).toBe(1);
});

test("a callback that never finishes times out and never writes", async () => {
  const { clientCalls, controller } = await harness({
    callbackTimeoutMs: 20,
    methods: [browserMethod({ callback: () => new Promise(() => {}) })],
  });
  await controller.startSignIn({ provider: "workbuddy" });
  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error.code).toBe("callback_timeout");
  expect(clientCalls).toHaveLength(0);
});

test("a browser that cannot open is an error and never writes", async () => {
  const { clientCalls, controller } = await harness({
    launchBrowser: async () => {
      throw new SignInBrowserError("launch_failed", "boom", 502);
    },
  });
  await expect(controller.startSignIn({ provider: "workbuddy" })).rejects.toMatchObject({
    code: "launch_failed",
  });
  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error).toEqual({ code: "launch_failed", message: "boom" });
  expect(clientCalls).toHaveLength(0);
});

test("a missing plugin executable is reported honestly", async () => {
  const { controller } = await harness({ resolveExecutable: async () => null });
  await expect(controller.startSignIn({ provider: "workbuddy" })).rejects.toMatchObject({
    code: "browser_missing",
  });
  expect(controller.status().error.code).toBe("browser_missing");
});

test("a plugin with no browser method is reported honestly", async () => {
  const { controller } = await harness({
    methods: [{ type: "api", label: "API key" }],
  });
  await expect(controller.startSignIn({ provider: "workbuddy" })).rejects.toMatchObject({
    code: "no_browser_method",
  });
  expect(controller.status().state).toBe("error");
});

test("only one sign-in runs at a time", async () => {
  const { controller } = await harness({
    methods: [browserMethod({ callback: () => new Promise(() => {}) })],
  });
  await controller.startSignIn({ provider: "workbuddy" });
  await expect(controller.startSignIn({ provider: "workbuddy" })).rejects.toBeInstanceOf(
    SignInFlowError,
  );
  await controller.cancel();
  await controller.whenSettled();
  expect(controller.status().state).toBe("cancelled");
});

test("cancel moves the flow to cancelled and closes the browser", async () => {
  const { state, clientCalls, controller } = await harness({
    methods: [browserMethod({ callback: () => new Promise(() => {}) })],
  });
  await controller.startSignIn({ provider: "workbuddy" });
  const cancelled = await controller.cancel();
  expect(cancelled.cancelled).toBe(true);
  await controller.whenSettled();
  expect(controller.status().state).toBe("cancelled");
  expect(state.browserClosed).toBeGreaterThanOrEqual(1);
  expect(clientCalls).toHaveLength(0);
  // A second cancel is a no-op.
  expect((await controller.cancel()).cancelled).toBe(false);
});

test("a failed write-back is a distinct error and never throws out of the flow", async () => {
  const { controller, state } = await harness({
    client: {
      auth: {
        set: async () => {
          throw new Error("auth.set refused");
        },
      },
    },
  });
  await controller.startSignIn({ provider: "workbuddy" });
  await controller.whenSettled();
  const flow = controller.status();
  expect(flow.state).toBe("error");
  expect(flow.error.code).toBe("write_failed");
  expect(flow.error.message).toContain("auth.set refused");
  expect(state.browserClosed).toBe(1);
});

// The extended ownership ledger: a successful sign-in must record the exit it
// used (or an honest direct login) without ever storing a proxy credential or
// dropping a note / detection history that was already there.
test("a sign-in records a direct login when no proxyMeta is given", async () => {
  const { env, controller } = await harness();
  await controller.startSignIn({ provider: "workbuddy" });
  await controller.whenSettled();
  const meta = await readAccountMeta(accountDir(env, "workbuddy", "workbuddy"));
  expect(meta.version).toBe(1);
  expect(meta.signedInAt).toEqual(expect.any(String));
  expect(meta.lastLogin).toMatchObject({
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
  });
  expect(typeof meta.lastLogin.at).toBe("string");
  expect(meta.loginHistory).toHaveLength(1);
  expect(meta.loginHistory[0]).toEqual(meta.lastLogin);
});

test("a sign-in whitelists proxyMeta into the ledger", async () => {
  const { env, controller } = await harness();
  await controller.startSignIn({
    provider: "workbuddy",
    proxyMeta: {
      id: "p-01",
      name: "Hong Kong 01",
      region: "香港",
      type: "socks5",
      password: "secret-pass",
      host: "10.0.0.7",
      port: 1080,
      dir: "/home/user/.config/magpie",
    },
  });
  await controller.whenSettled();
  const path = accountDir(env, "workbuddy", "workbuddy");
  const meta = await readAccountMeta(path);
  expect(meta.lastLogin).toMatchObject({
    proxyId: "p-01",
    proxyName: "Hong Kong 01",
    region: "香港",
    type: "socks5",
  });
  expect(Object.keys(meta.lastLogin).sort()).toEqual(["at", "proxyId", "proxyName", "region", "type"]);
  const text = JSON.stringify(meta);
  for (const secret of ["secret-pass", "10.0.0.7", "1080", "/home/user"]) {
    expect(text).not.toContain(secret);
  }
});

test("a sign-in preserves an existing note, checks and login history", async () => {
  const { env, controller } = await harness();
  const dir = accountDir(env, "workbuddy", "workbuddy");
  const earlierLogin = { at: "2026-11-01T00:00:00.000Z", proxyId: null, proxyName: "", region: "", type: null };
  const earlierCheck = {
    at: "2026-11-01T00:00:00.000Z",
    grade: "A",
    proxyId: null,
    proxyName: "",
    region: "",
    exposure: 0,
    summary: [],
  };
  await writeAccountMeta(dir, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "me",
    uid: null,
    signedInAt: "2026-11-01T00:00:00.000Z",
    note: "keep this note",
    lastLogin: earlierLogin,
    loginHistory: [earlierLogin],
    checks: [earlierCheck],
  });
  // Claim this exact identity so the write-back reuses the directory whose
  // ledger we seeded (a fresh allocation would pick a new key).
  await controller.startSignIn({ provider: "workbuddy", account: { key: "workbuddy" } });
  await controller.whenSettled();
  const meta = await readAccountMeta(dir);
  expect(meta.note).toBe("keep this note");
  expect(meta.checks).toEqual([earlierCheck]);
  expect(meta.loginHistory).toHaveLength(2);
  expect(meta.loginHistory[1]).toEqual(earlierLogin);
  expect(meta.lastLogin.at).not.toBe(earlierLogin.at);
  expect(meta.version).toBe(1);
  expect(meta.provider).toBe("workbuddy");
});

test("chooseBrowserMethod prefers an explicit browser method and skips local", () => {
  const local = { type: "oauth", label: "Provider desktop's sign-in", authorize: async () => {} };
  const api = { type: "api", label: "API key" };
  const browser = { type: "oauth", label: "Provider (browser)", authorize: async () => {} };
  expect(chooseBrowserMethod([local, api, browser])).toBe(browser);
  expect(chooseBrowserMethod([local, api])).toBeNull();
  // An ambiguous oauth method with authorize is the fallback, not a local one.
  const ambiguous = { type: "oauth", label: "Provider GLM Coding Plan", authorize: async () => {} };
  expect(chooseBrowserMethod([local, ambiguous])).toBe(ambiguous);
});

test("a navigation warning reaches publicFlow with only the safe fields", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { controller } = await harness({
    methods: [browserMethod({ callback: () => pending })],
    launchBrowser: async () => ({
      pid: 4321,
      warning: {
        code: "navigation_failed",
        status: 504,
        message: "The login browser is open, but the page did not finish loading within 60 seconds.",
        url: "https://provider/signin?user_code=SECRET-CODE",
        detail: "goto: Timeout 30000ms exceeded",
        stack: "Error: SECRET-STACK",
        user_code: "SECRET-CODE",
      },
      async close() {},
    }),
  });
  await controller.startSignIn({ provider: "workbuddy" });
  const flow = controller.status();
  expect(flow.state).toBe("waiting-login");
  expect(flow.instructions).toBe("go");
  expect(flow.warning).toEqual({
    code: "navigation_failed",
    status: 504,
    message: "The login browser is open, but the page did not finish loading within 60 seconds.",
  });
  expect(Object.keys(flow.warning).sort()).toEqual(["code", "message", "status"]);
  expect(flow.warning).not.toHaveProperty("url");
  expect(flow.warning).not.toHaveProperty("detail");
  expect(flow.warning).not.toHaveProperty("stack");
  expect(flow.warning).not.toHaveProperty("user_code");
  expect(JSON.stringify(flow)).not.toContain("SECRET");
  release(success());
  await controller.whenSettled();
});

test("the state list covers the whole lifecycle", () => {
  expect(SIGNIN_STATES).toEqual([
    "idle",
    "authorizing",
    "waiting-login",
    "finishing",
    "done",
    "error",
    "cancelled",
  ]);
});
