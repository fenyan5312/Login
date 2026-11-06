// Launching the isolated login browser for one account.
//
// The browser is a stock Camoufox driven by playwright-core. It runs as its
// own operating-system process, and the service only holds a handle to it, so
// a slow sign-in never blocks the loopback service. Two entry points exist:
//
//   * `launchSignInBrowser(...)` is what the sign-in flow calls. It forks a
//     small host process (`signin-browser-host.mjs`) that owns the browser,
//     waits for the host to report either "ready" or an error, and returns
//     `{ pid, close() }` immediately after. The service never waits on the
//     login itself.
//   * `openSignInBrowser(...)` is the in-process launch the host runs. It is
//     exported so the host stays a thin wrapper and so the option builder can
//     be unit tested.
//
// Nothing here is a security boundary on its own: the profile is persistent
// per account and the fingerprint is pinned by the caller (see
// account-identity.mjs), because re-presenting one credential from several
// fingerprints trips the provider's risk control. `canvas_noise` is off so the
// browser does not add per-launch canvas noise on top of the pinned identity.

import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintModelDir } from "./browser-environment.mjs";

const HOST_PATH = fileURLToPath(new URL("./signin-browser-host.mjs", import.meta.url));
const SCORE_HOST_PATH = fileURLToPath(new URL("./score-browser-host.mjs", import.meta.url));
const IDENTITY_HOST_PATH = fileURLToPath(
  new URL("./identity-check-browser-host.mjs", import.meta.url),
);

// Playwright defaults to `waitUntil: "load"` with a 30s deadline. OAuth and
// trust-score pages can stay open and usable without ever firing `load`, so the
// first navigation gets its own explicit deadline and readiness condition.
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
export const NAVIGATION_ERROR_CODE = "navigation_failed";
const NAVIGATION_STATUS = 504;
const NAVIGATION_WAIT_UNTIL = "domcontentloaded";

function normalizeNavTimeoutMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_NAVIGATION_TIMEOUT_MS;
}

// Only the safe, displayable part of a navigation error crosses IPC. The raw
// browser message is kept on the in-process handle for debugging, never sent.
export function navigationWarning(error) {
  if (!error) return null;
  return {
    code: typeof error.code === "string" ? error.code : NAVIGATION_ERROR_CODE,
    status: Number.isFinite(error.status) ? error.status : NAVIGATION_STATUS,
    message: String(error.message ?? "The page did not finish loading."),
  };
}

export class SignInBrowserError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "SignInBrowserError";
    this.code = code;
    this.status = status;
  }
}

// The score launch mirrors the sign-in launch, but its host reports a measured
// trust score instead of a ready login window. A distinct error type keeps the
// two channels from being confused in a catch block.
export class ScoreBrowserError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "ScoreBrowserError";
    this.code = code;
    this.status = status;
  }
}

// Converts the proxy record the page stores into the shape playwright-core
// expects. A record already in `{ server }` form passes through.
export function toPlaywrightProxy(proxy) {
  if (!proxy || typeof proxy !== "object") return null;
  if (typeof proxy.server === "string" && proxy.server) {
    const out = { server: proxy.server };
    if (proxy.username) out.username = String(proxy.username);
    if (proxy.password) out.password = String(proxy.password);
    if (proxy.bypass) out.bypass = String(proxy.bypass);
    return out;
  }
  const host = typeof proxy.host === "string" ? proxy.host : "";
  const port = Number(proxy.port);
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  const scheme =
    proxy.type === "socks5" || proxy.type === "socks4"
      ? proxy.type
      : proxy.type === "https"
        ? "https"
        : "http";
  const out = { server: `${scheme}://${host}:${port}` };
  if (proxy.username) out.username = String(proxy.username);
  if (proxy.password) out.password = String(proxy.password);
  return out;
}

