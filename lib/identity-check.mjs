// Identity detection for one account: open the account's own pinned browser
// through a chosen exit, read who.1ms.dog's verdict, and report it.
//
// The engine is deliberately modelled on proxy-score.mjs (one job at a time,
// a forked browser host, a pollable status) with three hard differences:
//   * the browser uses a profile UNDER THE ACCOUNT directory, never the login
//     profile, so a check cannot disturb a signed-in session;
//   * only a SUCCESSFUL verdict is handed to `onCheck`. A failure or a cancel
//     never writes history and never overwrites the last result;
//   * every field the page can see is whitelisted here. The proxy record that
//     reaches the launcher carries a password, a host and a port; none of
//     them may enter the job or the ledger.

import { join } from "node:path";
import { EXECUTABLE_ENV } from "./browser-environment.mjs";
import { accountDir, readAccountMeta, readIdentity as readStoredIdentity } from "./account-identity.mjs";
import { launchIdentityCheckBrowser } from "./browser-launcher.mjs";

export const CHECK_STATES = Object.freeze([
  "idle",
  "launching",
  "checking",
  "done",
  "error",
  "cancelled",
]);

export const CHECK_URL = "https://who.1ms.dog/zh-cn/";
export const CHECK_TIMEOUT_ENV = "MAGPIE_CLEAN_LOGIN_CHECK_TIMEOUT_MS";
export const DEFAULT_CHECK_TIMEOUT_MS = 90_000;
export const CHECK_PROFILE_DIR_NAME = "check-profile";

export const CHECK_ERROR_CODES = Object.freeze([
  "browser_missing",
  "executable_missing",
  "identity_missing",
  "launch_failed",
  "launch_timeout",
  "page_timeout",
  "verdict_missing",
  "cancelled",
  "proxy_not_found",
  "account_not_found",
  "check_busy",
  "internal",
]);

const ALLOWED_CODES = new Set(CHECK_ERROR_CODES);
const TERMINAL = new Set(["done", "error", "cancelled"]);
const GRADE_PATTERN = /评分\s*([A-D])\b/;
const EXPOSURE_PATTERN = /(\d+)\s*处可能暴露你/;
const SUMMARY_MARKER = "网站眼中的你";
const FINGERPRINT_MARKER = "浏览器指纹 ID";
const SUMMARY_LIMIT = 4;

export class IdentityCheckError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "IdentityCheckError";
    this.code = code;
    this.status = status;
  }
}

