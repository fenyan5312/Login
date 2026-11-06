// The trust-score controller. No browser is started, no page is fetched and
// no network request is made: the launcher is injected, the identity is
// injected, and the store write is injected.
//
// The pure parser is exercised on its own first, because it is the only part
// of the flow that has to be right about the page's text.

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScoreBrowserError } from "../lib/browser-launcher.mjs";
import {
  DEFAULT_SCORE_TIMEOUT_MS,
  SCORE_DIR_NAME,
  SCORE_TIMEOUT_ENV,
  createProxyScore,
  parseTrustScore,
  readClaudeIp,
  readElementText,
  scoreBrowserDir,
  scoreTimeoutMs,
  waitForTrustScore,
} from "../lib/proxy-score.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-score-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------- the pure parser ----------

test("the parser reads the number and the evaluation phrase", () => {
  expect(parseTrustScore("92 优异")).toEqual({ score: 92, label: "优异" });
  expect(parseTrustScore("  92   优异  ")).toEqual({ score: 92, label: "优异" });
  expect(parseTrustScore("0 危险")).toEqual({ score: 0, label: "危险" });
  expect(parseTrustScore("100 满分")).toEqual({ score: 100, label: "满分" });
  // The page puts the number first, but the parser does not depend on that.
  expect(parseTrustScore("良好 78")).toEqual({ score: 78, label: "良好" });
});

test("the parser reports no data instead of inventing a score", () => {
  // The page's empty state is `— 无数据`.
  expect(parseTrustScore("— 无数据")).toBeNull();
  expect(parseTrustScore("无数据")).toBeNull();
  expect(parseTrustScore("")).toBeNull();
  expect(parseTrustScore("   ")).toBeNull();
  expect(parseTrustScore(null)).toBeNull();
  expect(parseTrustScore(undefined)).toBeNull();
  expect(parseTrustScore(92)).toBeNull();
  // A number outside 0..100 is not a trust score.
  expect(parseTrustScore("101 优异")).toBeNull();
  expect(parseTrustScore("256 溢出")).toBeNull();
  expect(parseTrustScore("999")).toBeNull();
  // A decimal is not the integer the page shows.
  expect(parseTrustScore("92.5 优异")).toBeNull();
});

test("the parser keeps a label that is only words", () => {
  expect(parseTrustScore("42 一般")).toEqual({ score: 42, label: "一般" });
  expect(parseTrustScore("42")).toEqual({ score: 42, label: "" });
});

// ---------- reading the page ----------

// A fake page: the gauge appears only after the third read, exactly like the
// client-rendered page, which draws its number after its own checks.
function fakePage({ gauge, ip = "", after = 1 }) {
  let reads = 0;
  return {
    reads: () => reads,
    async $(selector) {
      reads += 1;
      const text = selector === "#gaugeScore"
        ? (typeof gauge === "function" ? gauge(reads) : reads >= after ? gauge : "")
        : selector === "#ipAddrClaude"
          ? ip
          : "";
      if (!text) return null;
      return { textContent: async () => text };
    },
  };
}

test("an element that is not on the page reads as empty", async () => {
  expect(await readElementText(fakePage({ gauge: "" }), "#gaugeScore")).toBe("");
  expect(await readElementText(null, "#gaugeScore")).toBe("");
  expect(await readElementText({}, "#gaugeScore")).toBe("");
  // A page that throws is treated as "not there yet", not as a crash.
  const broken = { async $() { throw new Error("detached"); } };
  expect(await readElementText(broken, "#gaugeScore")).toBe("");
});

test("the page is polled until the score appears", async () => {
  const page = fakePage({ gauge: "92 优异", ip: "203.0.113.7", after: 3 });
  let slept = 0;
  const result = await waitForTrustScore(page, {
    timeoutMs: 10_000,
    intervalMs: 500,
    sleep: async (ms) => { slept += ms; },
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
  });
  expect(result).toEqual({ score: 92, label: "优异", ip: "203.0.113.7" });
  // The page was read more than once: the number is not there at first.
  expect(page.reads()).toBeGreaterThan(1);
  expect(slept).toBeGreaterThan(0);
});

