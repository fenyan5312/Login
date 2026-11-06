// Pure helpers for the per-proxy Trust Score column and the score job state
// machine. Keeping them out of app.js lets the tests describe the view without
// a DOM. Nothing here performs I/O.

// The score job states that mean "still running". The row and the score bar
// use this to show progress and to refuse a second run instead of letting the
// server answer 409 without the user seeing why.
export const SCORE_ACTIVE_STATES = new Set(["launching", "measuring"]);
export const SCORE_SETTLED_STATES = new Set(["done", "error", "cancelled"]);

export function isScoreActive(state) {
  return SCORE_ACTIVE_STATES.has(String(state || ""));
}

export function isScoreSettled(state) {
  return SCORE_SETTLED_STATES.has(String(state || ""));
}

// Semantic colour for a 0..100 score: >=80 green, 50-79 yellow, <50 red.
export function scoreTone(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return "none";
  if (score >= 80) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

// The stored score of one proxy, shaped for the table cell. `state` is one of
// scored | failed | none. A record that carries both a score and a newer error
// is shown as failed so the honest failure is never hidden behind an old value.
export function scoreView(proxy = {}) {
  const score = typeof proxy?.score === "number" && Number.isFinite(proxy.score) ? proxy.score : null;
  const label = typeof proxy?.scoreLabel === "string" ? proxy.scoreLabel : "";
  const ip = typeof proxy?.scoreIp === "string" ? proxy.scoreIp : "";
  const checkedAt = typeof proxy?.scoreCheckedAt === "string" ? proxy.scoreCheckedAt : "";
  const error = typeof proxy?.scoreError === "string" ? proxy.scoreError : "";
  const errorCode = typeof proxy?.scoreErrorCode === "string" ? proxy.scoreErrorCode : "";
  if (error || errorCode) {
    return { state: "failed", score, label, ip, checkedAt, error, errorCode, tone: scoreTone(score) };
  }
  if (score !== null) {
    return { state: "scored", score, label, ip, checkedAt, error, errorCode, tone: scoreTone(score) };
  }
  return { state: "none", score: null, label, ip, checkedAt, error, errorCode, tone: "none" };
}