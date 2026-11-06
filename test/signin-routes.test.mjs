// The three sign-in routes, with the flow controller injected. No browser is
// started and no provider plugin is imported.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";
import { SignInFlowError } from "../lib/signin-flow.mjs";

const tmp = mkdtempSync(join(tmpdir(), "clean-login-signin-routes-"));
let service;
let token;
let lastStart = null;
let lastComplete = null;

const flow = {
  flowId: "flow-1",
  provider: "workbuddy",
  state: "waiting-login",
  key: "workbuddy",
  accountKey: null,
  url: "https://provider/signin",
  instructions: "Sign in; this finishes by itself.",
  identityCreated: true,
  pid: 99,
  createdAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  error: null,
  warning: {
    code: "navigation_failed",
    status: 504,
    message: "The login browser is open, but the page did not finish loading within 60 seconds.",
  },
};

const signIn = {
  async startSignIn({ provider, proxy, single, methodLabel, account }) {
    if (provider === "missing-plugin") {
      throw new SignInFlowError("plugin_missing", 'No installed plugin provides "missing-plugin".', 404);
    }
    lastStart = { provider, proxy, single, methodLabel, account };
    return {
      flowId: "flow-1",
      key: "workbuddy",
      url: "https://provider/signin",
      instructions: flow.instructions,
    };
  },
  status: () => flow,
  async complete(text) {
    lastComplete = text;
    if (text === "") {
      throw new SignInFlowError("input_required", "Paste the redirect URL first.", 400);
    }
    return {
      flow: { ...flow, state: "finishing", awaitingInput: false },
    };
  },
  async cancel() {
    return { cancelled: true, flow: { ...flow, state: "cancelled" } };
  },
};