test("a page that never shows a score times out with no number", async () => {
  const page = fakePage({ gauge: "— 无数据" });
  const result = await waitForTrustScore(page, {
    timeoutMs: 1000,
    intervalMs: 500,
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
  });
  expect(result).toBeNull();
});

test("the default exit IP is the fallback when the Claude one is not shown", async () => {
  const page = {
    async $(selector) {
      if (selector === "#gaugeScore") return { textContent: async () => "92 优异" };
      if (selector === "#ipAddrClaude") return null;
      if (selector === "#ipAddr") return { textContent: async () => " 203.0.113.9 " };
      return null;
    },
  };
  const result = await waitForTrustScore(page, { sleep: async () => {} });
  expect(result).toEqual({ score: 92, label: "优异", ip: "203.0.113.9" });
});

// The page links the full address and shortens only the visible text (a long
// IPv6 is abbreviated), so a stored scoreIp taken from the text alone would be
// a display string rather than an address.
test("the full Claude address is read from the link, not the shortened text", async () => {
  const full = "2604:86c0:200c:d489:ee5:ce07:642d:d1d6";
  const page = {
    async $(selector) {
      if (selector === "#gaugeScore") return { textContent: async () => "60 良好" };
      if (selector === "#ipAddrClaude a.ip-link") {
        return { getAttribute: async () => `/ip/${encodeURIComponent(full)}` };
      }
      if (selector === "#ipAddrClaude") return { textContent: async () => "2604:86c0:200c:d48..." };
      return null;
    },
  };
  expect(await readClaudeIp(page)).toBe(full);
  const result = await waitForTrustScore(page, { sleep: async () => {} });
  expect(result).toEqual({ score: 60, label: "良好", ip: full });
});

test("a bare Claude address with no link falls back to its visible text", async () => {
  const page = {
    async $(selector) {
      if (selector === "#ipAddrClaude a.ip-link") return null;
      if (selector === "#ipAddrClaude") return { textContent: async () => " 203.0.113.7 " };
      return null;
    },
  };
  expect(await readClaudeIp(page)).toBe("203.0.113.7");
});

test("a link that does not point at an address falls back to the visible text", async () => {
  const page = {
    async $(selector) {
      if (selector === "#ipAddrClaude a.ip-link") {
        return { getAttribute: async () => "https://example.test/elsewhere" };
      }
      if (selector === "#ipAddrClaude") return { textContent: async () => "203.0.113.8" };
      return null;
    },
  };
  expect(await readClaudeIp(page)).toBe("203.0.113.8");
});

test("an anchor without getAttribute does not break the read", async () => {
  const page = {
    async $(selector) {
      if (selector === "#ipAddrClaude a.ip-link") return {};
      if (selector === "#ipAddrClaude") return { textContent: async () => "203.0.113.10" };
      return null;
    },
  };
  expect(await readClaudeIp(page)).toBe("203.0.113.10");
});

// ---------- the timeout ----------

test("the timeout defaults to 90 seconds and can be overridden", () => {
  expect(DEFAULT_SCORE_TIMEOUT_MS).toBe(90_000);
  expect(scoreTimeoutMs({})).toBe(90_000);
  expect(scoreTimeoutMs({ [SCORE_TIMEOUT_ENV]: "1500" })).toBe(1500);
  // A nonsense value falls back to the default instead of breaking the check.
  expect(scoreTimeoutMs({ [SCORE_TIMEOUT_ENV]: "abc" })).toBe(90_000);
  expect(scoreTimeoutMs({ [SCORE_TIMEOUT_ENV]: "0" })).toBe(90_000);
  expect(scoreTimeoutMs({ [SCORE_TIMEOUT_ENV]: "-5" })).toBe(90_000);
});

// ---------- the controller ----------

