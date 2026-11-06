// The Claude trust-score check for one proxy exit.
//
// The user picks a proxy row and the service opens the plugin's own
// fingerprint browser at https://ip.net.coffee/claude/ through that proxy. The
// page draws its number client-side (it also runs DNS/WebRTC/UDP checks), so
// the score can take tens of seconds; the browser stack lives in a forked host
// (score-browser-host.mjs) and reports the parsed result over IPC.
//
// One check runs at a time. The window is kept open after a score is read so
// the user can look at the page; a new check, a cancel, or the host losing its
// parent closes it. A timeout is reported as `page_timeout` and never as a
// made-up number.

import { join } from "node:path";
import { EXECUTABLE_ENV } from "./browser-environment.mjs";
import { PROFILE_DIR_NAME, ensureIdentity } from "./account-identity.mjs";
import { DEFAULT_NAVIGATION_TIMEOUT_MS, ScoreBrowserError, launchScoreBrowser, navigationWarning } from "./browser-launcher.mjs";

export const SCORE_STATES = Object.freeze([
  "idle",
  "launching",
  "measuring",
  "done",
  "error",
  "cancelled",
]);

export const SCORE_URL = "https://ip.net.coffee/claude/";
export const SCORE_DIR_NAME = "score-browser";
export const SCORE_TIMEOUT_ENV = "MAGPIE_CLEAN_LOGIN_SCORE_TIMEOUT_MS";
export const DEFAULT_SCORE_TIMEOUT_MS = 90_000;
export const SCORE_LABEL_MAX = 40;
export const SCORE_IP_MAX = 80;
export const SCORE_ERROR_MAX = 240;
export const SCORE_ERROR_CODE_MAX = 48;

// The page's own element ids.
export const SCORE_SELECTOR = "#gaugeScore";
export const CLAUDE_IP_SELECTOR = "#ipAddrClaude";
export const DEFAULT_EXIT_IP_SELECTOR = "#ipAddr";
export const SCORE_POLL_INTERVAL_MS = 500;

const TERMINAL = new Set(["done", "error", "cancelled"]);

// Every code the job may carry. `proxy_not_found` and `score_busy` are decided
// by the route; the rest come from the launch/measure lifecycle.
export const SCORE_ERROR_CODES = Object.freeze([
  "browser_missing",
  "executable_missing",
  "launch_failed",
  "launch_timeout",
  "navigation_failed",
  "page_timeout",
  "score_missing",
  "cancelled",
  "proxy_not_found",
  "score_busy",
]);

const ALLOWED_CODES = new Set(SCORE_ERROR_CODES);

const LAUNCH_STATUS = {
  browser_missing: 503,
  executable_missing: 503,
  launch_failed: 502,
  launch_timeout: 504,
  navigation_failed: 504,
  page_timeout: 504,
  score_missing: 502,
};

export class ProxyScoreError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "ProxyScoreError";
    this.code = code;
    this.status = status;
  }
}

// The page puts the number and its evaluation phrase in one element, for
// example `92 优异`, and shows `— 无数据` when it has nothing. Pure and
// standalone so it can be asserted without a browser.
//
// The first integer-valued token inside 0..100 is the score; the rest of the
// text (with that token removed and separators trimmed) is the label. A string
// with no such token yields null, never a guess.
export function parseTrustScore(textContent) {
  if (typeof textContent !== "string") return null;
  const text = textContent.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const pattern = /\d+(?:\.\d+)?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[0]);
    if (!Number.isInteger(value) || value < 0 || value > 100) continue;
    const label = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—·:：|]+/, "")
      .replace(/[\s\-–—·:：|]+$/, "")
      .trim();
    return { score: value, label };
  }
  return null;
}

