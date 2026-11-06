// The trust-score routes, with the score controller injected. No browser is
// started, no page is fetched and no network request leaves the machine.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvironmentManager } from "../lib/browser-environment.mjs";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";

// The two end-to-end score tests below run the real controller. Its preflight
// needs an installed scoring browser: the executable and the fingerprint model
// `ensureIdentity` draws from. CI has no such browser. Detect it once so those
// tests run where the environment exists and are skipped, with the reason in
// their name, where it does not. Only this specific missing environment skips;
// an assertion failure inside a running test is still a failure.
async function scoreBrowserAvailability() {
  try {
    const status = await createEnvironmentManager().status();
    if (status?.ready) return { ready: true, reason: "" };
    return {
      ready: false,
      reason:
        status?.installed === true
          ? "scoring browser is installed but its fingerprint model is not ready"
          : "scoring browser is not installed (prepare it on the Providers page first)",
    };
  } catch (error) {
    return {
      ready: false,
      reason: `scoring browser status could not be read: ${error?.message ?? error}`,
    };
  }
}

const scoreBrowser = await scoreBrowserAvailability();
const scoreTest = scoreBrowser.ready ? test : test.skip;
const scoreSkipNote = scoreBrowser.ready ? "" : ` — skipped: ${scoreBrowser.reason}`;

const tmp = mkdtempSync(join(tmpdir(), "clean-login-score-routes-"));
let service;
let token;
let lastStart = null;
let cancelled = 0;

const job = {
  state: "measuring",
  proxyId: "proxy-1",
  proxyName: "SG 01",
  score: null,
  label: "",
  ip: "",
  error: "",
  errorCode: "",
  warning: {
    code: "navigation_failed",
    status: 504,
    message: "The scoring browser opened, but the page did not finish loading.",
  },
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
};

const proxyScore = {
  async start({ id, name, proxy, expectedUpdatedAt }) {
    if (id === "missing-proxy") {
      const error = new Error("Proxy not found.");
      error.code = "proxy_not_found";
      error.status = 404;
      throw error;
    }
    lastStart = { id, name, proxy, expectedUpdatedAt };
    return { ...job };
  },
  status: () => ({ job, browserOpen: true }),
  async cancel() {
    cancelled += 1;
    return { cancelled: true, job: { ...job, state: "cancelled", errorCode: "cancelled" } };
  },
  async close() {},
};

