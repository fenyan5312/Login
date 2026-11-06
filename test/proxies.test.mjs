import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "clean-login-proxies-"));
const dataDir = join(tmp, "data");
// Keep both the plugin data directory and magpie's config directory inside the
// temp root, so the startup orphan sweep never reads or writes the real
// ~/.config/magpie.
const serverEnv = {
  ...process.env,
  MAGPIE_CONFIG_DIR: join(tmp, "magpie-config"),
  MAGPIE_CLEAN_LOGIN_DATA: dataDir,
};
let service;
let port;
let token;
let okProxy;
let authProxy;
let delayProxy;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function startProxy(handler) {
  const server = createServer(handler);
  const proxyPort = await listen(server);
  return {
    port: proxyPort,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function raw(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function auth(extra = {}) {
  return { "x-clean-login-token": token, ...extra };
}

function jsonHeaders() {
  return auth({ "content-type": "application/json" });
}

async function refreshToken() {
  const page = await raw("GET", "/");
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(page.body)?.[1];
  expect(token).toMatch(/^[0-9a-f]{64}$/);
}

async function createProxy(overrides = {}) {
  const response = await raw(
    "POST",
    "/api/proxies",
    jsonHeaders(),
    JSON.stringify({
      name: `Proxy ${Math.random().toString(16).slice(2)}`,
      type: "http",
      host: "127.0.0.1",
      port: okProxy.port,
      username: "alice",
      password: "s3cret",
      ...overrides,
    }),
  );
  expect(response.status).toBe(201);
  return JSON.parse(response.body).proxy;
}

beforeAll(async () => {
  okProxy = await startProxy((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "203.0.113.10", region: "Testland" }));
  });
  authProxy = await startProxy((_req, res) => {
    res.writeHead(407);
    res.end();
  });
  delayProxy = await startProxy((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ip: "203.0.113.11", region: "Slowland" }));
    }, 300);
  });
  const { startServer } = await import("../lib/server.mjs");
  service = await startServer({
    port: 0,
    dataDir,
    env: serverEnv,
    proxyEndpoint: "http://127.0.0.1:1/ip",
  });
  port = service.port;
  await refreshToken();
});

afterAll(async () => {
  await service?.close();
  await okProxy?.close();
  await authProxy?.close();
  await delayProxy?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("starts with an empty persisted collection", async () => {
  const response = await raw("GET", "/api/proxies", auth());
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).proxies).toEqual([]);
  expect(existsSync(join(dataDir, "proxies.json"))).toBe(false);
});

test("creates, lists and redacts the password", async () => {
  const response = await raw(
    "POST",
    "/api/proxies",
    jsonHeaders(),
    JSON.stringify({
      name: "  Singapore  ",
      type: "HTTP",
      host: " 127.0.0.1 ",
      port: "8080",
      username: "alice",
      password: "s3cret",
      id: "client-supplied-id",
      status: "ok",
    }),
  );
  expect(response.status).toBe(201);
  const proxy = JSON.parse(response.body).proxy;
  expect(proxy.id).not.toBe("client-supplied-id");
  expect(proxy.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(proxy.name).toBe("Singapore");
  expect(proxy.type).toBe("http");
  expect(proxy.host).toBe("127.0.0.1");
  expect(proxy.port).toBe(8080);
  expect(proxy.username).toBe("alice");
  expect(proxy.hasPassword).toBe(true);
  expect(proxy.status).toBe("untested");
  expect(proxy.region).toBe("");
  expect(response.body).not.toContain("s3cret");
  expect(response.body).not.toContain("password");

  const list = await raw("GET", "/api/proxies", auth());
  expect(list.status).toBe(200);
  const found = JSON.parse(list.body).proxies.find((item) => item.id === proxy.id);
  expect(found).toEqual(proxy);

  const stored = JSON.parse(readFileSync(join(dataDir, "proxies.json"), "utf8"));
  expect(stored.proxies.find((item) => item.id === proxy.id).password).toBe("s3cret");
});

test("bootstrap includes persisted proxies without secrets", async () => {
  const created = await createProxy({ name: "Bootstrap proxy" });
  const response = await raw("GET", "/api/bootstrap", auth());
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body);
  expect(Array.isArray(body.providers)).toBe(true);
  expect(body.providers.length).toBeGreaterThan(0);
  const found = body.proxies.find((item) => item.id === created.id);
  expect(found).toBeTruthy();
  expect(found.hasPassword).toBe(true);
  expect(response.body).not.toContain("s3cret");
  expect(response.body).not.toContain("password");
});