async function harness(overrides = {}) {
  const dataDir = await tempDir();
  const state = {
    launched: null,
    closed: 0,
    persisted: [],
    identityDirs: [],
  };
  let resolveScore;
  const scorePromise = new Promise((resolve) => {
    resolveScore = resolve;
  });
  const browser = {
    pid: 4321,
    result: overrides.browserResult ?? scorePromise,
    async close() {
      state.closed += 1;
    },
  };
  const controller = createProxyScore({
    env: overrides.env ?? {},
    dataDir,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    navTimeoutMs: overrides.navTimeoutMs,
    resolveExecutable: overrides.resolveExecutable ?? (async () => "/fake/browser"),
    ensureScoreIdentity: overrides.ensureScoreIdentity ?? (async (dir) => {
      state.identityDirs.push(dir);
      return { identity: { tag: "pin" }, created: true };
    }),
    launchBrowser: overrides.launchBrowser ?? (async (args) => {
      state.launched = args;
      return browser;
    }),
    onScore: overrides.onScore ?? (async (result) => {
      state.persisted.push(result);
    }),
  });
  return { dataDir, state, controller, browser, resolveScore };
}
test("the scoring browser lives outside the accounts tree", async () => {
  const dataDir = await tempDir();
  expect(scoreBrowserDir(dataDir)).toBe(join(dataDir, SCORE_DIR_NAME));
  // It must never be swept by the account orphan prune, which scans
  // `accounts/` against plugin-auth.json.
  expect(scoreBrowserDir(dataDir).startsWith(join(dataDir, "accounts"))).toBe(false);
});

test("a score is read, kept on the job and persisted", async () => {
  const { dataDir, controller, state, resolveScore } = await harness();
  const job = await controller.start({ id: "p1", name: "SG 01", proxy: { host: "h", port: 1 } });
  // The window is open and the page is being polled.
  expect(job.state).toBe("measuring");
  expect(job.proxyId).toBe("p1");
  expect(job.proxyName).toBe("SG 01");
  expect(job.score).toBe(null);
  expect(job.startedAt).toBeTruthy();
  expect(job.finishedAt).toBe(null);

  // The browser was opened through the scoring profile with the proxy.
  expect(state.launched.url).toBe("https://ip.net.coffee/claude/");
  expect(state.launched.profileDir).toBe(join(scoreBrowserDir(dataDir), "profile"));
  expect(state.launched.identity).toEqual({ tag: "pin" });
  expect(state.launched.proxy).toEqual({ host: "h", port: 1 });

  resolveScore({ score: 92, label: "优异", ip: "203.0.113.7" });
  await controller.whenSettled();

  const view = controller.status();
  expect(view.job.state).toBe("done");
  expect(view.job.score).toBe(92);
  expect(view.job.label).toBe("优异");
  expect(view.job.ip).toBe("203.0.113.7");
  expect(view.job.error).toBe("");
  expect(view.job.errorCode).toBe("");
  expect(view.job.finishedAt).toBeTruthy();
  // The window stays open so the user can look at the page.
  expect(view.browserOpen).toBe(true);
  expect(state.closed).toBe(0);

  expect(state.persisted).toHaveLength(1);
  expect(state.persisted[0]).toMatchObject({
    proxyId: "p1",
    ok: true,
    score: 92,
    label: "优异",
    ip: "203.0.113.7",
  });
});

test("the measured score is stored and the identity is pinned once", async () => {
  const { dataDir, controller, state, resolveScore } = await harness();
  await controller.start({ id: "p1", name: "SG 01" });
  resolveScore({ score: 88, label: "良好", ip: "203.0.113.8" });
  await controller.whenSettled();
  // The identity lives in the scoring directory, not in an account directory.
  expect(state.identityDirs).toHaveLength(1);
  expect(state.identityDirs[0]).toBe(scoreBrowserDir(dataDir));
  expect(state.identityDirs[0].startsWith(join(dataDir, "accounts"))).toBe(false);
});

test("only one check runs at a time", async () => {
  const { controller, state } = await harness();
  await controller.start({ id: "p1", name: "SG 01" });
  await expect(controller.start({ id: "p2", name: "SG 02" })).rejects.toMatchObject({
    code: "score_busy",
    status: 409,
  });
  // The second start did not open a second browser.
  expect(state.launched.proxy?.host).toBeUndefined();
});

test("a missing browser is reported as browser_missing and starts nothing", async () => {
  const { controller, state } = await harness({ resolveExecutable: async () => null });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "browser_missing",
    status: 503,
  });
  expect(state.launched).toBe(null);
  const view = controller.status();
  expect(view.job.state).toBe("error");
  expect(view.job.errorCode).toBe("browser_missing");
  expect(view.job.score).toBe(null);
});

