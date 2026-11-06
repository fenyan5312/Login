import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDataDir } from "./paths.mjs";
import {
  createProxyStore,
  publicProxy,
  validateCreate,
  validateProbe,
  validateUpdate,
  ProxyInputError,
} from "./proxies.mjs";
import { testProxy } from "./proxy-test.mjs";
import { listProviders } from "./provider-registry.mjs";
import { mergeProviderSources } from "./provider-sources.mjs";
import { createPluginScanner } from "./magpie-plugins.mjs";
import { buildIssueRequest, isAllowedIssueUrl } from "./issue-report.mjs";
import { openExternal, OpenExternalError } from "./open-external.mjs";
import { createEnvironmentManager, EnvironmentError } from "./browser-environment.mjs";
import { createSignInFlow, SignInFlowError } from "./signin-flow.mjs";
import { SignInBrowserError } from "./browser-launcher.mjs";
import { createProxyScore, ProxyScoreError } from "./proxy-score.mjs";
import {
  AccountRecordError,
  accountExtras,
  loginSnapshot,
  normalizeNote,
  withCheck,
  withLogin,
  withNote,
} from "./account-records.mjs";
import { readAuthEntries, signInKey, writeBack } from "./signin-writeback.mjs";
import { ImportError, prepareImport } from "./import-credential.mjs";
import { prepareGenericImport, readAuthSecrets } from "./import-generic.mjs";
import { readFingerprintSummary } from "./account-summary.mjs";
import { IdentityCheckError, createIdentityCheck, idleCheckJob } from "./identity-check.mjs";
import { emptyPruneReport, pruneOrphanAccounts } from "./account-prune.mjs";
import { readAuthKeysResult } from "./account-keys.mjs";
import {
  accountDir,
  listAccountDirsWithMeta,
  readAccountMeta,
  removeAccountDir,
  writeAccountMeta,
} from "./account-identity.mjs";
import { createAccountProxySync } from "./account-proxies.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = normalize(join(HERE, ".."));
const UI_ROOT = join(PACKAGE_ROOT, "ui");
const ASSET_ROOT = join(PACKAGE_ROOT, "assets");
const TOKEN_HEADER = "x-clean-login-token";
const TOKEN_PLACEHOLDER = "__CLEAN_LOGIN_TOKEN__";
const MAX_BODY = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

let version = "0.0.0";
try {
  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  version = pkg.version || version;
} catch {
  // The package metadata is shipped beside the service. A missing version
  // should not stop the page from loading.
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function inside(root, path) {
  const full = normalize(join(root, path));
  return full === root || full.startsWith(root + sep);
}

function tokenMatches(got, want) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originAllowed(origin, ownOrigins) {
  return origin === undefined || origin === "null" || ownOrigins.has(origin);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    allow,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "method_not_allowed", message: "Method not allowed." }));
}

// magpie embeds this UI in <iframe sandbox="allow-scripts"> with no
// allow-same-origin, so the document has an opaque origin and every module
// fetch and API call is cross-origin (with `Origin: null`). Echo the caller's
// Origin, or `*` when the caller sent none, and vary on it. This only ever
// makes an already-allowed response readable; the foreign-Origin gate below
// still runs first and rejects other sites with a bare 403.
function applyCors(res, origin) {
  res.setHeader("access-control-allow-origin", origin ?? "*");
  res.setHeader("vary", "Origin");
}

async function readJson(req, { optional = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new HttpError(413, "payload_too_large", "Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (!size) {
    if (optional) return null;
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function sendError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (
    error instanceof ProxyInputError ||
    error instanceof HttpError ||
    error instanceof EnvironmentError ||
    error instanceof SignInFlowError ||
    error instanceof SignInBrowserError ||
    error instanceof ProxyScoreError ||
    error instanceof AccountRecordError ||
    error instanceof IdentityCheckError ||
    error instanceof OpenExternalError
  ) {
    json(res, error.status, { error: error.code, message: error.message });
    return;
  }
  // Deliberately do not log request bodies or error stacks: proxy credentials
  // travel through this service and must never reach a log line.
  json(res, 500, {
    error: "internal",
    message: "The local service could not complete this request.",
  });
}

function sameConnection(a, b) {
  return (
    a.type === b.type &&
    a.host === b.host &&
    a.port === b.port &&
    (a.username || "") === (b.username || "") &&
    (a.password || "") === (b.password || "")
  );
}

function proxyIdFromPath(path) {
  const match = /^\/api\/proxies\/([^/]+)(\/test|\/score)?$/.exec(path);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "invalid_id", "Proxy id is invalid.");
  }
  if (!id || id.length > 128) throw new HttpError(400, "invalid_id", "Proxy id is invalid.");
  return { id, test: match[2] === "/test", score: match[2] === "/score" };
}

// `/api/accounts/<provider>/<key>`. Both segments are URL-encoded, so a key
// like `workbuddy#ab12` arrives as `workbuddy%23ab12` and is decoded here. The
// two-segment shape deliberately does not match `/api/accounts` or
// `/api/accounts/prune`.
function accountKeyFromPath(path) {
  const match = /^\/api\/accounts\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return { provider: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) };
  } catch {
    throw new HttpError(400, "invalid_account", "The account path is invalid.");
  }
}