// The options handed to camoufox. Kept as a pure function so the pin, the
// persistent profile and the proxy/geoip coupling can be asserted without a
// browser. `headless` defaults to false so an ordinary sign-in still shows
// its window; the identity check passes true.
export function buildLaunchInput({ url, profileDir, identity, proxy, modelDir, headless = false } = {}) {
  const playwrightProxy = toPlaywrightProxy(proxy);
  return {
    url,
    // The fingerprint model directory the host must point fpgen at before
    // camoufox draws anything. It travels as launch input, never as an
    // environment variable (see openSignInBrowser).
    modelDir: modelDir ?? null,
    launch: {
      // Persistent context: cookies and the provider's own session survive so
      // the user does not have to sign in again on the next account action.
      persistent_context: true,
      user_data_dir: profileDir,
      headless: Boolean(headless),
      // The pin is the account's own stored fingerprint, never a freshly
      // drawn one.
      fingerprint: identity ?? undefined,
      canvas_noise: false,
      ...(playwrightProxy ? { proxy: playwrightProxy, geoip: true } : {}),
    },
  };
}

async function defaultCheckExecutable(executablePath) {
  try {
    return (await stat(executablePath)).isFile();
  } catch {
    return false;
  }
}

async function assertExecutable(executablePath, check) {
  if (typeof executablePath !== "string" || !executablePath) {
    throw new SignInBrowserError(
      "executable_missing",
      "The login browser is not installed; prepare it on the Providers page first.",
      503,
    );
  }
  if (!(await check(executablePath))) {
    throw new SignInBrowserError(
      "executable_missing",
      `The login browser executable was not found at ${executablePath}.`,
      503,
    );
  }
}