test("PATCH keeps an omitted password and redacts an updated one", async () => {
  const created = await createProxy({ name: "Patch proxy", password: "first-secret" });
  const renamed = await raw(
    "PATCH",
    `/api/proxies/${created.id}`,
    jsonHeaders(),
    JSON.stringify({ name: "Patch proxy renamed" }),
  );
  expect(renamed.status).toBe(200);
  expect(JSON.parse(renamed.body).proxy.name).toBe("Patch proxy renamed");
  expect(JSON.parse(renamed.body).proxy.hasPassword).toBe(true);
  let stored = JSON.parse(readFileSync(join(dataDir, "proxies.json"), "utf8"));
  expect(stored.proxies.find((item) => item.id === created.id).password).toBe("first-secret");

  const changed = await raw(
    "PATCH",
    `/api/proxies/${created.id}`,
    jsonHeaders(),
    JSON.stringify({ password: "second-secret" }),
  );
  expect(changed.status).toBe(200);
  expect(changed.body).not.toContain("second-secret");
  expect(changed.body).not.toContain("first-secret");
  stored = JSON.parse(readFileSync(join(dataDir, "proxies.json"), "utf8"));
  expect(stored.proxies.find((item) => item.id === created.id).password).toBe("second-secret");
});

test("changing the connection resets an old test result", async () => {
  const created = await createProxy({ name: "Reset proxy" });
  const tested = await raw("POST", `/api/proxies/${created.id}/test`, auth());
  expect(tested.status).toBe(200);
  expect(JSON.parse(tested.body).proxy.status).toBe("ok");
  const changed = await raw(
    "PATCH",
    `/api/proxies/${created.id}`,
    jsonHeaders(),
    JSON.stringify({ port: okProxy.port + 1 }),
  );
  expect(changed.status).toBe(200);
  const proxy = JSON.parse(changed.body).proxy;
  expect(proxy.status).toBe("untested");
  expect(proxy.region).toBe("");
  expect(proxy.latency).toBe(null);
  expect(proxy.lastCheckedAt).toBe(null);
});

test("a new proxy starts with empty score fields", async () => {
  const created = await createProxy({ name: "Unscored proxy" });
  expect(created.score).toBe(null);
  expect(created.scoreLabel).toBe("");
  expect(created.scoreIp).toBe("");
  expect(created.scoreCheckedAt).toBe(null);
  expect(created.scoreError).toBe("");
  expect(created.scoreErrorCode).toBe("");
});

test("a stored score is returned by the list and by bootstrap", async () => {
  const created = await createProxy({ name: "Scored proxy" });
  const applied = await service.store.applyScoreResult(
    created.id,
    { ok: true, score: 92, label: "优异", ip: "203.0.113.20", checkedAt: "2026-01-02T03:04:05.000Z" },
    created.updatedAt,
  );
  expect(applied.score).toBe(92);
  expect(applied.scoreLabel).toBe("优异");
  expect(applied.scoreIp).toBe("203.0.113.20");

  const list = await raw("GET", "/api/proxies", auth());
  const found = JSON.parse(list.body).proxies.find((item) => item.id === created.id);
  expect(found.score).toBe(92);
  expect(found.scoreLabel).toBe("优异");
  expect(found.scoreIp).toBe("203.0.113.20");
  expect(found.scoreCheckedAt).toBe("2026-01-02T03:04:05.000Z");
  expect(found.scoreError).toBe("");
  expect(found.scoreErrorCode).toBe("");

  const bootstrap = await raw("GET", "/api/bootstrap", auth());
  const inBootstrap = JSON.parse(bootstrap.body).proxies.find((item) => item.id === created.id);
  expect(inBootstrap.score).toBe(92);
  expect(inBootstrap.scoreLabel).toBe("优异");
});