export function checkTimeoutMs(env = process.env) {
  const raw = Number(env?.[CHECK_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CHECK_TIMEOUT_MS;
}

// The account's check browser lives in a sibling of the login `profile/`, so
// opening it can never lock or mutate the profile a real sign-in uses.
export function checkProfileDir(dir) {
  return join(dir, CHECK_PROFILE_DIR_NAME);
}

// The verdict the third-party page prints in `document.body.innerText`.
// Anything without a grade is not a verdict yet: the page is still drawing.
export function parseWhoVerdict(text) {
  if (typeof text !== "string") return null;
  const gradeMatch = GRADE_PATTERN.exec(text);
  if (!gradeMatch) return null;
  const exposureMatch = EXPOSURE_PATTERN.exec(text);
  const exposure = exposureMatch ? Number.parseInt(exposureMatch[1], 10) : 0;

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const viewIndex = lines.findIndex((line) => line.startsWith(SUMMARY_MARKER));
  const summary = [];
  if (viewIndex >= 0) {
    for (let i = viewIndex + 1; i < lines.length && summary.length < SUMMARY_LIMIT; i += 1) {
      const line = lines[i];
      if (!line) continue;
      if (!line.startsWith("你")) break;
      summary.push(line);
    }
  }

  const fingerprintIndex = lines.findIndex((line) => line.startsWith(FINGERPRINT_MARKER));
  let fingerprintId = null;
  if (fingerprintIndex >= 0) {
    for (let i = fingerprintIndex + 1; i < lines.length; i += 1) {
      if (lines[i]) {
        fingerprintId = lines[i];
        break;
      }
    }
  }

  return {
    grade: gradeMatch[1],
    // A missing exposure line must still yield a definite number, never null.
    exposure: Number.isFinite(exposure) && exposure >= 0 ? exposure : 0,
    summary,
    fingerprintId,
  };
}

export function idleCheckJob() {
  return {
    state: "idle",
    provider: "",
    key: "",
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
    grade: null,
    exposure: null,
    summary: [],
    fingerprintId: null,
    error: "",
    errorCode: "",
    startedAt: null,
    finishedAt: null,
  };
}

function publicJob(job) {
  return {
    state: job.state,
    provider: job.provider,
    key: job.key,
    proxyId: job.proxyId,
    proxyName: job.proxyName,
    region: job.region,
    type: job.type,
    grade: job.grade,
    exposure: job.exposure,
    summary: Array.isArray(job.summary) ? job.summary.slice() : [],
    fingerprintId: job.fingerprintId,
    error: job.error,
    errorCode: job.errorCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

// Only the display fields of a proxy record may reach the job. The full record
// still goes to the launcher (it needs the credentials to connect), but a
// password/host/port can never be echoed to the page or written to the ledger.
function publicProxyMeta(proxy) {
  const source = proxy && typeof proxy === "object" && !Array.isArray(proxy) ? proxy : {};
  const type = ["http", "https", "socks5"].includes(source.type) ? source.type : null;
  return {
    proxyId: typeof source.id === "string" && source.id ? source.id : null,
    proxyName: typeof source.name === "string" ? source.name : "",
    region: typeof source.region === "string" ? source.region : "",
    type,
  };
}

function cap(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function messageOf(error, fallback = "The identity check failed.") {
  const message = String(error?.message ?? error ?? "").trim();
  return message || fallback;
}

function errorCodeOf(code) {
  if (code === "runtime_missing") return "browser_missing";
  return ALLOWED_CODES.has(code) ? code : "launch_failed";
}

const LAUNCH_STATUS = {
  browser_missing: 503,
  executable_missing: 503,
  identity_missing: 409,
  launch_failed: 502,
  launch_timeout: 504,
  page_timeout: 504,
  verdict_missing: 502,
  account_not_found: 404,
};

async function defaultResolveExecutable({ env = process.env, environment } = {}) {
  if (environment?.status) {
    try {
      const status = await environment.status();
      if (typeof status?.executablePath === "string" && status.executablePath) {
        return status.executablePath;
      }
    } catch {
      // Fall through to the environment override.
    }
  }
  return env?.[EXECUTABLE_ENV] || process.env[EXECUTABLE_ENV] || null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the client-rendered page until its text contains a verdict. Returns
// the raw text (the host forwards it verbatim) or null on timeout. `sleep` and
// `now` are injectable so a test never waits on a real clock or browser.
export async function waitForIdentityVerdict(
  page,
  {
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    intervalMs = 1000,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let text = "";
    if (page && typeof page.evaluate === "function") {
      try {
        const value = await page.evaluate(() => document.body.innerText);
        if (typeof value === "string") text = value;
      } catch {
        // A page that is closing simply yields no verdict on this poll.
      }
    }
    if (parseWhoVerdict(text)) return text;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function withTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(makeError());
    }, ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function defaultReadIdentity(dir) {
  return readStoredIdentity(dir);
}

export function createIdentityCheck({
  env = process.env,
  dataDir,
  environment,
  launchBrowser = launchIdentityCheckBrowser,
  resolveExecutable = defaultResolveExecutable,
  readIdentity = defaultReadIdentity,
  onCheck = async () => {},
  timeoutMs,
  now = () => new Date().toISOString(),
} = {}) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : checkTimeoutMs(env);

  let job = idleCheckJob();
  let current = null;
  let handle = null;

  async function closeHandle() {
    const closing = handle;
    handle = null;
    if (!closing) return;
    try {
      await closing.close?.();
    } catch {
      // A window that refused to close must not change the job's outcome.
    }
  }

  function failStart(run, code, message, status) {
    const text = cap(messageOf({ message }), 240);
    job = { ...job, state: "error", error: text, errorCode: code, finishedAt: now() };
    run.settled = Promise.resolve();
    throw new IdentityCheckError(code, text, status ?? LAUNCH_STATUS[code] ?? 500);
  }

  async function finishError(run, code, message) {
    await closeHandle();
    if (run.cancelled) return;
    job = {
      ...job,
      state: "error",
      error: cap(messageOf({ message }), 240),
      errorCode: code,
      finishedAt: now(),
    };
  }

  async function notify(run, verdict, checkedAt) {
    try {
      await onCheck({
        ok: true,
        provider: run.provider,
        key: run.key,
        proxyId: run.proxyMeta.proxyId,
        proxyName: run.proxyMeta.proxyName,
        region: run.proxyMeta.region,
        type: run.proxyMeta.type,
        grade: verdict.grade,
        exposure: verdict.exposure,
        summary: verdict.summary,
        fingerprintId: verdict.fingerprintId,
        checkedAt,
      });
    } catch {
      // A ledger write failure must not turn a real verdict into an error.
    }
  }

  async function measure(run) {
    let result;
    try {
      result = await withTimeout(
        run.browser.result,
        effectiveTimeout,
        () => new IdentityCheckError("page_timeout", "The identity page did not return a verdict in time.", 504),
      );
    } catch (error) {
      if (run.cancelled) return;
      await finishError(run, errorCodeOf(error?.code), messageOf(error));
      return;
    }
    if (run.cancelled) return;

    const verdict = parseWhoVerdict(result?.text);
    if (!verdict) {
      await finishError(run, "verdict_missing", "The identity page returned no readable verdict.");
      return;
    }
    const checkedAt = now();
    job = {
      ...job,
      state: "done",
      grade: verdict.grade,
      exposure: verdict.exposure,
      summary: verdict.summary,
      fingerprintId: verdict.fingerprintId,
      error: "",
      errorCode: "",
      finishedAt: checkedAt,
    };
    // The ONLY write path: a failure or a cancel never reaches this line.
    await notify(run, verdict, checkedAt);
  }

  async function start({ provider, key, proxy = null } = {}) {
    if (current && !TERMINAL.has(job.state)) {
      throw new IdentityCheckError("check_busy", "An identity check is already running.", 409);
    }

    // Reserve the slot synchronously, before the first await, so two
    // concurrent starts can never both get past the busy check.
    const proxyMeta = publicProxyMeta(proxy);
    job = {
      ...idleCheckJob(),
      state: "launching",
      provider: typeof provider === "string" ? provider : "",
      key: typeof key === "string" ? key : "",
      ...proxyMeta,
      startedAt: now(),
    };
    const run = {
      provider: job.provider,
      key: job.key,
      proxy,
      proxyMeta,
      cancelled: false,
      browser: null,
      settled: Promise.resolve(),
    };
    current = run;

    await closeHandle();

    const dir = accountDir(env, run.provider, run.key);
    let meta;
    try {
      meta = await readAccountMeta(dir);
    } catch {
      meta = null;
    }
    if (!meta) {
      return failStart(run, "account_not_found", "The account ledger was not found.", 404);
    }
    let identity;
    try {
      identity = await readIdentity(dir);
    } catch {
      identity = null;
    }
    if (!identity) {
      return failStart(
        run,
        "identity_missing",
        "This account has no pinned browser identity yet.",
        409,
      );
    }

    let executablePath;
    try {
      executablePath = await resolveExecutable({ env, environment });
    } catch {
      executablePath = null;
    }
    if (!executablePath) {
      return failStart(
        run,
        "browser_missing",
        "The login browser is not installed; prepare it on the Providers page first.",
        503,
      );
    }

    try {
      run.browser = await launchBrowser({
        executablePath,
        url: CHECK_URL,
        profileDir: checkProfileDir(dir),
        identity,
        proxy,
        headless: true,
        timeoutMs: effectiveTimeout,
      });
      handle = run.browser;
    } catch (error) {
      const code = errorCodeOf(error?.code);
      return failStart(
        run,
        code,
        messageOf(error, "The identity browser could not be opened."),
        error?.status ?? LAUNCH_STATUS[code],
      );
    }

    if (run.cancelled) {
      await closeHandle();
      run.settled = Promise.resolve();
      return publicJob(job);
    }
    job = { ...job, state: "checking" };
    run.settled = measure(run);
    return publicJob(job);
  }

  function status() {
    return { job: publicJob(job), browserOpen: Boolean(handle) };
  }

  async function cancel() {
    const run = current;
    if (!run) return { cancelled: false, job: publicJob(job) };
    if (!TERMINAL.has(job.state)) {
      run.cancelled = true;
      job = { ...job, state: "cancelled", error: "", errorCode: "cancelled", finishedAt: now() };
      await closeHandle();
      return { cancelled: true, job: publicJob(job) };
    }
    const hadWindow = Boolean(handle);
    if (hadWindow) await closeHandle();
    return { cancelled: hadWindow, job: publicJob(job) };
  }

  async function close() {
    if (current) current.cancelled = true;
    await closeHandle();
  }

  return {
    states: CHECK_STATES,
    start,
    status,
    cancel,
    close,
    whenSettled: () => current?.settled ?? Promise.resolve(),
  };
}