// The in-process launch, run inside the forked host. `deps` is injectable so
// the host can be replaced in tests without importing camoufox.
export async function openSignInBrowser({
  executablePath,
  url,
  profileDir,
  identity,
  proxy,
  modelDir,
  headless = false,
  navTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  deps = {},
} = {}) {
  if (typeof url !== "string" || !url) {
    throw new SignInBrowserError("url_missing", "The sign-in method returned no URL.", 502);
  }
  if (!profileDir) {
    throw new SignInBrowserError("profile_missing", "The account has no browser profile directory.", 500);
  }
  const navigationTimeoutMs = normalizeNavTimeoutMs(navTimeoutMs);
  await assertExecutable(executablePath, deps.checkExecutable ?? defaultCheckExecutable);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const input = buildLaunchInput({ url, profileDir, identity, proxy, modelDir, headless });
  // fpgen resolves its model directory as `configuredDir || FPGEN_DATA_DIR ||
  // userCacheDir("fpgen")`, with one module-level `configuredDir`. Setting the
  // correctly named FPGEN_DATA_DIR here is only a fallback: importing camoufox
  // overwrites configuredDir with the user-shared cache, and configuredDir
  // outranks the environment. The explicit setModelDir below is what actually
  // decides the directory.
  if (input.modelDir) process.env.FPGEN_DATA_DIR = input.modelDir;
  let camoufox;
  try {
    camoufox = await (deps.loadCamoufox ?? (() => import("camoufox")))();
  } catch (error) {
    throw new SignInBrowserError(
      "runtime_missing",
      `The login browser runtime could not be loaded: ${String(error?.message ?? error)}`,
      503,
    );
  }
  // Point fpgen at the plugin's own model AFTER camoufox has been imported:
  // camoufox's paths.js calls setModelDir(<INSTALL_DIR>/fpgen) as it evaluates,
  // so doing this before the import would be undone. The directory arrives as
  // launch input, not as an environment variable, precisely because camoufox
  // overrides the variable at import time.
  if (input.modelDir) {
    try {
      const fpgen = await (deps.loadFpgen ?? (() => import("fpgen-js")))();
      fpgen.setModelDir(input.modelDir);
    } catch (error) {
      throw new SignInBrowserError(
        "runtime_missing",
        `The fingerprint runtime could not be loaded: ${String(error?.message ?? error)}`,
        503,
      );
    }
  }
  let firefox;
  try {
    ({ firefox } = await (deps.loadPlaywright ?? (() => import("playwright-core")))());
  } catch (error) {
    throw new SignInBrowserError(
      "runtime_missing",
      `playwright-core could not be loaded: ${String(error?.message ?? error)}`,
      503,
    );
  }

  let context;
  let page;
  try {
    const fromOptions = await camoufox.launchOptions({
      executable_path: executablePath,
      headless: Boolean(headless),
      fingerprint: input.launch.fingerprint,
      canvas_noise: input.launch.canvas_noise,
      // The account's exit and its geo identity are one unit: with a proxy we
      // ask Camoufox to look the exit up through it and pin timezone, locale,
      // geolocation and the WebRTC address to that IP. A failed lookup throws
      // instead of leaving the host's identity in place.
      ...(input.launch.proxy ? { proxy: input.launch.proxy, geoip: true } : {}),
      // WebRTC is never needed by a sign-in page. Disabling it is the only
      // complete leak fix: hiding the host IP still leaves ICE/STUN traffic to
      // discover the real network.
      block_webrtc: true,
      // DNS leak protection. With a SOCKS exit, resolve names at the proxy, not
      // on this host; never let a failed proxy silently fall back to a direct
      // connection; and turn off the prefetch/DoH paths that can resolve a
      // name outside the proxy.
      firefox_user_prefs: {
        "network.proxy.socks_remote_dns": true,
        "network.proxy.failover_direct": false,
        "network.trr.mode": 5,
        "network.dns.disablePrefetch": true,
        "network.prefetch-next": false,
        "network.predictor.enabled": false,
        "media.peerconnection.ice.no_host": true,
      },
    });
    fromOptions.user_data_dir = profileDir;
    context = await camoufox.NewBrowser(firefox, {
      from_options: fromOptions,
      persistent_context: true,
      headless: Boolean(headless),
    });
    page = context.pages?.()[0] ?? (await context.newPage());
    if (!page || typeof page.goto !== "function") {
      throw new Error("The login browser opened no page.");
    }
  } catch (error) {
    try {
      await context?.close();
    } catch {
      // The context may not exist yet; nothing to clean up.
    }
    throw new SignInBrowserError(
      "launch_failed",
      `The login browser could not be opened: ${String(error?.message ?? error)}`,
      502,
    );
  }

  // Navigation is a separate phase: once the browser and page exist, a slow
  // page must not be reported as a failed launch or close the user's window.
  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: NAVIGATION_WAIT_UNTIL, timeout: navigationTimeoutMs });
  } catch (error) {
    const seconds = Math.ceil(navigationTimeoutMs / 1000);
    navigationError = new SignInBrowserError(
      NAVIGATION_ERROR_CODE,
      `The login browser is open, but the page did not finish loading within ${seconds} seconds. You can still complete the sign-in in the open window.`,
      NAVIGATION_STATUS,
    );
    navigationError.timeoutMs = navigationTimeoutMs;
    navigationError.waitUntil = NAVIGATION_WAIT_UNTIL;
    navigationError.detail = String(error?.message ?? error);
  }

  let closed = false;
  return {
    context,
    page,
    navigationError,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await context.close();
      } catch {
        // Closing an already-closed window is not an error worth reporting.
      }
    },
  };
}

