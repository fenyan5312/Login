import { afterAll, beforeAll, expect, test } from "bun:test";
import { request } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Read the version instead of pinning it here: the suite should not need an
// edit every time the package is released.
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tmp = mkdtempSync(join(tmpdir(), "clean-login-"));
let service;
let port;
let token;
let tokenHeader;

// Injected so the suite never imports a provider plugin and never spawns a
// child process. It reports one installed plugin entry that matches magpie's
// `brand-new` provider and exposes a browser method.
const pluginScanner = {
  get: () => ({
    available: true,
    providers: [
      {
        id: "brand-new",
        package: "@magpie-community/opencode-brand-new-auth",
        methods: [
          { type: "oauth", label: "Brand New (browser)", browser: true, category: "browser", runnable: true },
          { type: "oauth", label: "brand-new CLI's sign-in", browser: false, category: "local", runnable: true },
          { type: "api", label: "Brand New API key", browser: false, category: "key", runnable: false },
        ],
      },
    ],
    scanned: true,
    stale: false,
    scanning: false,
    error: null,
  }),
  warm: () => {},
};

beforeAll(async () => {
  const { startServer, TOKEN_HEADER } = await import("../lib/server.mjs");
  tokenHeader = TOKEN_HEADER;
  service = await startServer({
    port: 0,
    dataDir: join(tmp, "data"),
    // Keep both the plugin data directory and magpie's config directory inside
    // the temp root, so the startup orphan sweep never reads or writes the
    // real ~/.config/magpie.
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(tmp, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: join(tmp, "data"),
    },
    pluginScanner,
  });
  port = service.port;
  // The startup sweep is fire-and-forget; wait for it so the health assertion
  // below is not racing it.
  await service.prune();
  const page = await raw("GET", "/");
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(page.body)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

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
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const auth = () => ({ "x-clean-login-token": token });

// ---------- the Host side ----------

test("serves the UI with a per-process token", () => {
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});

test("refuses API calls without the page token", async () => {
  for (const path of ["/api/health", "/api/bootstrap", "/api/providers"]) {
    const res = await raw("GET", path);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).reload).toBe(true);
  }
});

test("bootstrap returns the Host-driven shape with the public provider registry", async () => {
  const res = await raw("GET", "/api/bootstrap", auth());
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.version).toBe(pkgVersion);
  expect(body.service).toEqual({ status: "ready" });
  expect(body.providers.map((provider) => provider.id)).toEqual([
    "antigravity",
    "codex",
    "claude",
  ]);
  for (const provider of body.providers) {
    expect(provider.capability.state).not.toBe("ready");
    expect(provider.capability.reason.en).toBeTruthy();
    expect(provider.clientSecret).toBeUndefined();
    expect(provider.clientId).toBeUndefined();
    expect(provider.token).toBeUndefined();
  }
  expect(body.proxies).toEqual([]);
  // No data directory or other host paths leak through the API.
  expect(body.dataDir).toBeUndefined();
  expect(res.body).not.toContain(tmp);
});

test("/api/providers is token-protected and returns the same public capabilities", async () => {
  const res = await raw("GET", "/api/providers", auth());
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  const bootstrap = JSON.parse((await raw("GET", "/api/bootstrap", auth())).body);
  expect(body.providers).toEqual(bootstrap.providers);
  expect(res.body).not.toMatch(/client[_-]?secret|client[_-]?id|access[_-]?token|refresh[_-]?token|api[_-]?key|password/i);
});