// `/api/accounts/<provider>/<key>/check` and its `/cancel` suffix. Handled
// BEFORE `accountKeyFromPath`: both segments are URL-encoded exactly as the
// account routes are, and the extra path segment keeps the ownership ledger
// and the check job clearly apart.
function accountCheckFromPath(path) {
  const match = /^\/api\/accounts\/([^/]+)\/([^/]+)\/check(\/cancel)?$/.exec(path);
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]),
      key: decodeURIComponent(match[2]),
      cancel: match[3] === "/cancel",
    };
  } catch {
    throw new HttpError(400, "invalid_account", "The account path is invalid.");
  }
}

// The service's port is fixed: the page reads it from `window.magpie.options`
// and has no fallback, so it cannot simply move to a free one. magpie reloads a
// plugin in a fresh host process after an update, and the host it replaces keeps
// its loopback listener until it exits -- a bind attempted inside that handover
// fails with EADDRINUSE. That failure used to be final: the plugin was recorded
// as not loaded and the page had no service until magpie restarted.
//
// Waiting a moment and binding again rides out that handover. The window is
// bounded, and it stays well under the 20s magpie allows one plugin to load, so
// a port that really is owned by something else still fails the load visibly
// instead of hanging.
function portInUse(error) {
  return (
    error?.code === "EADDRINUSE" ||
    // A runtime that reports the condition only in the message: Bun's is
    // "Failed to start server. Is port 3492 in use?".
    /is port \d+ in use|EADDRINUSE|address already in use/i.test(String(error?.message ?? ""))
  );
}

// One bind attempt. `server.listen(port, host, callback)` registers the callback
// as an implicit `listening` listener that a failed bind never removes, and the
// `error` listener was only removed on success -- thirteen retries therefore
// accumulated eleven listeners and Bun logged
// `MaxListenersExceededWarning: 11 listening listeners added to [Server]`.
// Both listeners are named here and always removed, on success and on failure.
function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, "127.0.0.1");
    } catch (error) {
      onError(error);
    }
  });
}

// The previous plugin host owns the port until it exits. Bind failures are
// retried within a bounded window, or without a deadline when `windowMs` is not
// finite. The page still points at the same loopback port, so the service must
// keep that port rather than silently moving to a random one no caller knows.
export async function listenWithPortRetry(server, port, { windowMs = 0, log } = {}) {
  const deadline = Number.isFinite(windowMs)
    ? Date.now() + Math.max(0, windowMs)
    : Number.POSITIVE_INFINITY;
  let wait = 100;
  // An unbounded retry must not write one line per second into magpie's app.log
  // for as long as the port stays taken. Every attempt is still reported while
  // the handover is happening; after that only one line per LOG_EVERY_MS.
  const LOG_EVERY_MS = 30_000;
  let lastLogAt = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await listenOnce(server, port);
      return;
    } catch (error) {
      const left = deadline - Date.now();
      if (!portInUse(error) || left <= 0) throw error;
      const delay = Math.min(wait, left);
      const now = Date.now();
      if (attempt < 5 || now - lastLogAt >= LOG_EVERY_MS) {
        log?.(`port ${port} is in use; retrying in ${delay}ms (attempt ${attempt + 1})`);
        lastLogAt = now;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      wait = Math.min(wait * 2, 1000);
    }
  }
}

