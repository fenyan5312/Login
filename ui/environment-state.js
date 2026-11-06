// Pure helpers for the one-time login-browser setup card. Keeping them out of
// app.js lets the tests exercise the phase/progress rules without a DOM.

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

// A job's transient state (preparing/error/cancelled) is what the user just
// asked for; a ready environment always wins over an old failed attempt.
export function environmentPhase(environment = {}, job = null) {
  const jobState = job?.state;
  const state = environment?.state;
  if (jobState === "preparing" || state === "preparing") return "preparing";
  if (environment?.ready === true || state === "ready") return "ready";
  if (jobState === "error" || state === "error") return "error";
  if (jobState === "cancelled" || state === "cancelled") return "cancelled";
  return "missing";
}

export function environmentPercent(environment = {}, job = null) {
  const progress = job?.progress || {};
  const reported = Number(progress.percent);
  if (Number.isFinite(reported)) {
    return Math.max(0, Math.min(100, Math.round(reported)));
  }
  const total = Number(progress.totalBytes) || Number(environment?.downloadBytes) || 0;
  const received = Number(progress.receivedBytes) || 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}