test("/api/provider-sources merges magpie's list and reports the source", async () => {
  const res = await raw(
    "POST",
    "/api/provider-sources",
    { ...auth(), "content-type": "application/json" },
    JSON.stringify({ magpie: { v: 1, ok: true, value: ["codex", "brand-new"] } }),
  );
  expect(res.status).toBe(200);
  const view = JSON.parse(res.body).providerSources;
  expect(view.source).toBe("magpie");
  expect(view.magpie).toEqual({ available: true, count: 2 });
  expect(view.counts).toEqual({ total: 4, both: 1, localOnly: 2, magpieOnly: 1, pluginOnly: 0 });
  const byId = Object.fromEntries(view.providers.map((provider) => [provider.id, provider]));
  expect(byId.codex.presence).toBe("both");
  expect(byId.antigravity.presence).toBe("local-only");
  expect(byId.claude.presence).toBe("local-only");
  expect(byId["brand-new"].presence).toBe("magpie-only");
  expect(byId["brand-new"].sources).toEqual({ local: false, magpie: true });
  expect(res.body).not.toMatch(/client[_-]?secret|access[_-]?token|api[_-]?key|password/i);
});

test("/api/provider-sources degrades to the local registry without a magpie payload", async () => {
  for (const body of [undefined, JSON.stringify({}), JSON.stringify({ magpie: null })]) {
    const res = await raw(
      "POST",
      "/api/provider-sources",
      { ...auth(), "content-type": "application/json" },
      body,
    );
    expect(res.status).toBe(200);
    const view = JSON.parse(res.body).providerSources;
    expect(view.source).toBe("local");
    expect(view.magpie.available).toBe(false);
    for (const provider of view.providers) expect(provider.presence).toBe("local-unknown");
  }
});

test("/api/provider-sources reports the injected plugin scan and its derived methods", async () => {
  const res = await raw(
    "POST",
    "/api/provider-sources",
    { ...auth(), "content-type": "application/json" },
    JSON.stringify({ magpie: { v: 1, ok: true, value: ["codex", "brand-new"] } }),
  );
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.pluginScan).toEqual({
    available: true,
    count: 1,
    scanned: true,
    stale: false,
    scanning: false,
    error: null,
  });
  const byId = Object.fromEntries(body.providerSources.providers.map((provider) => [provider.id, provider]));
  expect(byId["brand-new"].presence).toBe("magpie-only");
  expect(byId["brand-new"].browserMethod).toBe(true);
  expect(byId["brand-new"].signInProvider).toBe("brand-new");
  expect(byId["brand-new"].authMethods).toEqual([
    { type: "oauth", label: "Brand New (browser)", browser: true, category: "browser", prompts: [], runnable: true },
    { type: "oauth", label: "brand-new CLI's sign-in", browser: false, category: "local", prompts: [], runnable: true },
    { type: "api", label: "Brand New API key", browser: false, category: "key", prompts: [], runnable: false },
  ]);
  expect(byId["brand-new"].capability.reason.en).toContain("has not verified");
  // The response still carries no button wording and no authorize function.
  expect(res.body).not.toMatch(/Add Account|authorize/i);
});

test("/api/provider-sources is token-protected", async () => {
  const res = await raw("POST", "/api/provider-sources", {}, JSON.stringify({ magpie: [] }));
  expect(res.status).toBe(403);
});

test("health stays a secretless liveness probe", async () => {
  const res = await raw("GET", "/api/health", auth());
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.ok).toBe(true);
  expect(body.version).toBe(pkgVersion);
  expect(body.dataDir).toBeUndefined();
  // The most recent orphan sweep is reported as counts and a short skip
  // reason; no account key, provider or path leaks through health.
  expect(body.accounts).toEqual({
    ran: true,
    // `kept` and `retired` are read now, not taken from the sweep's report.
    kept: 0,
    retired: 0,
    // No directory carries an ownership ledger in this temp data directory.
    live: true,
    pruned: 0,
    skippedLive: 0,
    failed: 0,
    // The temp MAGPIE_CONFIG_DIR has no plugin-auth.json, so a live count
    // cannot tell signed-in from signed-out accounts…
    // (the live counts above stay 0 because no account directory exists)
    skipped: "auth_missing",
    sweptAt: expect.any(String),
  });
  expect(res.body).not.toContain(tmp);
});