// The default timeout, overridable with the documented environment variable.
export function scoreTimeoutMs(env = process.env) {
  const raw = Number(env?.[SCORE_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SCORE_TIMEOUT_MS;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reads an element's text. A missing element is reported as an empty string,
// not an error: the page renders the gauge only after its own DNS/WebRTC
// checks, so "not there yet" is the normal state while polling.
export async function readElementText(page, selector) {
  if (!page || typeof page.$ !== "function") return "";
  let element;
  try {
    element = await page.$(selector);
  } catch {
    return "";
  }
  if (!element) return "";
  try {
    return (await element.textContent()) ?? "";
  } catch {
    return "";
  }
}

// The page links the full Claude exit address in the anchor's `href` and
// shortens only the visible text (a long IPv6 is abbreviated for display), so
// the href is the honest value to store. Falls back to the visible text when
// the page shows a bare address with no link, and to the default exit IP when
// the Claude one is not shown at all.
export async function readClaudeIp(page) {
  if (!page || typeof page.$ !== "function") return "";
  let anchor = null;
  try {
    anchor = await page.$(`${CLAUDE_IP_SELECTOR} a.ip-link`);
  } catch {
    anchor = null;
  }
  if (anchor && typeof anchor.getAttribute === "function") {
    try {
      const href = await anchor.getAttribute("href");
      const match = typeof href === "string" ? /^\/ip\/(.+)$/.exec(href) : null;
      if (match) {
        const decoded = decodeURIComponent(match[1]);
        if (decoded.trim()) return cap(decoded.trim(), SCORE_IP_MAX);
      }
    } catch {
      // A malformed href is not a reason to lose the address entirely.
    }
  }
  const visible = await readElementText(page, CLAUDE_IP_SELECTOR);
  if (visible.trim()) return cap(visible.trim(), SCORE_IP_MAX);
  return cap((await readElementText(page, DEFAULT_EXIT_IP_SELECTOR)).trim(), SCORE_IP_MAX);
}

// Polls the client-rendered page until the trust score appears. Returns
// `{ score, label, ip }`, or null when the deadline passed without one.
//
// The page draws its number only after its own checks, so this is a poll, not
// a read. `sleep` and `now` are injectable so the wait can be tested without
// a browser and without real time passing.
export async function waitForTrustScore(
  page,
  {
    timeoutMs = DEFAULT_SCORE_TIMEOUT_MS,
    intervalMs = SCORE_POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const gauge = await readElementText(page, SCORE_SELECTOR);
    const parsed = gauge ? parseTrustScore(gauge) : null;
    if (parsed) {
      // The Claude exit IP is the one the score belongs to; the default exit IP
      // is only a fallback when the Claude one is not shown.
      const ip = await readClaudeIp(page);
      return {
        score: parsed.score,
        label: cap(parsed.label, SCORE_LABEL_MAX),
        ip,
      };
    }
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// The one persistent scoring identity. It deliberately lives outside
// `accounts/`, because that tree is swept at startup against plugin-auth.json;
// it holds `identity.json` and `profile/`.
export function scoreBrowserDir(dataDir) {
  return join(dataDir, SCORE_DIR_NAME);
}

function cap(value, max) {
  if (typeof value !== "string") return "";
  return value.length <= max ? value : value.slice(0, max);
}

function messageOf(error, fallback = "The trust score check failed.") {
  const message = String(error?.message ?? error ?? "").trim();
  return message || fallback;
}

function idleJob() {
  return {
    state: "idle",
    proxyId: "",
    proxyName: "",
    score: null,
    label: "",
    ip: "",
    error: "",
    errorCode: "",
    warning: null,
    startedAt: null,
    finishedAt: null,
  };
}

// One `exit` listener for every controller this process ever creates. Each
// hook only fires the controller's best-effort close.
const shutdownHooks = new Set();
let exitRegistered = false;
function registerShutdown(hook) {
  shutdownHooks.add(hook);
  if (exitRegistered) return;
  exitRegistered = true;
  process.once?.("exit", () => {
    for (const item of shutdownHooks) {
      try {
        item();
      } catch {
        // Best effort on the way out.
      }
    }
  });
}

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

// Runs `promise` against a timer. The losing side is neutralised; a late
// resolution or rejection is ignored instead of overwriting the timeout.
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

function normalizeScore(result) {
  if (!result || typeof result !== "object") return null;
  if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) return null;
  return {
    score: result.score,
    label: cap(typeof result.label === "string" ? result.label : "", SCORE_LABEL_MAX),
    ip: cap(typeof result.ip === "string" ? result.ip : "", SCORE_IP_MAX),
  };
}

export function createProxyScore({
  env = process.env,
  dataDir,
  environment,
  launchBrowser = launchScoreBrowser,
  resolveExecutable = defaultResolveExecutable,
  ensureScoreIdentity = ensureIdentity,
  // Called once per finished attempt with the result to persist. It is where
  // the proxy store write lives; a failure here is swallowed so it can never
  // turn a real measurement into a fake error.
  onScore = async () => {},
  timeoutMs,
  // The first navigation's own deadline; distinct from the page poll above.
  navTimeoutMs,
  now = () => new Date().toISOString(),
} = {}) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : scoreTimeoutMs(env);
  const effectiveNavTimeout =
    Number.isFinite(navTimeoutMs) && navTimeoutMs > 0 ? Math.floor(navTimeoutMs) : DEFAULT_NAVIGATION_TIMEOUT_MS;
  const dir = dataDir ? scoreBrowserDir(dataDir) : null;
  const profileDir = dir ? join(dir, PROFILE_DIR_NAME) : null;

  let job = idleJob();
  let handle = null;
  let current = null;

  function publicJob() {
    return { ...job, warning: navigationWarning(job.warning) };
  }

  async function closeHandle() {
    const closing = handle;
    handle = null;
    if (!closing) return;
    try {
      await closing.close?.();
    } catch {
      // A window that refused to close must not change the recorded outcome.
    }
  }

  function failStart(run, code, message, status) {
    const text = cap(messageOf({ message }, "The trust score check failed."), SCORE_ERROR_MAX);
    const errorCode = cap(code, SCORE_ERROR_CODE_MAX);
    job = { ...job, state: "error", error: text, errorCode, finishedAt: now() };
    run.settled = Promise.resolve();
    throw new ProxyScoreError(errorCode, text, status ?? LAUNCH_STATUS[code] ?? 500);
  }

  // The job's error code is one of the documented ones, so it is never
  // truncated into something the page cannot recognise. The browser stack's
  // own codes are mapped onto it: a runtime that cannot be loaded is an
  // unprepared browser, not a failed launch.
  function errorCodeOf(code) {
    if (code === "runtime_missing") return "browser_missing";
    return ALLOWED_CODES.has(code) ? code : "launch_failed";
  }

  async function persist(run, result) {
    try {
      await onScore({
        proxyId: run.id,
        expectedUpdatedAt: run.expectedUpdatedAt,
        checkedAt: now(),
        ...result,
      });
    } catch {
      // The measurement still happened; the job reports it either way.
    }
  }

  async function finishError(run, code, message) {
    await closeHandle();
    if (run.cancelled) return;
    const text = cap(messageOf({ message }), SCORE_ERROR_MAX);
    const errorCode = cap(code, SCORE_ERROR_CODE_MAX);
    const checkedAt = now();
    job = { ...job, state: "error", score: null, label: "", ip: "", error: text, errorCode, finishedAt: checkedAt };
    await persist(run, { ok: false, error: text, errorCode, checkedAt });
  }

  async function measure(run) {
    let result;
    try {
      result = await withTimeout(
        run.browser.result,
        effectiveTimeout,
        () => new ScoreBrowserError("page_timeout", "The trust score page did not return a score in time.", 504),
      );
    } catch (error) {
      if (run.cancelled) return;
      const code = errorCodeOf(error?.code);
      await finishError(run, code, messageOf(error));
      return;
    }
    if (run.cancelled) return;

    const parsed = normalizeScore(result);
    if (!parsed) {
      await finishError(run, "score_missing", "The trust score page did not return a score.");
      return;
    }
    const checkedAt = now();
    job = { ...job, state: "done", score: parsed.score, label: parsed.label, ip: parsed.ip, error: "", errorCode: "", finishedAt: checkedAt };
    await persist(run, { ok: true, ...parsed, checkedAt });
    // The window stays open so the user can read the page; cancel() or the
    // next start() closes it.
  }

  async function start({ id, name = "", proxy = null, expectedUpdatedAt = null } = {}) {
    if (current && !TERMINAL.has(job.state)) {
      throw new ProxyScoreError("score_busy", "A trust score check is already running.", 409);
    }
    // Reserve the slot before the first await, so two concurrent starts can
    // never both get past the busy check.
    job = {
      state: "launching",
      proxyId: typeof id === "string" ? id : "",
      proxyName: cap(name, 80),
      score: null,
      label: "",
      ip: "",
      error: "",
      errorCode: "",
      warning: null,
      startedAt: now(),
      finishedAt: null,
    };
    const run = {
      id: job.proxyId,
      proxy,
      expectedUpdatedAt,
      cancelled: false,
      browser: null,
      settled: Promise.resolve(),
    };
    current = run;

    // Close a window left open by the previous run before replacing it, but
    // keep its recorded score: only a new attempt may overwrite it.
    await closeHandle();

    if (!dir || !profileDir) {
      failStart(run, "launch_failed", "The scoring browser has no data directory.", 500);
    }

    let executablePath;
    try {
      executablePath = await resolveExecutable({ env, environment });
    } catch {
      executablePath = null;
    }
    if (!executablePath) {
      failStart(
        run,
        "browser_missing",
        "The login browser is not installed; prepare it on the Providers page first.",
        503,
      );
    }

    let identity;
    try {
      const ensured = await ensureScoreIdentity(dir);
      identity = ensured?.identity;
    } catch (error) {
      // The fingerprint model is part of the browser environment: without it
      // the score browser has no identity to pin. That is the environment
      // being unprepared, not the launch failing.
      failStart(
        run,
        "browser_missing",
        messageOf(
          error,
          "The login browser is not installed; prepare it on the Providers page first.",
        ),
        503,
      );
    }

    try {
      run.browser = await launchBrowser({
        executablePath,
        url: SCORE_URL,
        profileDir,
        identity,
        proxy,
        // The host polls the page, so it gets the same deadline.
        timeoutMs: effectiveTimeout,
        // The first navigation has its own deadline; never reuse the poll's.
        navTimeoutMs: effectiveNavTimeout,
        // The window has its own, shorter deadline.
        launchTimeoutMs: Math.min(effectiveTimeout, 60_000),
      });
      handle = run.browser;
      // The browser is open even when its first navigation did not finish.
      // Keep the warning on the normal measuring state, not as an error.
      job = { ...job, warning: navigationWarning(run.browser?.warning) };
    } catch (error) {
      const code = errorCodeOf(error?.code);
      failStart(run, code, messageOf(error, "The scoring browser could not be opened."), error?.status);
    }

    if (run.cancelled) {
      await closeHandle();
      run.settled = Promise.resolve();
      return publicJob();
    }

    job = { ...job, state: "measuring" };
    run.settled = measure(run);
    // The route answers with the running job; measure() finishes in the
    // background and is read back through status().
    return publicJob();
  }

  function status() {
    return { job: publicJob(), browserOpen: Boolean(handle) };
  }

  async function cancel() {
    const run = current;
    if (!run) return { cancelled: false, job: publicJob() };
    if (!TERMINAL.has(job.state)) {
      run.cancelled = true;
      job = { ...job, state: "cancelled", error: "", errorCode: "cancelled", finishedAt: now() };
      await closeHandle();
      return { cancelled: true, job: publicJob() };
    }
    // Already finished: close the window only, never touch the recorded score.
    const hadWindow = Boolean(handle);
    if (hadWindow) await closeHandle();
    return { cancelled: hadWindow, job: publicJob() };
  }

  // Best-effort shutdown used when the service stops. It never waits on a
  // measurement and never throws.
  async function close() {
    if (current) current.cancelled = true;
    await closeHandle();
  }

  const shutdown = () => {
    // The host also closes the browser on `disconnect`, so a hard process exit
    // cannot leave an orphan window.
    void close();
  };
  registerShutdown(shutdown);

  return {
    states: SCORE_STATES,
    start,
    status,
    cancel,
    close,
    // Waits for the background measurement to reach a terminal state. Tests
    // use it; in production a GET reads status().
    whenSettled: () => current?.settled ?? Promise.resolve(),
  };
}