beforeAll(async () => {
  service = await startServer({
    port: 0,
    dataDir: join(tmp, "data"),
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(tmp, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: join(tmp, "data"),
    },
    pluginScanner: { get: () => ({ available: false, providers: [] }), warm() {} },
    proxyScore,
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

async function createProxy(overrides = {}) {
  const res = await api("POST", "/api/proxies", {
    name: "SG 01",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    password: "s3cret",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()).proxy;
}

test("POST /api/proxies/:id/score starts a check and returns the job", async () => {
  const proxy = await createProxy({ name: "Score proxy" });
  const res = await api("POST", `/api/proxies/${proxy.id}/score`);
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.job.state).toBe("measuring");
  expect(body.job.proxyId).toBe("proxy-1");
  // The controller gets the stored record, credential included: the browser
  // really uses that exit and the password never leaves the service.
  expect(lastStart.id).toBe(proxy.id);
  expect(lastStart.name).toBe("Score proxy");
  expect(lastStart.proxy).toMatchObject({
    id: proxy.id,
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    password: "s3cret",
  });
  expect(lastStart.expectedUpdatedAt).toBeTruthy();
});

test("POST /api/proxies/:id/score on an unknown proxy is a clear 404", async () => {
  const res = await api("POST", "/api/proxies/no-such-proxy/score");
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not_found");
});

test("GET /api/proxy-score returns the job and the window state", async () => {
  const res = await api("GET", "/api/proxy-score");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.job).toEqual(job);
  expect(body.browserOpen).toBe(true);
});

test("GET /api/proxy-score carries the navigation warning without changing the route shape", async () => {
  const res = await api("GET", "/api/proxy-score");
  expect(res.status).toBe(200);
  expect((await res.json()).job.warning).toEqual(job.warning);
});

test("POST /api/proxy-score/cancel closes the window and returns the job", async () => {
  const res = await api("POST", "/api/proxy-score/cancel");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.job.state).toBe("cancelled");
  expect(body.job.errorCode).toBe("cancelled");
  expect(cancelled).toBe(1);
});

test("the score routes require the page token", async () => {
  for (const [method, path] of [
    ["POST", "/api/proxies/some-id/score"],
    ["GET", "/api/proxy-score"],
    ["POST", "/api/proxy-score/cancel"],
  ]) {
    const res = await api(method, path, undefined, { withToken: false });
    expect(res.status).toBe(403);
  }
});

test("the score routes reject other methods", async () => {
  for (const [method, path, allow] of [
    ["GET", "/api/proxy-score/cancel", "POST"],
    ["POST", "/api/proxy-score", "GET"],
  ]) {
    const res = await api(method, path);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe(allow);
  }
});

test("the score routes refuse another site's Origin", async () => {
  const res = await fetch(`http://127.0.0.1:${service.port}/api/proxy-score`, {
    headers: { origin: "https://evil.example", [TOKEN_HEADER]: token },
  });
  expect(res.status).toBe(403);
});

// ---------- the real controller against the real store ----------

// The controller is not injected here: only the browser is. The measured
// score must end up on the proxy row, in the list and in bootstrap.
scoreTest(`a measured score reaches the proxy row, the list and bootstrap${scoreSkipNote}`, async () => {
  const { startServer } = await import("../lib/server.mjs");
  const dir = mkdtempSync(join(tmpdir(), "clean-login-score-e2e-"));
  let resolveScore;
  const scorePromise = new Promise((resolve) => {
    resolveScore = resolve;
  });
  let closed = 0;
  const local = await startServer({
    port: 0,
    dataDir: join(dir, "data"),
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(dir, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: join(dir, "data"),
    },
    pluginScanner: { get: () => ({ available: false, providers: [] }), warm() {} },
    // The browser is the only fake: no window is opened.
    scoreLauncher: async () => ({
      pid: 4242,
      result: scorePromise,
      async close() {
        closed += 1;
      },
    }),
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${local.port}/`)).text();
    const localToken = /content="([0-9a-f]{64})"/.exec(html)[1];
    const headers = { "content-type": "application/json", [TOKEN_HEADER]: localToken };
    const base = `http://127.0.0.1:${local.port}`;

    const created = await (
      await fetch(`${base}/api/proxies`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "SG 01", type: "http", host: "127.0.0.1", port: 8080 }),
      })
    ).json();
    const id = created.proxy.id;
    expect(created.proxy.score).toBe(null);

    const started = await fetch(`${base}/api/proxies/${id}/score`, { method: "POST", headers });
    expect(started.status).toBe(202);
    const startedBody = await started.json();
    expect(startedBody.ok).toBe(true);
    expect(startedBody.job.state).toBe("measuring");
    expect(startedBody.job.proxyId).toBe(id);

    resolveScore({ score: 92, label: "优异", ip: "203.0.113.7" });
    // The measurement finishes in the background; wait for the row to change.
    for (let i = 0; i < 50; i += 1) {
      const list = await (await fetch(`${base}/api/proxies`, { headers })).json();
      const found = list.proxies.find((item) => item.id === id);
      if (found?.score === 92) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const list = await (await fetch(`${base}/api/proxies`, { headers })).json();
    const found = list.proxies.find((item) => item.id === id);
    expect(found.score).toBe(92);
    expect(found.scoreLabel).toBe("优异");
    expect(found.scoreIp).toBe("203.0.113.7");
    expect(found.scoreCheckedAt).toBeTruthy();
    expect(found.scoreError).toBe("");
    expect(found.scoreErrorCode).toBe("");

    const bootstrap = await (await fetch(`${base}/api/bootstrap`, { headers })).json();
    const inBootstrap = bootstrap.proxies.find((item) => item.id === id);
    expect(inBootstrap.score).toBe(92);
    expect(inBootstrap.scoreLabel).toBe("优异");

    // The window is still open for the user to look at.
    const status = await (await fetch(`${base}/api/proxy-score`, { headers })).json();
    expect(status.browserOpen).toBe(true);
    expect(status.job.state).toBe("done");
    expect(status.job.score).toBe(92);

    // Cancelling closes the window but keeps the recorded score.
    const cancelled = await (await fetch(`${base}/api/proxy-score/cancel`, { method: "POST", headers })).json();
    expect(cancelled.ok).toBe(true);
    expect(cancelled.job.state).toBe("done");
    expect(cancelled.job.score).toBe(92);
    expect(closed).toBe(1);
    const after = await (await fetch(`${base}/api/proxies`, { headers })).json();
    expect(after.proxies.find((item) => item.id === id).score).toBe(92);
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

scoreTest(`a second score while one runs is a 409 score_busy${scoreSkipNote}`, async () => {
  const { startServer } = await import("../lib/server.mjs");
  const dir = mkdtempSync(join(tmpdir(), "clean-login-score-busy-"));
  const local = await startServer({
    port: 0,
    dataDir: join(dir, "data"),
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(dir, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: join(dir, "data"),
    },
    pluginScanner: { get: () => ({ available: false, providers: [] }), warm() {} },
    scoreLauncher: async () => ({
      pid: 1,
      result: new Promise(() => {}),
      async close() {},
    }),
  });
  try {
    const html = await (await fetch(`http://127.0.0.1:${local.port}/`)).text();
    const localToken = /content="([0-9a-f]{64})"/.exec(html)[1];
    const headers = { "content-type": "application/json", [TOKEN_HEADER]: localToken };
    const base = `http://127.0.0.1:${local.port}`;
    const created = await (
      await fetch(`${base}/api/proxies`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "SG 01", type: "http", host: "127.0.0.1", port: 8080 }),
      })
    ).json();
    const id = created.proxy.id;

    const first = await fetch(`${base}/api/proxies/${id}/score`, { method: "POST", headers });
    expect(first.status).toBe(202);
    const second = await fetch(`${base}/api/proxies/${id}/score`, { method: "POST", headers });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("score_busy");
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