test("changing the connection clears the stored score", async () => {
  const created = await createProxy({ name: "Rescored proxy" });
  await service.store.applyScoreResult(
    created.id,
    { ok: true, score: 92, label: "优异", ip: "203.0.113.20", checkedAt: "2026-01-02T03:04:05.000Z" },
    created.updatedAt,
  );
  const changed = await raw(
    "PATCH",
    `/api/proxies/${created.id}`,
    jsonHeaders(),
    JSON.stringify({ port: okProxy.port + 1 }),
  );
  expect(changed.status).toBe(200);
  const proxy = JSON.parse(changed.body).proxy;
  expect(proxy.score).toBe(null);
  expect(proxy.scoreLabel).toBe("");
  expect(proxy.scoreIp).toBe("");
  expect(proxy.scoreCheckedAt).toBe(null);
  expect(proxy.scoreError).toBe("");
  expect(proxy.scoreErrorCode).toBe("");
});

test("a failed score records its error and never keeps a number", async () => {
  const created = await createProxy({ name: "Failed score proxy" });
  await service.store.applyScoreResult(
    created.id,
    { ok: true, score: 92, label: "优异", ip: "203.0.113.20", checkedAt: "2026-01-02T03:04:05.000Z" },
    created.updatedAt,
  );
  const applied = await service.store.applyScoreResult(
    created.id,
    { ok: false, error: "The trust score page did not return a score in time.", errorCode: "page_timeout" },
    null,
  );
  expect(applied.score).toBe(null);
  expect(applied.scoreLabel).toBe("");
  expect(applied.scoreIp).toBe("");
  expect(applied.scoreError).toBe("The trust score page did not return a score in time.");
  expect(applied.scoreErrorCode).toBe("page_timeout");
  expect(applied.scoreCheckedAt).toBeTruthy();
});

test("an impossible score is refused instead of being stored", async () => {
  const created = await createProxy({ name: "Impossible score proxy" });
  const applied = await service.store.applyScoreResult(
    created.id,
    { ok: true, score: 250, label: "溢出", ip: "", checkedAt: "2026-01-02T03:04:05.000Z" },
    created.updatedAt,
  );
  expect(applied.score).toBe(null);
  expect(applied.scoreErrorCode).toBeTruthy();
});

test("a score measured on an older revision is not applied", async () => {
  const created = await createProxy({ name: "Stale score proxy" });
  const applied = await service.store.applyScoreResult(
    created.id,
    { ok: true, score: 92, label: "优异", ip: "", checkedAt: "2026-01-02T03:04:05.000Z" },
    "1999-01-01T00:00:00.000Z",
  );
  expect(applied).toBe(null);
  const list = await raw("GET", "/api/proxies", auth());
  const found = JSON.parse(list.body).proxies.find((item) => item.id === created.id);
  expect(found.score).toBe(null);
});