beforeAll(async () => {
  service = await startServer({
    port: 0,
    // Keep the plugin data directory and magpie's config directory inside the
    // temp root, so the startup orphan sweep never touches the real
    // ~/.config/magpie.
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(tmp, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: join(tmp, "data"),
    },
    dataDir: join(tmp, "data"),
    pluginScanner: { get: () => ({ available: false, providers: [] }), warm() {} },
    signIn,
  });
  await service.prune?.();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /content="([0-9a-f]{64})"/.exec(html)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function api(method, path, body, { withToken = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (withToken) headers[TOKEN_HEADER] = token;
  return fetch(`http://127.0.0.1:${service.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("POST /api/signin starts a flow and returns the browser URL, not credentials", async () => {
  const res = await api("POST", "/api/signin", { provider: "workbuddy" });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body).toEqual({
    flowId: "flow-1",
    key: "workbuddy",
    url: "https://provider/signin",
    instructions: flow.instructions,
  });
  expect(lastStart).toEqual({
    provider: "workbuddy",
    proxy: null,
    single: false,
    methodLabel: null,
    account: null,
  });
  expect(JSON.stringify(body)).not.toMatch(/access|refresh|token/i);
});

test("POST /api/signin forwards the proxy and the single flag", async () => {
  const proxy = { server: "http://127.0.0.1:8080" };
  const res = await api("POST", "/api/signin", { provider: "workbuddy", proxy, single: true });
  expect(res.status).toBe(202);
  expect(lastStart).toEqual({
    provider: "workbuddy",
    proxy,
    single: true,
    methodLabel: null,
    account: null,
  });
});

// Continuing a kept identity: only the account key travels; the controller
// verifies the directory's ledger before reusing its fingerprint.
test("POST /api/signin forwards the chosen account key", async () => {
  const res = await api("POST", "/api/signin", {
    provider: "workbuddy",
    account: { key: "workbuddy#ab12" },
  });
  expect(res.status).toBe(202);
  expect(lastStart.account).toEqual({ key: "workbuddy#ab12" });
});

test("POST /api/signin ignores a blank or non-string account key", async () => {
  for (const account of [null, "workbuddy#ab12", {}, { key: "" }, { key: 42 }, { key: "   " }]) {
    const res = await api("POST", "/api/signin", { provider: "workbuddy", account });
    expect(res.status).toBe(202);
    // A whitespace-only key still reaches the controller; it is the
    // controller's `retired_missing` that reports it honestly. Everything
    // that is not an object with a string key is "no claim".
    if (account && typeof account === "object" && typeof account.key === "string" && account.key) {
      expect(lastStart.account).toEqual({ key: account.key });
    } else {
      expect(lastStart.account).toBeNull();
    }
  }
});

// The plugin exposes several runnable oauth methods (ZCode's per-site flows),
// so the page sends the exact label of the one the user picked.
test("POST /api/signin forwards the chosen method label", async () => {
  const res = await api("POST", "/api/signin", {
    provider: "zcode",
    methodLabel: "ZCode: BigModel (智谱) GLM Coding Plan",
  });
  expect(res.status).toBe(202);
  expect(lastStart.methodLabel).toBe("ZCode: BigModel (智谱) GLM Coding Plan");
});

test("POST /api/signin ignores a blank or non-string method label", async () => {
  for (const methodLabel of ["", "   ", 42, null, { label: "x" }]) {
    const res = await api("POST", "/api/signin", { provider: "zcode", methodLabel });
    expect(res.status).toBe(202);
    expect(lastStart.methodLabel).toBeNull();
  }
});

test("POST /api/signin resolves a stored proxy id server-side", async () => {
  const created = await api("POST", "/api/proxies", {
    name: "SG · 01",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    password: "s3cret",
  });
  expect(created.status).toBe(201);
  const proxy = (await created.json()).proxy;
  // The API never returns the password; the page only holds public fields.
  expect(proxy).not.toHaveProperty("password");
  const res = await api("POST", "/api/signin", {
    provider: "workbuddy",
    proxy: { id: proxy.id, type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username },
  });
  expect(res.status).toBe(202);
  // The record the flow receives is the stored one, credential included.
  expect(lastStart.provider).toBe("workbuddy");
  expect(lastStart.proxy).toMatchObject({
    id: proxy.id,
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    password: "s3cret",
  });
});

test("POST /api/signin rejects an unknown proxy id with a clear 404", async () => {
  const res = await api("POST", "/api/signin", { provider: "workbuddy", proxy: { id: "no-such-proxy" } });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not_found");
});

test("POST /api/signin without a provider is a clear 400", async () => {
  const res = await api("POST", "/api/signin", {});
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid_provider");
});

test("a flow error maps to its own status and code", async () => {
  const res = await api("POST", "/api/signin", { provider: "missing-plugin" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: "plugin_missing",
    message: 'No installed plugin provides "missing-plugin".',
  });
});

test("GET /api/signin returns the current flow", async () => {
  const res = await api("GET", "/api/signin");
  expect(res.status).toBe(200);
  expect((await res.json()).flow).toEqual(flow);
});

test("GET /api/signin carries the navigation warning without changing the route shape", async () => {
  const res = await api("GET", "/api/signin");
  expect(res.status).toBe(200);
  expect((await res.json()).flow.warning).toEqual(flow.warning);
});

test("POST /api/signin/complete hands the pasted value to the flow", async () => {
  lastComplete = null;
  const res = await api("POST", "/api/signin/complete", {
    text: "https://provider/callback?code=abc",
  });
  expect(res.status).toBe(200);
  expect(lastComplete).toBe("https://provider/callback?code=abc");
  expect((await res.json()).flow).toMatchObject({ state: "finishing", awaitingInput: false });
});

test("POST /api/signin/complete accepts an empty body and reports its own error", async () => {
  lastComplete = null;
  const res = await api("POST", "/api/signin/complete", {});
  expect(lastComplete).toBe("");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "input_required",
    message: "Paste the redirect URL first.",
  });
});

test("POST /api/signin/complete tolerates no body at all", async () => {
  lastComplete = null;
  const res = await api("POST", "/api/signin/complete");
  expect(res.status).toBe(400);
  expect(lastComplete).toBe("");
});

test("POST /api/signin/cancel cancels and returns the new state", async () => {
  const res = await api("POST", "/api/signin/cancel");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ cancelled: true, flow });
});

test("the sign-in routes require the page token", async () => {
  for (const [method, path] of [
    ["GET", "/api/signin"],
    ["POST", "/api/signin"],
    ["POST", "/api/signin/complete"],
    ["POST", "/api/signin/cancel"],
  ]) {
    const res = await api(method, path, method === "POST" ? { provider: "workbuddy" } : undefined, {
      withToken: false,
    });
    expect(res.status).toBe(403);
  }
});

test("the sign-in routes reject other methods", async () => {
  for (const [method, path, allow] of [
    ["PUT", "/api/signin", "GET, POST"],
    ["GET", "/api/signin/cancel", "POST"],
    ["GET", "/api/signin/complete", "POST"],
  ]) {
    const res = await api(method, path);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe(allow);
  }
});