// The point of reading the counts at request time: a sign-out between two
// sweeps must show up immediately, instead of waiting for the next sweep (or a
// restart) to move the number.
test("health counts accounts now, not at the last sweep", async () => {
  const { writeAccountMeta } = await import("../lib/account-identity.mjs");
  const config = join(tmp, "magpie-config");
  const authFile = join(config, "plugin-auth.json");
  const key = "health-probe";
  const dir = join(tmp, "data", "accounts", key, key);
  await mkdir(dir, { recursive: true });
  await mkdir(config, { recursive: true });
  await writeAccountMeta(dir, {
    version: 1,
    provider: key,
    key,
    accountId: "Health Probe",
    uid: "uid-health",
    signedInAt: null,
  });

  // Signed in: the key is in the auth file.
  await writeFile(authFile, JSON.stringify({ [key]: { type: "oauth", accountId: "Health Probe", uid: "uid-health" } }));
  let body = JSON.parse((await raw("GET", "/api/health", auth())).body);
  expect(body.accounts.live).toBe(true);
  expect(body.accounts.kept).toBe(1);
  expect(body.accounts.retired).toBe(0);

  // Signed out: the key is gone from the auth file. No sweep runs here, so
  // the flipped numbers can only come from reading the state at request time.
  await writeFile(authFile, JSON.stringify({}));
  body = JSON.parse((await raw("GET", "/api/health", auth())).body);
  expect(body.accounts.live).toBe(true);
  expect(body.accounts.kept).toBe(0);
  expect(body.accounts.retired).toBe(1);

  // Signed in again: the same directory moves back, still without a sweep.
  await writeFile(authFile, JSON.stringify({ [key]: { type: "oauth", accountId: "Health Probe", uid: "uid-health" } }));
  body = JSON.parse((await raw("GET", "/api/health", auth())).body);
  expect(body.accounts.kept).toBe(1);
  expect(body.accounts.retired).toBe(0);

  // Leave the temp tree exactly as the earlier tests found it: the next test
  // expects no plugin-auth.json at all (`skipped: "auth_missing"`) and no
  // `accounts/` root left behind.
  rmSync(join(tmp, "data", "accounts"), { recursive: true, force: true });
  rmSync(authFile, { force: true });
});

test("POST /api/accounts/prune runs the orphan sweep and returns its report", async () => {
  const res = await raw("POST", "/api/accounts/prune", auth());
  expect(res.status).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.report).toEqual({
    removed: [],
    kept: [],
    retired: [],
    skippedLive: [],
    failed: [],
    skipped: "auth_missing",
  });
});

test("POST /api/accounts/prune is token-protected and rejects other methods", async () => {
  const anonymous = await raw("POST", "/api/accounts/prune");
  expect(anonymous.status).toBe(403);
  const wrongMethod = await raw("GET", "/api/accounts/prune", auth());
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.allow).toBe("POST");
});

// ---------- the trust-score browser directory ----------
//
// The scoring browser keeps its own persistent identity. It must NOT live
// under `accounts/`, because the startup orphan sweep removes every account
// directory whose key is not in plugin-auth.json -- which would delete the
// pinned fingerprint (and the profile) on the next service start.

test("the scoring browser directory survives the account orphan sweep", async () => {
  const dataDir = join(tmp, "data");
  const scoreDir = join(dataDir, "score-browser", "profile");
  await mkdir(scoreDir, { recursive: true });
  await writeFile(join(scoreDir, "marker.txt"), "keep me");
  const report = await raw("POST", "/api/accounts/prune", auth());
  expect(report.status).toBe(200);
  expect(existsSync(join(scoreDir, "marker.txt"))).toBe(true);
  // It is not an account directory at all.
  expect(existsSync(join(dataDir, "accounts"))).toBe(false);
});

test("refuses another site's Origin even with the token", async () => {
  const res = await raw("GET", "/api/bootstrap", {
    origin: "https://evil.example",
    ...auth(),
  });
  expect(res.status).toBe(403);
  // A refused Origin must not receive any CORS header either.
  for (const key of Object.keys(res.headers)) {
    expect(key.startsWith("access-control-")).toBe(false);
  }
});

// ---------- sandbox (opaque-origin) CORS ----------
//
// magpie loads this UI in <iframe sandbox="allow-scripts">, which the browser
// treats as an opaque origin: the app module and every fetch are cross-origin
// with `Origin: null`. Without these headers the UI never boots.