test("a missing executable is reported with its own code", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      throw new ScoreBrowserError("executable_missing", "The executable is gone.", 503);
    },
  });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "executable_missing",
    status: 503,
  });
  expect(controller.status().job.errorCode).toBe("executable_missing");
});

test("a fingerprint that cannot be pinned is an unprepared browser", async () => {
  const { controller, state } = await harness({
    ensureScoreIdentity: async () => {
      throw new Error("The fingerprint model (fpgen) is not installed.");
    },
  });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "browser_missing",
    status: 503,
  });
  expect(controller.status().job.errorCode).toBe("browser_missing");
  // No browser was opened.
  expect(state.launched).toBe(null);
});

test("a launch failure is reported as launch_failed", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      throw new ScoreBrowserError("launch_failed", "The browser refused to open.", 502);
    },
  });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "launch_failed",
  });
  expect(controller.status().job.state).toBe("error");
});

test("a browser runtime that cannot be loaded is an unprepared browser", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      throw new ScoreBrowserError("runtime_missing", "camoufox could not be loaded.", 503);
    },
  });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "browser_missing",
  });
  expect(controller.status().job.errorCode).toBe("browser_missing");
});

test("a first-navigation timeout is reported as navigation_failed, not launch_failed", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      throw new ScoreBrowserError(
        "navigation_failed",
        "The scoring browser is open, but the page did not finish loading within 60 seconds.",
        504,
      );
    },
  });
  await expect(controller.start({ id: "p1", name: "SG 01" })).rejects.toMatchObject({
    code: "navigation_failed",
    status: 504,
  });
  const view = controller.status();
  expect(view.job.state).toBe("error");
  expect(view.job.errorCode).toBe("navigation_failed");
  // The old catch-all folded everything into launch_failed; it must not.
  expect(view.job.errorCode).not.toBe("launch_failed");
});

test("the scoring launch passes its own navigation deadline to the launcher", async () => {
  const { controller, state, resolveScore } = await harness({ navTimeoutMs: 12_000 });
  await controller.start({ id: "p1", name: "SG 01" });
  expect(state.launched.navTimeoutMs).toBe(12_000);
  resolveScore({ score: 92, label: "优异", ip: "203.0.113.7" });
  await controller.whenSettled();
});

test("a navigation warning reaches publicJob with only the safe fields", async () => {
  const score = { score: 92, label: "优异", ip: "203.0.113.7" };
  const { controller } = await harness({
    browserResult: Promise.resolve(score),
    launchBrowser: async () => ({
      pid: 4321,
      result: Promise.resolve(score),
      warning: {
        code: "navigation_failed",
        status: 504,
        message: "The scoring browser opened, but the page did not finish loading.",
        url: "https://ip.net.coffee/claude/?code=SECRET-CODE",
        detail: "goto: Timeout 30000ms exceeded",
        stack: "Error: SECRET-STACK",
        user_code: "SECRET-CODE",
      },
      async close() {},
    }),
  });
  const started = await controller.start({ id: "p1", name: "SG 01" });
  expect(started.state).toBe("measuring");
  expect(started.proxyName).toBe("SG 01");
  expect(started.warning).toEqual({
    code: "navigation_failed",
    status: 504,
    message: "The scoring browser opened, but the page did not finish loading.",
  });
  expect(Object.keys(started.warning).sort()).toEqual(["code", "message", "status"]);
  expect(started.warning).not.toHaveProperty("url");
  expect(started.warning).not.toHaveProperty("detail");
  expect(started.warning).not.toHaveProperty("stack");
  expect(started.warning).not.toHaveProperty("user_code");
  expect(JSON.stringify(started)).not.toContain("SECRET");
  const view = controller.status();
  expect(view.job.state).toBe("measuring");
  expect(view.job.warning).toEqual(started.warning);
  await controller.whenSettled();
});