test("validates every field with clear JSON errors", async () => {
  const cases = [
    [{ name: "", type: "http", host: "127.0.0.1", port: 8080 }, "invalid_name"],
    [{ name: "x".repeat(81), type: "http", host: "127.0.0.1", port: 8080 }, "invalid_name"],
    [{ name: "ok", type: "ftp", host: "127.0.0.1", port: 8080 }, "invalid_type"],
    [{ name: "ok", type: "http", host: "", port: 8080 }, "invalid_host"],
    [{ name: "ok", type: "http", host: "bad\u0000host", port: 8080 }, "invalid_host"],
    [{ name: "ok", type: "http", host: "bad host", port: 8080 }, "invalid_host"],
    [{ name: "ok", type: "http", host: "h".repeat(256), port: 8080 }, "invalid_host"],
    [{ name: "ok", type: "http", host: "127.0.0.1", port: 0 }, "invalid_port"],
    [{ name: "ok", type: "http", host: "127.0.0.1", port: 65536 }, "invalid_port"],
    [{ name: "ok", type: "http", host: "127.0.0.1", port: "80x" }, "invalid_port"],
    [{ name: "ok", type: "http", host: "127.0.0.1", port: 8080, username: "u".repeat(256) }, "invalid_username"],
    [{ name: "ok", type: "http", host: "127.0.0.1", port: 8080, password: "p".repeat(256) }, "invalid_password"],
  ];
  for (const [payload, code] of cases) {
    const response = await raw("POST", "/api/proxies", jsonHeaders(), JSON.stringify(payload));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe(code);
  }
  const malformed = await raw("POST", "/api/proxies", jsonHeaders(), "{");
  expect(malformed.status).toBe(400);
  expect(JSON.parse(malformed.body).error).toBe("invalid_json");
  const existing = await createProxy({ name: "Validation target" });
  const noFields = await raw("PATCH", `/api/proxies/${existing.id}`, jsonHeaders(), "{}");
  expect(noFields.status).toBe(400);
  expect(JSON.parse(noFields.body).error).toBe("invalid_body");
});

test("generates unique ids even when the client sends one", async () => {
  const first = await createProxy({ name: "Unique one", id: "same" });
  const second = await createProxy({ name: "Unique two", id: "same" });
  expect(first.id).not.toBe(second.id);
});

test("deletes a proxy and returns 404 afterwards", async () => {
  const created = await createProxy({ name: "Delete me" });
  const response = await raw("DELETE", `/api/proxies/${created.id}`, auth());
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ ok: true, id: created.id });
  const list = await raw("GET", "/api/proxies", auth());
  expect(JSON.parse(list.body).proxies.some((item) => item.id === created.id)).toBe(false);
  const again = await raw("DELETE", `/api/proxies/${created.id}`, auth());
  expect(again.status).toBe(404);
});

test("protects the new routes with token, Host and Origin", async () => {
  const noToken = await raw("GET", "/api/proxies");
  expect(noToken.status).toBe(403);
  expect(JSON.parse(noToken.body).reload).toBe(true);
  const evilOrigin = await raw("POST", "/api/proxies", {
    origin: "https://evil.example",
    ...jsonHeaders(),
  }, JSON.stringify({ name: "x", type: "http", host: "h", port: 1 }));
  expect(evilOrigin.status).toBe(403);
  const badHost = await raw("GET", "/api/proxies", {
    host: "evil.example",
    ...auth(),
  });
  expect(badHost.status).toBe(403);
});

test("tests a real HTTP proxy and stores the exit IP, region and latency", async () => {
  const created = await createProxy({ name: "Working proxy" });
  const response = await raw("POST", `/api/proxies/${created.id}/test`, auth());
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.ok).toBe(true);
  expect(body.result.exitIp).toBe("203.0.113.10");
  expect(body.result.region).toBe("Testland");
  expect(body.result.latency).toBeGreaterThanOrEqual(0);
  expect(body.proxy.status).toBe("ok");
  expect(body.proxy.exitIp).toBe("203.0.113.10");
  expect(body.proxy.region).toBe("Testland");
  expect(body.proxy.hasPassword).toBe(true);
  expect(response.body).not.toContain("s3cret");
  expect(response.body).not.toContain("password");

  const list = await raw("GET", "/api/proxies", auth());
  const stored = JSON.parse(list.body).proxies.find((item) => item.id === created.id);
  expect(stored.status).toBe("ok");
  expect(stored.lastCheckedAt).toBeTruthy();
});

test("a failing proxy stores an honest, safe error", async () => {
  const created = await createProxy({ name: "Failing proxy", port: authProxy.port });
  const response = await raw("POST", `/api/proxies/${created.id}/test`, auth());
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.ok).toBe(false);
  expect(body.result.errorCode).toBe("proxy_auth");
  expect(body.result.error).toBe("Proxy authentication failed.");
  expect(body.proxy.status).toBe("error");
  expect(body.proxy.error).toBe("Proxy authentication failed.");
  expect(body.proxy.latency).toBe(null);
  expect(body.proxy.exitIp).toBe("");
  expect(response.body).not.toContain("s3cret");
  expect(response.body).not.toContain("password");
});