test("preflight OPTIONS /api/bootstrap is answered before the token gate", async () => {
  const res = await raw("OPTIONS", "/api/bootstrap", {
    origin: "null",
    "access-control-request-method": "GET",
    "access-control-request-headers": `${tokenHeader}, content-type`,
  });
  expect(res.status).toBe(204);
  expect(res.headers["access-control-allow-origin"]).toBe("null");
  expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, DELETE");
  expect(res.headers["access-control-allow-headers"]).toBe(`${tokenHeader}, content-type`);
  expect(res.headers.vary).toBe("Origin");
});

test("a foreign-Origin preflight is still refused and gets no CORS headers", async () => {
  const res = await raw("OPTIONS", "/api/bootstrap", {
    origin: "https://evil.example",
    "access-control-request-method": "GET",
  });
  expect(res.status).toBe(403);
  for (const key of Object.keys(res.headers)) {
    expect(key.startsWith("access-control-")).toBe(false);
  }
});

test("bootstrap echoes an opaque Origin and varies on it", async () => {
  const res = await raw("GET", "/api/bootstrap", { origin: "null", ...auth() });
  expect(res.status).toBe(200);
  expect(res.headers["access-control-allow-origin"]).toBe("null");
  expect(res.headers.vary).toBe("Origin");
});

test("the UI modules are readable from an opaque origin", async () => {
  for (const path of [
    "/app.js",
    "/account-state.js",
    "/reload-guard.js",
    "/provider-state.js",
    "/proxy-state.js",
    "/environment-state.js",
    "/style.css",
    "/assets/icon.svg",
  ]) {
    const res = await raw("GET", path, { origin: "null" });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("null");
    expect(res.headers.vary).toBe("Origin");
  }
});

test("assets without an Origin fall back to a wildcard CORS header", async () => {
  const res = await raw("GET", "/app.js");
  expect(res.status).toBe(200);
  expect(res.headers["access-control-allow-origin"]).toBe("*");
  expect(res.headers.vary).toBe("Origin");
});

test("the token-bearing HTML document is never CORS-readable", async () => {
  for (const path of ["/", "/index.html"]) {
    const res = await raw("GET", path, { origin: "null" });
    expect(res.status).toBe(200);
    for (const key of Object.keys(res.headers)) {
      expect(key.startsWith("access-control-")).toBe(false);
    }
  }
});

test("refuses a DNS-rebound Host", async () => {
  const res = await raw("GET", "/", { host: "evil.example" });
  expect(res.status).toBe(403);
});

test("does not serve files outside the UI folders", async () => {
  for (const path of ["/..%2Fpackage.json", "/assets/..%2F..%2Fpackage.json", "/%2e%2e/package.json"]) {
    const res = await raw("GET", path);
    expect(res.status).toBe(404);
  }
});

// ---------- the UI is served, not leaked ----------

test("the UI is served with the token placeholder replaced", async () => {
  const res = await raw("GET", "/");
  expect(res.status).toBe(200);
  expect(res.body).toContain(`content="${token}"`);
  expect(res.body).not.toContain("__CLEAN_LOGIN_TOKEN__");
});

test("static assets carry no token and no placeholder", async () => {
  for (const path of ["/app.js", "/style.css", "/assets/icon.svg"]) {
    const res = await raw("GET", path);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain("__CLEAN_LOGIN_TOKEN__");
  }
});

test("the UI is genuinely Host-driven", () => {
  const app = readFileSync(join(root, "ui", "app.js"), "utf8");
  expect(app).toContain('api("api/bootstrap")');
  expect(app).toContain("fetch(path");
  expect(app).toContain('meta[name="clean-login-token"]');
  expect(app).toContain("x-clean-login-token");
  // No mock data and no unshipped actions.
  expect(app).not.toMatch(/innerHTML/);
  expect(app).not.toMatch(/\bmock\b|simulat|preview|example\.com|data-add/i);
});