// Fork the host process, wait for it to report that the browser is open, and
// resolve with a handle. A launch failure inside the host comes back as a
// message, so the caller gets a real reason instead of a silent orphan.
export async function launchSignInBrowser({
  executablePath,
  url,
  profileDir,
  identity,
  proxy,
  modelDir,
  navTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  timeoutMs = 60_000,
  env = process.env,
  deps = {},
} = {}) {
  if (typeof url !== "string" || !url) {
    throw new SignInBrowserError("url_missing", "The sign-in method returned no URL.", 502);
  }
  if (!profileDir) {
    throw new SignInBrowserError("profile_missing", "The account has no browser profile directory.", 500);
  }
  await assertExecutable(executablePath, deps.checkExecutable ?? defaultCheckExecutable);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const resolvedModelDir = modelDir ?? fingerprintModelDir(env);
  const navigationTimeoutMs = normalizeNavTimeoutMs(navTimeoutMs);
  const payloadPath = join(profileDir, `.signin-launch.${process.pid}.${randomUUID()}.json`);
  await writeFile(
    payloadPath,
    `${JSON.stringify({ executablePath, url, profileDir, identity, proxy, modelDir: resolvedModelDir, navTimeoutMs: navigationTimeoutMs })}\n`,
    { mode: 0o600 },
  );

  const spawnHost = deps.fork ?? fork;
  let child;
  try {
    child = spawnHost(deps.hostPath ?? HOST_PATH, [payloadPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: false,
      // FPGEN_DATA_DIR is the name fpgen-js actually reads. It is only a
      // fallback: the host also receives the directory in its launch input and
      // calls setModelDir, because importing camoufox overwrites configuredDir.
      env: { ...env, FPGEN_DATA_DIR: resolvedModelDir },
    });
  } catch (error) {
    await rm(payloadPath, { force: true }).catch(() => {});
    throw new SignInBrowserError(
      "launch_failed",
      `The login browser host could not be started: ${String(error?.message ?? error)}`,
      502,
    );
  }

  let warning = null;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(
        () => done(reject, new SignInBrowserError("launch_timeout", "The login browser did not open in time.", 504)),
        timeoutMs,
      );
      child.on("message", (message) => {
        if (message?.type === "ready") {
          warning = message.warning ?? null;
          done(resolve);
        } else if (message?.type === "error") {
          done(reject, new SignInBrowserError(message.code ?? "launch_failed", String(message.message ?? "The login browser failed to open."), message.status ?? 502));
        }
      });
      child.once("error", (error) =>
        done(reject, new SignInBrowserError("launch_failed", `The login browser host failed: ${String(error?.message ?? error)}`, 502)),
      );
      child.once("exit", (code) => {
        if (!settled) {
          done(reject, new SignInBrowserError("launch_failed", `The login browser host exited before it opened the browser (code ${code}).`, 502));
        }
      });
    });
  } catch (error) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await rm(payloadPath, { force: true }).catch(() => {});
    throw error;
  }
  await rm(payloadPath, { force: true }).catch(() => {});

  // The browser must outlive the request that asked for it. Unref both the
  // child and its IPC channel so the service can exit with the window still
  // open; `close()` is the explicit way to end it.
  child.unref?.();
  child.channel?.unref?.();

  let closed = false;
  return {
    pid: child.pid,
    warning,
    async close() {
      if (closed) return;
      closed = true;
      try {
        child.send({ type: "close" });
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function withLaunchTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ScoreBrowserError("launch_timeout", "The scoring browser did not open in time.", 504));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
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

// Forks the score host, waits until the page window is open, and returns a
// handle. `result` settles with `{ score, label, ip }` when the host has read
// the trust score, or rejects with a `ScoreBrowserError`. The handle keeps the
// window open (the caller decides when to close it), and the forked host closes
// the browser on `disconnect`, so a service exit cannot leave an orphan.
export async function launchScoreBrowser({
  executablePath,
  url,
  profileDir,
  identity,
  proxy,
  modelDir,
  // First navigation has its own deadline; the page poll below is separate.
  navTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  // How long the host may poll the page for the score.
  timeoutMs = 60_000,
  // How long the window may take to open. A separate number: a slow browser
  // start must not eat the page's own deadline.
  launchTimeoutMs = 60_000,
  env = process.env,
  deps = {},
} = {}) {
  if (typeof url !== "string" || !url) {
    throw new ScoreBrowserError("url_missing", "The score page URL is missing.", 502);
  }
  if (!profileDir) {
    throw new ScoreBrowserError("profile_missing", "The scoring browser has no profile directory.", 500);
  }
  await assertExecutable(executablePath, deps.checkExecutable ?? defaultCheckExecutable);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const resolvedModelDir = modelDir ?? fingerprintModelDir(env);
  const navigationTimeoutMs = normalizeNavTimeoutMs(navTimeoutMs);
  const payloadPath = join(profileDir, `.score-launch.${process.pid}.${randomUUID()}.json`);
  await writeFile(
    payloadPath,
    `${JSON.stringify({
      executablePath,
      url,
      profileDir,
      identity,
      proxy,
      modelDir: resolvedModelDir,
      // The host owns the page poll, so it needs the same deadline.
      timeoutMs,
      // Never reuse timeoutMs: this is the first-navigation deadline.
      navTimeoutMs: navigationTimeoutMs,
    })}\n`,
    { mode: 0o600 },
  );

  const spawnHost = deps.fork ?? fork;
  let child;
  try {
    child = spawnHost(deps.hostPath ?? SCORE_HOST_PATH, [payloadPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: false,
      env: { ...env, FPGEN_DATA_DIR: resolvedModelDir },
    });
  } catch (error) {
    await rm(payloadPath, { force: true }).catch(() => {});
    throw new ScoreBrowserError(
      "launch_failed",
      `The scoring browser host could not be started: ${String(error?.message ?? error)}`,
      502,
    );
  }

  let warning = null;
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Never let a rejection nobody is awaiting crash the process; the caller
  // still gets the rejection when it awaits `handle.result`.
  readyPromise.catch(() => {});

  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {});

  child.on("message", (message) => {
    if (message?.type === "ready") {
      warning = message.warning ?? null;
      if (!ready) {
        ready = true;
        resolveReady();
      }
      return;
    }
    if (message?.type === "score") {
      resolveResult({ score: message.score, label: message.label, ip: message.ip });
      return;
    }
    if (message?.type === "error") {
      const error = new ScoreBrowserError(
        typeof message.code === "string" && message.code ? message.code : "launch_failed",
        String(message.message ?? "The scoring browser failed."),
        message.status ?? 502,
      );
      if (ready) rejectResult(error);
      else rejectReady(error);
    }
  });
  child.once("error", (error) => {
    const wrapped = new ScoreBrowserError(
      "launch_failed",
      `The scoring browser host failed: ${String(error?.message ?? error)}`,
      502,
    );
    if (ready) rejectResult(wrapped);
    else rejectReady(wrapped);
  });
  child.once("exit", (code) => {
    if (!ready) {
      rejectReady(
        new ScoreBrowserError(
          "launch_failed",
          `The scoring browser host exited before it opened the browser (code ${code}).`,
          502,
        ),
      );
    } else {
      rejectResult(
        new ScoreBrowserError(
          "launch_failed",
          `The scoring browser host exited before returning a score (code ${code}).`,
          502,
        ),
      );
    }
  });

  try {
    await withLaunchTimeout(readyPromise, launchTimeoutMs);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await rm(payloadPath, { force: true }).catch(() => {});
    throw error;
  }
  await rm(payloadPath, { force: true }).catch(() => {});

  // The window must outlive the request that opened it. Unref the child and
  // its IPC channel so the service can exit with the window still open; the
  // host shuts the browser down on `disconnect`, and `close()` is the explicit
  // way to end it.
  child.unref?.();
  child.channel?.unref?.();

  let closed = false;
  return {
    pid: child.pid,
    warning,
    result,
    async close() {
      if (closed) return;
      closed = true;
      try {
        child.send({ type: "close" });
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

// Forks the identity-check host. It is the score launcher's shape with two
// differences: the payload carries `headless` (the check runs without a
// window) and the deadline the host polls the page with, and the host reports
// the raw page text as `{ type: "identity", text }` instead of a score. The
// parent parses that text; nothing about the verdict is decided here.
export async function launchIdentityCheckBrowser({
  executablePath,
  url,
  profileDir,
  identity,
  proxy,
  modelDir,
  headless = true,
  timeoutMs,
  launchTimeoutMs = 60_000,
  env = process.env,
  deps = {},
} = {}) {
  if (typeof url !== "string" || !url) {
    throw new SignInBrowserError("url_missing", "The identity page URL is missing.", 502);
  }
  if (!profileDir) {
    throw new SignInBrowserError(
      "profile_missing",
      "The identity-check browser has no profile directory.",
      500,
    );
  }
  await assertExecutable(executablePath, deps.checkExecutable ?? defaultCheckExecutable);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const resolvedModelDir = modelDir ?? fingerprintModelDir(env);
  const payloadPath = join(profileDir, `.identity-check-launch.${process.pid}.${randomUUID()}.json`);
  await writeFile(
    payloadPath,
    `${JSON.stringify({
      executablePath,
      url,
      profileDir,
      identity,
      proxy,
      modelDir: resolvedModelDir,
      headless,
      timeoutMs,
    })}\n`,
    { mode: 0o600 },
  );

  const spawnHost = deps.fork ?? fork;
  let child;
  try {
    child = spawnHost(deps.hostPath ?? IDENTITY_HOST_PATH, [payloadPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: false,
      env: { ...env, FPGEN_DATA_DIR: resolvedModelDir },
    });
  } catch (error) {
    await rm(payloadPath, { force: true }).catch(() => {});
    throw new SignInBrowserError(
      "launch_failed",
      `The identity-check browser host could not be started: ${String(error?.message ?? error)}`,
      502,
    );
  }

  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readyPromise.catch(() => {});

  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {});

  child.on("message", (message) => {
    if (message?.type === "ready") {
      if (!ready) {
        ready = true;
        resolveReady();
      }
      return;
    }
    if (message?.type === "identity") {
      resolveResult({ text: typeof message.text === "string" ? message.text : "" });
      return;
    }
    if (message?.type === "error") {
      const error = new SignInBrowserError(
        typeof message.code === "string" && message.code ? message.code : "launch_failed",
        String(message.message ?? "The identity-check browser failed."),
        502,
      );
      if (ready) rejectResult(error);
      else rejectReady(error);
    }
  });
  child.once("error", (error) => {
    const wrapped = new SignInBrowserError(
      "launch_failed",
      `The identity-check browser host failed: ${String(error?.message ?? error)}`,
      502,
    );
    if (ready) rejectResult(wrapped);
    else rejectReady(wrapped);
  });
  child.once("exit", (code) => {
    if (!ready) {
      rejectReady(
        new SignInBrowserError(
          "launch_failed",
          `The identity-check browser host exited before it opened the browser (code ${code}).`,
          502,
        ),
      );
    } else {
      rejectResult(
        new SignInBrowserError(
          "launch_failed",
          `The identity-check browser host exited before returning a verdict (code ${code}).`,
          502,
        ),
      );
    }
  });

  try {
    await withLaunchTimeout(readyPromise, launchTimeoutMs);
  } catch (error) {
    // withLaunchTimeout reports a ScoreBrowserError for a shared helper; keep
    // the identity channel's error type consistent with its own launch errors.
    const wrapped =
      error?.code === "launch_timeout"
        ? new SignInBrowserError(
            "launch_timeout",
            "The identity-check browser did not open in time.",
            504,
          )
        : error;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await rm(payloadPath, { force: true }).catch(() => {});
    throw wrapped;
  }
  await rm(payloadPath, { force: true }).catch(() => {});

  child.unref?.();
  child.channel?.unref?.();

  let closed = false;
  return {
    pid: child.pid,
    result,
    async close() {
      if (closed) return;
      closed = true;
      try {
        child.send({ type: "close" });
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
