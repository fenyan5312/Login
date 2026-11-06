// The Trust Score column and the score job wiring. Pure helpers are imported;
// the rest is read-file style like providers-ui.test.mjs / signin-ui.test.mjs.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isScoreActive, isScoreSettled, scoreTone, scoreView } from "../ui/proxy-score.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

test("scoreTone uses the >=80 green / 50-79 yellow / <50 red thresholds", () => {
  expect(scoreTone(100)).toBe("good");
  expect(scoreTone(80)).toBe("good");
  expect(scoreTone(79)).toBe("warn");
  expect(scoreTone(50)).toBe("warn");
  expect(scoreTone(49)).toBe("bad");
  expect(scoreTone(0)).toBe("bad");
  expect(scoreTone(null)).toBe("none");
  expect(scoreTone(undefined)).toBe("none");
});

test("scoreView describes scored, failed and unscored rows", () => {
  expect(scoreView({ score: 93, scoreLabel: "Excellent", scoreIp: "1.2.3.4", scoreCheckedAt: "2026-11-03T00:00:00.000Z" }))
    .toEqual({
      state: "scored",
      score: 93,
      label: "Excellent",
      ip: "1.2.3.4",
      checkedAt: "2026-11-03T00:00:00.000Z",
      error: "",
      errorCode: "",
      tone: "good",
    });
  expect(scoreView({ score: null, scoreError: "no score element", scoreErrorCode: "score_missing" }))
    .toMatchObject({ state: "failed", score: null, error: "no score element", errorCode: "score_missing" });
  expect(scoreView({})).toMatchObject({ state: "none", score: null, tone: "none" });
  // An error wins over an old value so a failure is never hidden.
  expect(scoreView({ score: 88, scoreError: "timeout" })).toMatchObject({ state: "failed", score: 88 });
});

test("isScoreActive and isScoreSettled partition the job state machine", () => {
  for (const state of ["launching", "measuring"]) {
    expect(isScoreActive(state)).toBe(true);
    expect(isScoreSettled(state)).toBe(false);
  }
  for (const state of ["done", "error", "cancelled"]) {
    expect(isScoreActive(state)).toBe(false);
    expect(isScoreSettled(state)).toBe(true);
  }
  for (const state of ["idle", "", undefined]) {
    expect(isScoreActive(state)).toBe(false);
    expect(isScoreSettled(state)).toBe(false);
  }
});

test("the row starts the score job and polls until it settles", () => {
  expect(app).toContain("api/proxies/${encodeURIComponent(id)}/score");
  expect(app).toContain('api("api/proxy-score")');
  expect(app).toContain("startScorePolling()");
  expect(app).toContain("stopScorePolling()");
  expect(app).toContain("isScoreSettled(state)");
  // On settle the list is re-read instead of trusting the job payload.
  expect(app).toContain('await api("api/proxies")');
  expect(app).toContain("await reloadProxies()");
});

test("the page refuses concurrency and surfaces the server's 409 score_busy", () => {
  expect(app).toContain('error?.code === "score_busy"');
  expect(app).toContain("text.scoreBusy");
  expect(app).toContain("function adoptScoreJob()");
  // A second run while one is active is blocked before any request.
  expect(app).toContain("if (scoreStarting || isScoreActive(scoreJob?.state))");
});

test("the cancel entry really posts to /api/proxy-score/cancel", () => {
  expect(app).toContain('api("api/proxy-score/cancel", { method: "POST" })');
  expect(app).toContain('byId("score-cancel").addEventListener("click", cancelScore)');
  // The window-closing entry is only offered while it can actually do something.
  expect(app).toContain("cancel.hidden = !(active || scoreBrowserOpen)");
});

test("a score failure shows the server's own code and message", () => {
  expect(app).toContain("scoreJob?.errorCode");
  expect(app).toContain("scoreJob?.error");
  expect(app).toContain("text.scoreFailed");
  expect(app).toContain("proxy-score-error");
  expect(app).not.toContain("scoreUnknownError");
});

test("a measuring navigation warning keeps the measuring text and shows scoreNavigationFailed", () => {
  const bar = /function renderScoreBar\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] || "";
  expect(bar).toContain('state === "measuring" ? text.scoreStateMeasuring : text.scoreStateLaunching');
  expect(bar).toContain("scoreJob?.warning");
  expect(bar).toContain('navigationWarningText(scoreJob?.warning, "scoreNavigationFailed")');
  expect(bar).toContain('message = `${message} · ${warning}`');
  expect(app).toContain("scoreNavigationFailed:");
  const cell = /function proxyScoreCell\(proxy\) \{[\s\S]*?\n\}/.exec(app)?.[0] || "";
  expect(cell).toContain("text.scoring");
});

test("the Score column and controls are sandbox-safe type=button elements", () => {
  expect(html).toContain('id="col-score"');
  expect(html).not.toContain('type="submit"');

  const head = /<div class="proxy-table-head"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  expect(head).toContain('id="col-score"');
  expect(head).toContain('id="col-checked"');

  const scoreBar = /<div class="proxy-score-bar"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  expect(scoreBar).toContain('id="score-cancel"');
  expect(scoreBar).toContain('type="button"');
  // Every score button the row builds is an explicit type=button.
  expect(app).toContain("const score = miniButton(running ? text.scoring : text.scoreAction");
});

test("every new string exists in all four language tables", () => {
  const keys = [
    "colScore",
    "scoreAction",
    "scoring",
    "scoreFailed",
    "scoreBusy",
    "scoreStateLaunching",
    "scoreStateMeasuring",
    "scoreStateDone",
    "scoreStateError",
    "scoreNavigationFailed",
    "scoreStateCancelled",
    "scoreCancel",
    "filterRegionLabel",
    "filterAllRegions",
    "filterLatencyLabel",
    "filterLatencyMin",
    "filterLatencyMax",
    "filterReset",
    "filterCount",
    "filterNoMatch",
    "regionUntested",
  ];
  for (const key of keys) {
    const count = (app.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  }
});