test("static files exist and carry no mock data or dead action buttons", () => {
  for (const file of ["ui/index.html", "ui/style.css", "ui/app.js", "ui/account-state.js", "ui/account-view.js", "ui/proxy-state.js", "ui/provider-state.js", "ui/signin-state.js", "lib/provider-registry.mjs"]) {
    expect(existsSync(join(root, file))).toBe(true);
  }
  const html = readFileSync(join(root, "ui", "index.html"), "utf8");
  // Three tabs, the one-time browser setup, the proxy dialog, delete
  // confirmation, the add-account dialog, and the accounts page v2 toolbar,
  // filter chips and both account dialogs. Every button is wired in app.js.
  const buttonIds = [
    "tab-providers",
    "tab-proxies",
    "tab-accounts",
    "retry",
    "add-proxy",
    "add-proxy-empty",
    "environment-prepare",
    "environment-cancel",
    "environment-retry",
    "filter-reset",
    "score-cancel",
    "proxy-close",
    "test-proxy",
    "proxy-cancel",
    "save-proxy",
    "confirm-close",
    "confirm-cancel",
    "confirm-action",
    "signin-close",
    "signin-cancel",
    "signin-close-footer",
    "signin-start",
    "signin-complete",
    "identities-retry",
    "accounts-refresh",
    "account-filter-all",
    "account-filter-signed-in",
    "account-filter-signed-out",
    "account-detail-close",
    "account-detail-dismiss",
    "account-detail-check",
    "account-detail-note-save",
    "account-check-close",
    "account-check-dismiss",
    "account-check-cancel",
    "account-check-reexit",
    "account-check-details",
    "account-check-change-exit",
    "account-check-start",
    "account-check-again",
    "account-check-retry",
    "report-close",
    "report-cancel",
    "report-copy-body",
    "report-open",
    "import-credential",
    "import-close",
    "import-cancel",
    "import-submit",
  ];
  expect((html.match(/<button\b/g) || []).length).toBe(buttonIds.length);
  for (const id of buttonIds) expect(html).toContain(`id="${id}"`);
  expect(html).not.toMatch(/preview-badge|data-add|account-menu|mock/i);
  // The provider grid and its empty state stay an honest empty state with no
  // dead action; the browser setup card above them owns its own wired
  // buttons.
  const providerArea = /<div class="empty" id="providers-empty">[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  expect(providerArea).toContain('id="providers-list"');
  expect(providerArea).not.toContain("<button");
  // The proxy dialog has the fields the API accepts and never fills the
  // password back in.
  for (const id of [
    "proxy-name",
    "proxy-type",
    "proxy-host",
    "proxy-port",
    "proxy-username",
    "proxy-password",
    "proxy-test-result",
    "proxy-form-error",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain('type="password"');
  expect(html).toContain('id="confirm-dialog"');
  const app = readFileSync(join(root, "ui", "app.js"), "utf8");
  const importUi = readFileSync(join(root, "ui", "import.js"), "utf8");
  for (const id of buttonIds.filter((id) => id !== "save-proxy")) {
    // The paste-credential dialog is a separate module and owns its buttons.
    if (id.startsWith("import-")) {
      expect(importUi).toContain(`byId("${id}")`);
      continue;
    }
    expect(app).toContain(`byId("${id}").addEventListener`);
  }
  expect(app).toContain('byId("proxy-form").addEventListener("submit"');
  expect(app).toContain("createConfirmController");
  expect(app).toContain("createRequestGuard");
});

// ---------- the startServer data seam ----------
//
// startServer({ env }) must isolate the proxy store too. The default used to
// read process.env, so a caller that passed an isolated env still wrote into
// the real ~/.config/magpie/magpie-clean-login. These tests rebuild that trap
// with temporary directories and never touch the real home.

const seamScanner = {
  get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
  warm: () => {},
};

function snapshotEnv() {
  return {
    MAGPIE_CONFIG_DIR: process.env.MAGPIE_CONFIG_DIR,
    MAGPIE_CLEAN_LOGIN_DATA: process.env.MAGPIE_CLEAN_LOGIN_DATA,
  };
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const seamProxy = { name: "probe", type: "http", host: "127.0.0.1", port: 8080, username: "", password: "" };

test("startServer({ env }) defaults dataDir to the caller's env, not process.env", async () => {
  const { startServer } = await import("../lib/server.mjs");
  const envRoot = mkdtempSync(join(tmpdir(), "clean-login-env-"));
  const realConfig = mkdtempSync(join(tmpdir(), "clean-login-real-"));
  const isolatedData = join(envRoot, "data");
  const previous = snapshotEnv();
  // Point process.env at the "real" config root. The buggy default would
  // write the store there even though the caller passed its own env.
  process.env.MAGPIE_CONFIG_DIR = realConfig;
  delete process.env.MAGPIE_CLEAN_LOGIN_DATA;
  let service;
  try {
    service = await startServer({
      port: 0,
      env: {
        ...process.env,
        MAGPIE_CONFIG_DIR: envRoot,
        MAGPIE_CLEAN_LOGIN_DATA: isolatedData,
      },
      pluginScanner: seamScanner,
    });
    expect(service.dataDir).toBe(isolatedData);
    await service.prune();
    await service.store.create(seamProxy);
    expect(existsSync(join(isolatedData, "proxies.json"))).toBe(true);
    // The real config root must stay empty: no magpie-clean-login directory,
    // no proxies.json.
    expect(readdirSync(realConfig)).toEqual([]);
  } finally {
    await service?.close();
    restoreEnv(previous);
    rmSync(envRoot, { recursive: true, force: true });
    rmSync(realConfig, { recursive: true, force: true });
  }
});

test("an explicit dataDir still wins over env", async () => {
  const { startServer } = await import("../lib/server.mjs");
  const rootDir = mkdtempSync(join(tmpdir(), "clean-login-explicit-"));
  const explicit = join(rootDir, "explicit");
  const envData = join(rootDir, "env-data");
  const previous = snapshotEnv();
  let service;
  try {
    service = await startServer({
      port: 0,
      dataDir: explicit,
      env: {
        ...process.env,
        MAGPIE_CONFIG_DIR: rootDir,
        MAGPIE_CLEAN_LOGIN_DATA: envData,
      },
      pluginScanner: seamScanner,
    });
    expect(service.dataDir).toBe(explicit);
    await service.prune();
    await service.store.create(seamProxy);
    expect(existsSync(join(explicit, "proxies.json"))).toBe(true);
    expect(existsSync(envData)).toBe(false);
  } finally {
    await service?.close();
    restoreEnv(previous);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------- the launcher ----------

test("page/boot.js uses magpie.ready/options/service and does not fetch", () => {
  const boot = readFileSync(join(root, "page", "boot.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  expect(boot).toContain("magpie?.ready");
  expect(boot).toContain("magpie?.options");
  expect(boot).toContain("magpie?.service");
  expect(boot).toContain("location.replace");
  expect(boot).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/);
});

// Run page/boot.js the way the sandboxed frame runs it: with a fake window
// and location, and timers that do not keep the test process alive.
async function runBoot(magpie, { hostname = "127.0.0.1", search = "", dom, timers } = {}) {
  const src = readFileSync(join(root, "page", "boot.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
  let went = "";
  const location = {
    hostname,
    href: `http://${hostname}/`,
    search,
    replace: (url) => { went = url; },
    reload: () => {},
  };
  const win = {
    magpie,
    setTimeout: timers?.setTimeout || (() => 1),
    clearTimeout: timers?.clearTimeout || (() => {}),
    addEventListener: () => {},
  };
  const document = dom || {
    documentElement: {},
    title: "",
    getElementById: () => null,
    createElement: () => ({ addEventListener() {} }),
  };
  await new Function("window", "location", "document", "return " + src)(win, location, document);
  return { went, document };
}

test("the launcher goes to the service with theme and language preserved", async () => {
  const ready = Promise.resolve({ dark: true, lang: "ja" });
  const options = { get: async () => ({ port: 3999 }) };
  const { went } = await runBoot({ ready, options, service: "" });
  const url = new URL(went);
  expect(url.origin).toBe("http://127.0.0.1:3999");
  expect(url.searchParams.get("theme")).toBe("dark");
  expect(url.searchParams.get("lang")).toBe("ja");
});

test("the launcher follows magpie.service for remote frames", async () => {
  const ready = Promise.resolve({ dark: false, lang: "zh-Hant" });
  const options = { get: async () => ({ port: 3999 }) };
  const svc = "http://server.lan:3430/_magpie/plugin/aaaa/_magpie/service/";
  const { went } = await runBoot({ ready, options, service: svc }, { hostname: "server.lan" });
  expect(went.startsWith(svc)).toBe(true);
  const url = new URL(went);
  expect(url.searchParams.get("theme")).toBe("light");
  expect(url.searchParams.get("lang")).toBe("zh-Hant");
});

test("without a bridge the launcher still reaches the default port", async () => {
  const { went } = await runBoot(undefined, { hostname: "127.0.0.1" });
  expect(new URL(went).origin).toBe("http://127.0.0.1:3492");
});

test("a remote frame without magpie.service gets a clear local message, not a refused port", async () => {
  const writes = {};
  const dom = {
    documentElement: {},
    title: "",
    getElementById: (id) => {
      if (id === "title") return { set textContent(value) { writes.title = value; } };
      if (id === "status") return { set textContent(value) { writes.status = value; }, after() {} };
      return null;
    },
    createElement: () => ({ addEventListener() {} }),
  };
  const { went } = await runBoot({ ready: Promise.resolve({ dark: false }) }, { hostname: "server.lan", dom });
  expect(went).toBe("");
  expect(writes.status).toMatch(/only on the computer/);
});

// The provider read must never block navigation. Every failure mode still
// lands on the loopback service with an ok:false envelope in the hash.
function providerEnvelope(went) {
  const hash = String(went).split("#")[1] || "";
  return JSON.parse(new URLSearchParams(hash).get("providers"));
}

test("boot carries a good providers:list read through the hash fragment", async () => {
  const magpie = {
    ready: Promise.resolve({ dark: false, lang: "en" }),
    options: { get: async () => ({ port: 3999 }) },
    read: async (name) => {
      expect(name).toBe("providers:list");
      return ["codex", { id: "mystery-ai", name: "Mystery AI" }];
    },
  };
  const { went } = await runBoot(magpie);
  expect(providerEnvelope(went)).toEqual({
    v: 1,
    ok: true,
    value: ["codex", { id: "mystery-ai", name: "Mystery AI" }],
  });
});

test("boot keeps navigating when the bridge has no read", async () => {
  const { went } = await runBoot({ ready: Promise.resolve({ dark: false }) });
  expect(new URL(went).origin).toBe("http://127.0.0.1:3492");
  expect(providerEnvelope(went)).toEqual({ v: 1, ok: false });
});

test("boot keeps navigating when providers:list throws", async () => {
  const magpie = {
    ready: Promise.resolve({ dark: false }),
    options: { get: async () => ({}) },
    read: async () => { throw new Error("boom"); },
  };
  const { went } = await runBoot(magpie);
  expect(providerEnvelope(went)).toEqual({ v: 1, ok: false });
});

test("boot forwards an empty providers:list instead of treating it as a failure", async () => {
  const magpie = {
    ready: Promise.resolve({ dark: false }),
    options: { get: async () => ({}) },
    read: async () => [],
  };
  const { went } = await runBoot(magpie);
  expect(providerEnvelope(went)).toEqual({ v: 1, ok: true, value: [] });
});

test("boot times out a hanging providers:list and still navigates", async () => {
  const magpie = {
    ready: Promise.resolve({ dark: false }),
    options: { get: async () => ({}) },
    read: () => new Promise(() => {}),
  };
  const timers = {
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout: () => {},
  };
  const { went } = await runBoot(magpie, { timers });
  expect(providerEnvelope(went)).toEqual({ v: 1, ok: false });
});