test("draft tests do not create a proxy", async () => {
  const before = JSON.parse((await raw("GET", "/api/proxies", auth())).body).proxies.length;
  const response = await raw(
    "POST",
    "/api/proxies/test",
    jsonHeaders(),
    JSON.stringify({
      name: "Draft",
      type: "http",
      host: "127.0.0.1",
      port: okProxy.port,
      username: "alice",
      password: "s3cret",
    }),
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).ok).toBe(true);
  expect(response.body).not.toContain("s3cret");
  const after = JSON.parse((await raw("GET", "/api/proxies", auth())).body).proxies.length;
  expect(after).toBe(before);
});

test("an edit during a test cannot apply the stale result", async () => {
  const created = await createProxy({ name: "Stale edit", port: delayProxy.port });
  const testing = raw("POST", `/api/proxies/${created.id}/test`, auth());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const edited = await raw(
    "PATCH",
    `/api/proxies/${created.id}`,
    jsonHeaders(),
    JSON.stringify({ port: okProxy.port }),
  );
  expect(edited.status).toBe(200);
  const result = JSON.parse((await testing).body);
  expect(result.persisted).toBe(false);
  const list = await raw("GET", "/api/proxies", auth());
  const stored = JSON.parse(list.body).proxies.find((item) => item.id === created.id);
  expect(stored.status).toBe("untested");
  expect(stored.region).toBe("");
});

test("a delete during a test cannot resurrect the row", async () => {
  const created = await createProxy({ name: "Stale delete", port: delayProxy.port });
  const testing = raw("POST", `/api/proxies/${created.id}/test`, auth());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const deleted = await raw("DELETE", `/api/proxies/${created.id}`, auth());
  expect(deleted.status).toBe(200);
  const result = JSON.parse((await testing).body);
  expect(result.persisted).toBe(false);
  const list = await raw("GET", "/api/proxies", auth());
  expect(JSON.parse(list.body).proxies.some((item) => item.id === created.id)).toBe(false);
});

test("writes atomically with private modes and no temp files", async () => {
  await createProxy({ name: "Modes proxy" });
  const files = readdirSync(dataDir);
  expect(files).toContain("proxies.json");
  expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  if (process.platform !== "win32") {
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "proxies.json")).mode & 0o777).toBe(0o600);
  }
});

test("persists across a server restart and still redacts the password", async () => {
  const created = await createProxy({ name: "Restart proxy", password: "restart-secret" });
  await service.close();
  const { startServer } = await import("../lib/server.mjs");
  service = await startServer({
    port: 0,
    dataDir,
    env: serverEnv,
    proxyEndpoint: "http://127.0.0.1:1/ip",
  });
  port = service.port;
  await refreshToken();

  const list = await raw("GET", "/api/proxies", auth());
  expect(list.status).toBe(200);
  const found = JSON.parse(list.body).proxies.find((item) => item.id === created.id);
  expect(found).toBeTruthy();
  expect(found.hasPassword).toBe(true);
  expect(found.name).toBe("Restart proxy");
  expect(list.body).not.toContain("restart-secret");
  expect(list.body).not.toContain("password");

  const bootstrap = await raw("GET", "/api/bootstrap", auth());
  expect(JSON.parse(bootstrap.body).proxies.some((item) => item.id === created.id)).toBe(true);
  const stored = JSON.parse(readFileSync(join(dataDir, "proxies.json"), "utf8"));
  expect(stored.proxies.find((item) => item.id === created.id).password).toBe("restart-secret");
});

test("the package directory is not used for data", () => {
  expect(existsSync(join(root, "proxies.json"))).toBe(false);
  expect(dataDir.startsWith(root)).toBe(false);
});