export async function startServer({
  port = 3492,
  // How long a bind may keep retrying while the previous instance of this
  // plugin releases the port. Bound by magpie plugin host's `loadWait`
  // (20s) so we never exceed the host-side load budget. See `listenWithPortRetry`.
  portRetryMs = 18_000,
  // `env` must be destructured before `dataDir` so its default can follow the
  // caller's environment. `pluginDataDir()` defaults to `process.env`, which
  // would silently ignore an isolated `env` and write probes into the real
  // config directory.
  env,
  dataDir = pluginDataDir(env),
  proxyEndpoint,
  proxyTimeoutMs,
  proxyTester = testProxy,
  environment: environmentManager,
  pluginScanner: pluginScannerOption,
  client,
  magpie,
  pluginInput,
  signIn: signInOption,
  proxyScore: proxyScoreOption,
  // The seam the scoring browser is launched through, so the package's own
  // tests can drive the real controller without opening a browser.
  scoreLauncher,
  // The identity-check controller (tests inject a fake one) and the launcher
  // seam the real controller opens its browser through.
  identityCheck: identityCheckOption,
  checkLauncher,
  // The per-account proxy synchronizer, keeping magpie's `accountProxies` map
  // in step with the exits accounts use. Injected by tests to intercept writes.
  accountProxySync: accountProxySyncOption,
} = {}) {
  const token = randomBytes(32).toString("hex");
  const store = createProxyStore({ dataDir });
  const environment = environmentManager || createEnvironmentManager();
  // Keeps magpie's providers.json in step with the exits accounts signed in
  // through, so each account really runs through the exit the user picked.
  const accountProxySync =
    accountProxySyncOption ||
    createAccountProxySync({
      env: env ?? process.env,
      store,
      dataDir,
    });
  // The installed-plugin scan is third-party code and may take seconds. It is
  // cached with a TTL and warmed in the background only after the service is
  // listening, so it can never delay startup. `createPluginScanner` disables
  // itself under NODE_ENV=test unless a scanner is injected.
  const pluginScanner = pluginScannerOption || createPluginScanner();
  // The sign-in controller lives for the service's lifetime: its flow state,
  // and therefore the callback closure, is process memory, not disk.
  const signIn =
    signInOption ||
    createSignInFlow({
      client,
      magpie,
      env,
      environment,
      pluginScanner,
      pluginInput,
      syncAccountProxy: ({ provider, accountId, proxy }) =>
        accountProxySync.syncSignIn({ provider, accountId, proxy }),
    });
  // The trust-score controller lives for the service's lifetime: one check at
  // a time, its window held open between requests. It persists through the
  // proxy store, applying a result only to the revision that was measured.
  const proxyScore =
    proxyScoreOption ||
    createProxyScore({
      env: env ?? process.env,
      dataDir,
      environment,
      ...(scoreLauncher ? { launchBrowser: scoreLauncher } : {}),
      onScore: (result) =>
        store.applyScoreResult(result.proxyId, result, result.expectedUpdatedAt),
    });
  // The identity-check controller lives for the service's lifetime. It is the
  // only writer of the account's `checks` history, through `onCheck`; a failed
  // or cancelled check never reaches that callback and therefore never
  // overwrites the last verdict or appends a record.
  const identityCheck =
    identityCheckOption ||
    createIdentityCheck({
      env: env ?? process.env,
      dataDir,
      environment,
      ...(checkLauncher ? { launchBrowser: checkLauncher } : {}),
      onCheck: (check) => recordCheck(check),
    });

  // A single account object, used both by the list and by the PATCH response.
  // Optional fields are whitelisted projections of the ledger; the fingerprint
  // is a short digest, never the identity object or the directory path.
  async function accountView(entry, keys) {
    return {
      provider: entry.provider,
      key: entry.key,
      accountId: entry.meta.accountId ?? null,
      uid: entry.meta.uid ?? null,
      signedInAt: entry.meta.signedInAt ?? null,
      signedIn: keys.has(entry.key),
      ...accountExtras(entry.meta),
      fingerprint: await readFingerprintSummary(entry.dir),
    };
  }

  async function recordCheck(check) {
    try {
      const dir = accountDir(env ?? process.env, check.provider, check.key);
      const meta = await readAccountMeta(dir);
      if (!meta) return;
      // Only the whitelisted display fields are stored: no proxy credentials,
      // no host/port, no path and no full verdict object.
      await writeAccountMeta(
        dir,
        withCheck(meta, {
          at: check.checkedAt,
          grade: check.grade,
          proxyId: check.proxyId,
          proxyName: check.proxyName,
          region: check.region,
          exposure: check.exposure,
          summary: Array.isArray(check.summary) ? check.summary : [],
        }),
      );
    } catch {
      // A ledger write failure must not change the reported job.
    }
  }
  let actualPort = port;
  let allowedHosts = new Set();
  let ownOrigins = new Set();

  // The account orphan sweep: one run per process at startup, plus an on-demand
  // run from POST /api/accounts/prune. The last report is summarized on
  // /api/health. It is fire-and-forget and never throws.
  const effectiveEnv = env ?? process.env;
  let lastAccountPrune = null;
  let lastAccountPruneAt = null;
  let pruneRun = null;

  async function runStartupPrune() {
    const report = await pruneOrphanAccounts({
      env: effectiveEnv,
      readKeySet: () => readAuthKeysResult(effectiveEnv),
      log: (message) => console.log(`[login] ${message}`),
    });
    lastAccountPrune = report;
    lastAccountPruneAt = new Date().toISOString();
    console.log(
      `[login] accounts: ${report.kept.length} kept, ${report.retired.length} retired, ${report.removed.length} pruned, ${report.failed.length} failed`,
    );
    return report;
  }

  function runPrune() {
    if (!pruneRun) {
      pruneRun = runStartupPrune()
        .catch(() => emptyPruneReport())
        .finally(() => {
          pruneRun = null;
        });
    }
    return pruneRun;
  }

  // How many accounts are signed in and how many are retired, read now.
  // A sweep report describes the moment it ran; a caller asking for the
  // current state must not be answered with that snapshot, because a sign-out
  // or a sign-in since then would leave the numbers wrong until the next
  // sweep. Returns `live: false` with null counts when the answer cannot be
  // known (the auth file or the account directory is unreadable), so an
  // unreadable state never reads as "no accounts".
  async function countAccountsNow() {
    let dirs;
    try {
      dirs = await listAccountDirsWithMeta(effectiveEnv);
    } catch {
      return { live: false, signedIn: null, retired: null };
    }
    const keyResult = readAuthKeysResult(effectiveEnv);
    let keys;
    if (keyResult.ok) {
      keys = keyResult.keys;
    } else if (keyResult.reason === "auth_missing") {
      // magpie writes plugin-auth.json on the first sign-in, so a missing file
      // means "no account is signed in" rather than "unknown". Counting is
      // read-only, so this cannot be confused with the sweep's decision to
      // treat a missing file as "touch nothing".
      keys = new Set();
    } else {
      // Unreadable or malformed: the answer is unknown, not zero.
      return { live: false, signedIn: null, retired: null };
    }
    let signedIn = 0;
    let retired = 0;
    for (const entry of dirs) {
      // Only an attributed directory is an account. A directory without a
      // ledger is either a sign-in in flight or an abandoned pre-allocation,
      // and neither is a signed-in or a retired account yet.
      if (!entry.meta) continue;
      if (keys.has(entry.key)) signedIn += 1;
      else retired += 1;
    }
    return { live: true, signedIn, retired };
  }

  // Counts and a short skip reason only: /api/health stays a secretless
  // liveness probe and never carries an account key, a provider or a path.
  //
  // `kept` and `retired` are read at request time (`live` says whether that
  // read succeeded); `pruned`, `skippedLive`, `failed` and `skipped` are facts
  // about the last sweep and stay as they are, with `sweptAt` naming when that
  // sweep ran.
  async function accountPruneSummary() {
    const report = lastAccountPrune;
    const now = await countAccountsNow();
    return {
      ran: report !== null,
      live: now.live,
      kept: now.signedIn,
      // Accounts kept because they carry an ownership ledger (signed out, not
      // deleted). A count only: /api/health never carries a key or a path.
      retired: now.retired,
      pruned: report?.removed.length ?? 0,
      skippedLive: report?.skippedLive.length ?? 0,
      failed: report?.failed.length ?? 0,
      skipped: report?.skipped ?? null,
      sweptAt: lastAccountPruneAt,
    };
  }

  const runProxyTest = (proxy) =>
    proxyTester(proxy, { endpoint: proxyEndpoint, timeoutMs: proxyTimeoutMs });

  const server = createServer(async (req, res) => {
    const host = String(req.headers.host || "").toLowerCase();
    if (!allowedHosts.has(host)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }

    const url = new URL(req.url || "/", `http://${host}`);
    const origin = req.headers.origin;

    // The opaque-origin frame needs CORS on the API. The Origin gate stays
    // first and unchanged: a foreign site still gets a bare 403 without any
    // CORS headers, so these headers never widen who may call the service.
    if (url.pathname.startsWith("/api/")) {
      if (!originAllowed(origin, ownOrigins)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      applyCors(res, origin);

      // Preflight is answered before the token gate: a browser's OPTIONS does
      // not carry the custom token header or the token. Passing it only says a
      // real request may follow; that request is still token-checked below.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PATCH, DELETE",
          "access-control-allow-headers": `${TOKEN_HEADER}, content-type`,
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
    }

    if (url.pathname.startsWith("/api/") && !tokenMatches(req.headers[TOKEN_HEADER], token)) {
      json(res, 403, { error: "unauthorized", reload: true });
      return;
    }

    try {
      // Liveness probe: no secrets, just enough for the page to know the
      // service is alive. The full page state lives in /api/bootstrap.
      if (url.pathname === "/api/health") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        json(res, 200, { ok: true, version, accounts: await accountPruneSummary() });
        return;
      }

      // The page's only source of truth. Providers are a static capability
      // registry; the sign-in/account step will add real actions later.
      if (url.pathname === "/api/bootstrap") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        const proxies = await store.list();
        json(res, 200, {
          version,
          service: { status: "ready" },
          providers: listProviders(),
          proxies,
        });
        return;
      }

      // Public capability fields only. No credentials or private sign-in
      // implementation details belong in this response.
      if (url.pathname === "/api/providers") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        json(res, 200, { providers: listProviders() });
        return;
      }

      // Merge the local registry with the provider list the launcher read from
      // magpie. The page cannot fetch, so it forwards the raw value through the
      // navigation hash; the UI reads it and posts it here. The body is
      // optional: an absent or unrecognized payload yields the local-only
      // fallback with an honest source marker.
      if (url.pathname === "/api/provider-sources") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const body = await readJson(req, { optional: true });
        // `get()` returns the cached scan immediately and refreshes in the
        // background; a request never waits on the child process.
        const plugins = pluginScanner.get();
        json(res, 200, {
          providerSources: mergeProviderSources({
            local: listProviders(),
            magpie: body && typeof body === "object" ? body.magpie : undefined,
            plugins,
          }),
          // Honest scan state: whether the second layer ran, whether it was a
          // hit or a degraded fallback, and whether a fresh scan is in flight.
          pluginScan: {
            available: Boolean(plugins.available),
            count: Array.isArray(plugins.providers) ? plugins.providers.length : 0,
            scanned: Boolean(plugins.scanned),
            stale: Boolean(plugins.stale),
            scanning: Boolean(plugins.scanning),
            error: plugins.error || null,
          },
        });
        return;
      }

      // A ready-to-submit issue, assembled here from an allowlist (never from
      // raw page input) so a user who hits a problem can report it in a few
      // clicks. Nothing from the credential files or the proxy store is read.
      // This route only *builds* the text and the GitHub URL; it launches
      // nothing, so a page can preview and copy without any side effect.
      if (url.pathname === "/api/report") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const body = await readJson(req, { optional: true });
        const plugins = pluginScanner.get();
        const report = buildIssueRequest({
          provider: body && typeof body === "object" ? body.provider : undefined,
          userNote: body && typeof body === "object" ? body.note : undefined,
          language: body && typeof body === "object" ? body.language : undefined,
          pluginVersion: version,
          pluginScan: {
            available: Boolean(plugins.available),
            scanned: Boolean(plugins.scanned),
            error: plugins.error || null,
          },
          platform: { platform: process.platform, arch: process.arch },
          runtime: {
            name: process.versions.bun ? "bun" : "node",
            version: process.versions.bun || process.version,
          },
        });
        json(res, 200, { report });
        return;
      }

      // The only route that hands anything to the operating system. The URL is
      // re-checked against the allowlist before it is spawned, so a page
      // cannot widen it into an arbitrary launch. A magpie page cannot open a
      // link itself (sandbox="allow-scripts" has no allow-popups), which is
      // exactly why this exists.
      if (url.pathname === "/api/report/open") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const body = await readJson(req, { optional: true });
        const target = body && typeof body === "object" ? String(body.url ?? "") : "";
        if (!isAllowedIssueUrl(target)) {
          throw new HttpError(
            400,
            "url_not_allowed",
            "Only the project's GitHub new-issue page may be opened.",
          );
        }
        const opened = await openExternal(target);
        json(res, 200, { ok: true, command: opened.command });
        return;
      }

      // One-time login-browser preparation. Every GET is read-only: only the
      // explicit POST prepare starts a download, and only one job runs at a
      // time.
      if (url.pathname === "/api/environment") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        json(res, 200, { environment: await environment.status(), job: environment.job() });
        return;
      }

      if (url.pathname === "/api/environment/prepare") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const started = await environment.prepare();
        json(res, 202, {
          started: started.started,
          environment: await environment.status(),
          job: started.job,
        });
        return;
      }

      if (url.pathname === "/api/environment/job") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        json(res, 200, { environment: await environment.status(), job: environment.job() });
        return;
      }

      if (url.pathname === "/api/environment/cancel") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const cancelled = environment.cancel();
        json(res, 200, {
          cancelled: cancelled.cancelled,
          environment: await environment.status(),
          job: cancelled.job,
        });
        return;
      }

      if (url.pathname === "/api/proxies") {
        if (req.method === "GET") {
          json(res, 200, { proxies: await store.list() });
          return;
        }
        if (req.method === "POST") {
          const input = validateCreate(await readJson(req));
          const record = await store.create(input);
          json(res, 201, { proxy: publicProxy(record) });
          return;
        }
        return methodNotAllowed(res, "GET, POST");
      }

      // Draft test for the Add dialog: validates and probes the supplied
      // connection without creating a proxy.
      if (url.pathname === "/api/proxies/test") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const body = await readJson(req);
        let stored = null;
        if (body && typeof body === "object" && typeof body.id === "string" && body.id) {
          stored = await store.get(body.id);
          if (!stored) throw new HttpError(404, "not_found", "Proxy not found.");
        }
        const candidate = validateProbe(body, stored);
        const result = await runProxyTest(candidate);
        json(res, 200, { ok: result.ok, result });
        return;
      }

      const route = proxyIdFromPath(url.pathname);
      if (route) {
        const existing = await store.get(route.id);
        if (!existing) throw new HttpError(404, "not_found", "Proxy not found.");

        if (route.test) {
          if (req.method !== "POST") return methodNotAllowed(res, "POST");
          const body = await readJson(req, { optional: true });
          const candidate = body && Object.keys(body).length
            ? validateProbe(body, existing)
            : { ...existing };
          const expectedUpdatedAt = existing.updatedAt;
          const result = await runProxyTest(candidate);
          // A draft (unsaved) connection is reported to the dialog but never
          // written onto the stored row. A test of the stored connection is
          // applied only if the row still has the revision that was probed.
          const persisted = sameConnection(candidate, existing)
            ? await store.applyTestResult(route.id, result, expectedUpdatedAt)
            : null;
          json(res, 200, {
            ok: result.ok,
            result,
            proxy: persisted ? publicProxy(persisted) : null,
            persisted: Boolean(persisted),
          });
          return;
        }

        // Start the Claude trust-score check for this row. The request waits
        // only for the window to open; the page is then polled through
        // GET /api/proxy-score.
        if (route.score) {
          if (req.method !== "POST") return methodNotAllowed(res, "POST");
          const job = await proxyScore.start({
            id: existing.id,
            name: existing.name,
            proxy: existing,
            expectedUpdatedAt: existing.updatedAt,
          });
          json(res, 202, { ok: true, job });
          return;
        }

        if (req.method === "GET") {
          json(res, 200, { proxy: publicProxy(existing) });
          return;
        }
        if (req.method === "PATCH") {
          const changes = validateUpdate(await readJson(req));
          const updated = await store.update(route.id, changes);
          if (!updated) throw new HttpError(404, "not_found", "Proxy not found.");
          json(res, 200, { proxy: publicProxy(updated) });
          return;
        }
        if (req.method === "DELETE") {
          const removed = await store.remove(route.id);
          if (!removed) throw new HttpError(404, "not_found", "Proxy not found.");
          json(res, 200, { ok: true, id: removed.id });
          return;
        }
        return methodNotAllowed(res, "GET, PATCH, DELETE");
      }

      if (url.pathname === "/api/accounts/prune") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const report = await runPrune();
        json(res, 200, { report });
        return;
      }

      // Every known account, with its ownership ledger fields and whether its
      // key is currently signed in. No path and no credential is ever
      // returned. `signedInAt` comes from the ledger, not from the auth file.
      if (url.pathname === "/api/accounts") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        const keyResult = readAuthKeysResult(effectiveEnv);
        const keys = keyResult.ok ? keyResult.keys : new Set();
        const dirs = await listAccountDirsWithMeta(effectiveEnv);
        const accounts = [];
        for (const entry of dirs) {
          if (!entry.meta) continue;
          accounts.push(await accountView(entry, keys));
        }
        // Deterministic order: provider, then account key.
        accounts.sort((a, b) => {
          if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
          if (a.key === b.key) return 0;
          return a.key < b.key ? -1 : 1;
        });
        json(res, 200, { accounts });
        return;
      }

      // Import a pasted credential into magpie, from the page. The credential is
    // parsed and proven here (a refresh token is really spent once), then
    // written through the injected `client.auth.set` — the same call a sign-in
    // makes. Only WorkBuddy is supported: the refresh endpoint and the stored
    // shape are WorkBuddy's.
    if (url.pathname === "/api/import") {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      if (!client || typeof client.auth?.set !== "function") {
        throw new HttpError(
          503,
          "auth_unavailable",
          "The page is not running inside magpie, so there is no account store to write to.",
        );
      }
      const body = await readJson(req);
      const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "workbuddy";
      const text = typeof body?.text === "string" ? body.text : "";

      // Fail closed when the account index exists but cannot be read. The
      // import path allocates a key from that index; an empty fallback would
      // hand out the bare provider id and overwrite its first account. A
      // missing file is a fresh install with nothing to overwrite.
      const authKeys = readAuthKeysResult(effectiveEnv);
      if (!authKeys.ok && authKeys.reason !== "auth_missing") {
        throw new HttpError(
          503,
          "auth_unreadable",
          "magpie 的账号索引暂时读不出来；为避免覆盖已有账号，这次导入没有执行。请稍后重试。",
        );
      }

      const entries = readAuthEntries(effectiveEnv);
      let prepared;
      let key;
      let created = true;
      try {
        if (provider === "workbuddy") {
          prepared = await prepareImport(text, { provider });
          if (prepared.kind === "key") {
            // An API key is not an OAuth result: magpie stores it as
            // {type:"api", key}, the shape clients send as X-API-Key.
            key = signInKey(provider, null, entries);
            created = !Object.prototype.hasOwnProperty.call(entries, key);
            await client.auth.set({
              path: { id: key },
              body: {
                type: "api",
                key: prepared.result.key,
                accountId: prepared.accountId,
                uid: prepared.uid,
              },
            });
          } else {
            const written = await writeBack({
              provider,
              result: prepared.result,
              entries,
              client,
            });
            if (!written.ok) {
              throw new HttpError(
                502,
                "write_failed",
                `凭据校验通过，但写入 magpie 失败：${written.error}`,
              );
            }
            key = written.key;
            created = written.created;
          }
        } else {
          // Any other provider: parse and whitelist locally, then write the
          // typed body through the same account store a sign-in uses. There is
          // no provider endpoint we may call, so nothing here claims a network
          // verification that did not happen.
          prepared = prepareGenericImport(text, {
            provider,
            entries,
            // Duplicate refusal needs the values, which readAuthEntries strips.
            secrets: readAuthSecrets(effectiveEnv),
          });
          key = signInKey(provider, null, entries);
          created = !Object.prototype.hasOwnProperty.call(entries, key);
          await client.auth.set({ path: { id: key }, body: prepared.body });
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof ImportError) {
          throw new HttpError(error.status, error.code, error.message);
        }
        throw new HttpError(502, "write_failed", `写入 magpie 失败：${String(error?.message ?? error)}`);
      }

      // Record the ownership ledger, so the account appears in Accounts with a
      // sign-in time. A failure here does not undo the credential: it only
      // means the row has no ledger until the next sign-in.
      try {
        const dir = accountDir(effectiveEnv, provider, key);
        const existing = await readAccountMeta(dir);
        const signedAt = new Date().toISOString();
        const carried = {};
        if (existing && typeof existing.note === "string") carried.note = existing.note;
        if (existing && Array.isArray(existing.checks)) carried.checks = existing.checks;
        if (existing && Array.isArray(existing.loginHistory)) carried.loginHistory = existing.loginHistory;
        await writeAccountMeta(
          dir,
          withLogin(
            {
              version: 1,
              provider,
              key,
              accountId: prepared.accountId ?? null,
              uid: prepared.uid ?? null,
              signedInAt: signedAt,
              ...carried,
            },
            loginSnapshot(null, signedAt),
          ),
        );
      } catch {
        // Credential already written; the ledger is best effort.
      }

      json(res, 200, {
        ok: true,
        key,
        created,
        kind: prepared.kind,
        accountId: prepared.accountId ?? null,
        notice: prepared.notice || "",
      });
      return;
    }

    // Identity-check routes are resolved before the two-segment account
      // matcher, so `/check` and `/check/cancel` can never be mistaken for an
      // account key (or vice versa). Only the job's whitelisted fields leave
      // the service; the stored proxy record stays on this side of the IPC.
      const checkTarget = accountCheckFromPath(url.pathname);
      if (checkTarget) {
        const { provider, key, cancel } = checkTarget;
        if (cancel) {
          if (req.method !== "POST") return methodNotAllowed(res, "POST");
          const result = await identityCheck.cancel();
          json(res, 200, { ok: true, job: result.job });
          return;
        }
        if (req.method === "GET") {
          const { job } = identityCheck.status();
          // A job started for a different account is not this account's state.
          json(res, 200, {
            job: job.provider === provider && job.key === key ? job : idleCheckJob(),
          });
          return;
        }
        if (req.method === "POST") {
          const body = await readJson(req, { optional: true });
          let proxy = null;
          const proxyId =
            body && typeof body.proxyId === "string" && body.proxyId ? body.proxyId : null;
          if (proxyId) {
            const stored = await store.get(proxyId);
            if (!stored) throw new HttpError(404, "not_found", "Proxy not found.");
            proxy = stored;
          }
          const job = await identityCheck.start({ provider, key, proxy });
          json(res, 202, { ok: true, job });
          return;
        }
        return methodNotAllowed(res, "GET, POST");
      }

      const accountTarget = accountKeyFromPath(url.pathname);
      if (accountTarget) {
        const dir = accountDir(effectiveEnv, accountTarget.provider, accountTarget.key);
        const meta = await readAccountMeta(dir);
        if (!meta || meta.provider !== accountTarget.provider) {
          throw new HttpError(404, "not_found", "Account not found.");
        }
        if (req.method === "PATCH") {
          const body = await readJson(req);
          const note = normalizeNote(body?.note);
          const updated = withNote(meta, note);
          await writeAccountMeta(dir, updated);
          const keyResult = readAuthKeysResult(effectiveEnv);
          const keys = keyResult.ok ? keyResult.keys : new Set();
          json(res, 200, {
            ok: true,
            account: await accountView({ ...accountTarget, dir, meta: updated }, keys),
          });
          return;
        }
        if (req.method !== "DELETE") return methodNotAllowed(res, "DELETE");
        const keyResult = readAuthKeysResult(effectiveEnv);
        if (!keyResult.ok) {
          // Without the key set we cannot tell a signed-in account from a
          // signed-out one, so refuse rather than delete a live credential's
          // pin.
          throw new HttpError(503, "auth_unreadable", "The signed-in accounts could not be read.");
        }
        if (keyResult.keys.has(accountTarget.key)) {
          throw new HttpError(409, "signed_in", "This account is still signed in; sign out first.");
        }
        await removeAccountDir(dir);
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/signin") {
        if (req.method === "GET") {
          json(res, 200, { flow: signIn.status() });
          return;
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          const provider = body && typeof body.provider === "string" ? body.provider : "";
          if (!provider) throw new HttpError(400, "invalid_provider", "A provider id is required.");
          // The page only ever holds the public proxy record (no password).
          // When it names a stored proxy by id, resolve the full record here so
          // the browser really uses the chosen exit and the credential stays
          // inside the service. A bare `{ server }` / host+port shape (used by
          // tests and direct callers) passes through untouched.
          let proxy = body && typeof body.proxy === "object" && body.proxy ? body.proxy : null;
          if (proxy && typeof proxy.id === "string" && proxy.id) {
            const stored = await store.get(proxy.id);
            if (!stored) throw new HttpError(404, "not_found", "Proxy not found.");
            proxy = stored;
          }
          // Optional: the exact label of the method the user picked when the
          // plugin exposes several (for example ZCode's per-site oauth
          // methods). Absent or blank means "let the controller choose".
          const methodLabel =
            typeof body?.methodLabel === "string" ? body.methodLabel.trim() : "";
          // Optional: continue a retired identity. The page sends the exact
          // account key it listed from GET /api/accounts; the controller
          // verifies the directory's ledger before reusing its fingerprint.
          const account =
            body && typeof body.account === "object" && body.account &&
            typeof body.account.key === "string" && body.account.key
              ? { key: body.account.key }
              : null;
          // Whitelist the chosen exit for the ownership ledger. A stored proxy
          // carries credentials that must never be written to account.json, so
          // only these four display fields are handed to the flow. A direct
          // sign-in (or a bare `{ server }` shape with no id) omits the key
          // entirely and is recorded as a `proxyId: null` login.
          const proxyMeta =
            proxy && typeof proxy.id === "string" && proxy.id
              ? {
                  id: proxy.id,
                  name: typeof proxy.name === "string" ? proxy.name : "",
                  region: typeof proxy.region === "string" ? proxy.region : "",
                  type: typeof proxy.type === "string" ? proxy.type : null,
                }
              : null;
          const started = await signIn.startSignIn({
            provider,
            proxy,
            ...(proxyMeta ? { proxyMeta } : {}),
            single: body?.single === true,
            methodLabel: methodLabel || null,
            account,
          });
          json(res, 202, started);
          return;
        }
        return methodNotAllowed(res, "GET, POST");
      }

      if (url.pathname === "/api/signin/cancel") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const cancelled = await signIn.cancel();
        json(res, 200, { cancelled: Boolean(cancelled?.cancelled), flow: signIn.status() });
        return;
      }

      if (url.pathname === "/api/proxy-score") {
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        json(res, 200, proxyScore.status());
        return;
      }

      if (url.pathname === "/api/proxy-score/cancel") {
        if (req.method !== "POST") return methodNotAllowed(res, "POST");
        const cancelled = await proxyScore.cancel();
        json(res, 200, { ok: true, job: cancelled.job });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        throw new HttpError(404, "not_found", "API route not found.");
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
        res.end();
        return;
      }

      // HARD CONSTRAINT: this HTML document embeds the per-process page token,
      // so it must never carry Access-Control-Allow-*. If it did, any website
      // could fetch("http://127.0.0.1:3492/") cross-origin, read the token and
      // then drive the local service (including starting a sign-in). Only the
      // non-HTML assets above and the /api/* responses get CORS.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
          const html = (await readFile(join(UI_ROOT, "index.html"), "utf8")).replaceAll(
            TOKEN_PLACEHOLDER,
            token,
          );
          res.writeHead(200, {
            "content-type": MIME[".html"],
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          res.end(req.method === "HEAD" ? undefined : html);
        } catch {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("The Login page is missing.");
        }
        return;
      }

      const isAsset = url.pathname.startsWith("/assets/");
      const relative = decodeURIComponent(
        isAsset ? url.pathname.slice("/assets/".length) : url.pathname.slice(1),
      );
      const root = isAsset ? ASSET_ROOT : UI_ROOT;
      if (!relative || relative.includes("\0") || !inside(root, relative)) {
        res.writeHead(404, { "cache-control": "no-store" });
        res.end();
        return;
      }
      try {
        const body = await readFile(join(root, relative));
        const type = extname(relative).toLowerCase();
        // Assets the sandboxed frame fetches (the app module and its sibling
        // modules, CSS, icons, fonts) must be readable cross-origin. HTML is
        // excluded on purpose: the token-bearing document is served above with
        // no CORS, and any other .html here must not become a readable
        // cross-origin document either.
        if (type !== ".html") applyCors(res, origin);
        res.writeHead(200, {
          "content-type": MIME[type] || "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : body);
      } catch {
        res.writeHead(404, { "cache-control": "no-store" });
        res.end();
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  await listenWithPortRetry(server, port, {
    windowMs: portRetryMs,
    log: (message) => console.log(`[clean-login] ${message}`),
  });
  actualPort = server.address().port;
  allowedHosts = new Set([
    `127.0.0.1:${actualPort}`,
    `localhost:${actualPort}`,
    `[::1]:${actualPort}`,
  ]);
  ownOrigins = new Set([
    `http://127.0.0.1:${actualPort}`,
    `http://localhost:${actualPort}`,
    `http://[::1]:${actualPort}`,
  ]);

  // Fire-and-forget: the listener is already accepting requests, so starting
  // the warm scan now cannot delay serving the page.
  pluginScanner.warm?.();

  // Same for the account orphan sweep: the key set is read now, after the
  // service is serving, and the run never rejects.
  runPrune();

  // Startup backfill: populate magpie's `accountProxies` for any account that
  // signed in before this feature existed, but only for keys that have no entry
  // yet so hand-configured proxies are preserved. Fire-and-forget.
  let backfillPromise = null;
  const runBackfill = () => {
    backfillPromise ??= accountProxySync
      .backfill()
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    return backfillPromise;
  };
  runBackfill();

  return {
    port: actualPort,
    dataDir,
    store,
    // Exposed so the package's own tests can wait for the startup sweep
    // instead of racing it.
    prune: () => runPrune(),
    // Same for the startup account-proxy backfill.
    backfill: () => runBackfill(),
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      // The scoring window is the service's responsibility; close it (and its
      // host) on shutdown instead of leaving an orphan browser.
      await proxyScore.close?.();
      await identityCheck.close?.();
    },
  };
}

// Exported so the package's own tests can send the same request header without
// restating it. It is a random per-process value, not a static secret.
export { TOKEN_HEADER };