test("a page that never answers times out and never invents a score", async () => {
  const { controller, state } = await harness({
    timeoutMs: 30,
    browserResult: new Promise(() => {}),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  await controller.whenSettled();
  const view = controller.status();
  expect(view.job.state).toBe("error");
  expect(view.job.errorCode).toBe("page_timeout");
  expect(view.job.score).toBe(null);
  expect(view.job.label).toBe("");
  expect(view.job.ip).toBe("");
  // The failure is persisted as an error, never as a number.
  expect(state.persisted[0]).toMatchObject({ ok: false, errorCode: "page_timeout" });
  expect(state.persisted[0].score).toBeUndefined();
});

test("a score the page never gave is reported as score_missing", async () => {
  const { controller, state } = await harness({
    browserResult: Promise.resolve({ score: null, label: "", ip: "" }),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  await controller.whenSettled();
  const view = controller.status();
  expect(view.job.state).toBe("error");
  expect(view.job.errorCode).toBe("score_missing");
  expect(view.job.score).toBe(null);
  expect(state.persisted[0]).toMatchObject({ ok: false, errorCode: "score_missing" });
});

test("an out-of-range score is refused rather than clamped", async () => {
  const { controller } = await harness({
    browserResult: Promise.resolve({ score: 250, label: "溢出", ip: "" }),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  await controller.whenSettled();
  expect(controller.status().job.errorCode).toBe("score_missing");
  expect(controller.status().job.score).toBe(null);
});

test("cancelling a running check closes the window and marks it cancelled", async () => {
  const { controller, state } = await harness({
    browserResult: new Promise(() => {}),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  const cancelled = await controller.cancel();
  expect(cancelled.cancelled).toBe(true);
  expect(cancelled.job.state).toBe("cancelled");
  expect(cancelled.job.errorCode).toBe("cancelled");
  expect(state.closed).toBe(1);
  expect(controller.status().browserOpen).toBe(false);
});

test("cancelling after the score closed only the window and kept the score", async () => {
  const { controller, state, resolveScore } = await harness();
  await controller.start({ id: "p1", name: "SG 01" });
  resolveScore({ score: 92, label: "优异", ip: "203.0.113.7" });
  await controller.whenSettled();
  expect(controller.status().job.score).toBe(92);

  const cancelled = await controller.cancel();
  expect(cancelled.cancelled).toBe(true);
  // The recorded score is untouched.
  expect(cancelled.job.state).toBe("done");
  expect(cancelled.job.score).toBe(92);
  expect(cancelled.job.label).toBe("优异");
  expect(cancelled.job.ip).toBe("203.0.113.7");
  expect(state.closed).toBe(1);
  expect(controller.status().browserOpen).toBe(false);
});

test("a new check closes the window the previous one left open", async () => {
  const { controller, state, resolveScore } = await harness();
  await controller.start({ id: "p1", name: "SG 01" });
  resolveScore({ score: 92, label: "优异", ip: "" });
  await controller.whenSettled();
  expect(state.closed).toBe(0);
  await controller.start({ id: "p1", name: "SG 01" });
  expect(state.closed).toBe(1);
});

test("a cancelled check never writes a score", async () => {
  const { controller, state, resolveScore } = await harness({
    timeoutMs: 50,
    browserResult: new Promise(() => {}),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  await controller.cancel();
  resolveScore({ score: 92, label: "优异", ip: "" });
  await controller.whenSettled();
  expect(state.persisted).toHaveLength(0);
  expect(controller.status().job.score).toBe(null);
});

test("closing the controller closes the window", async () => {
  const { controller, state } = await harness({
    timeoutMs: 50,
    browserResult: new Promise(() => {}),
  });
  await controller.start({ id: "p1", name: "SG 01" });
  await controller.close();
  expect(state.closed).toBe(1);
  expect(controller.status().browserOpen).toBe(false);
});

test("the job shape is the documented one", async () => {
  const { controller } = await harness();
  const view = controller.status();
  expect(Object.keys(view).sort()).toEqual(["browserOpen", "job"]);
  expect(Object.keys(view.job).sort()).toEqual([
    "error",
    "errorCode",
    "finishedAt",
    "ip",
    "label",
    "proxyId",
    "proxyName",
    "score",
    "startedAt",
    "state",
    "warning",
  ]);
  expect(view.job.state).toBe("idle");
  expect(view.job.warning).toBe(null);
});
