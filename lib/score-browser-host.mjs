// The scoring browser's host process.
//
// Forked by `launchScoreBrowser` with the path of a JSON payload as its only
// argument. It imports the browser stack (through `openSignInBrowser`, the
// same launch path the sign-in flow uses), opens the persistent scoring
// profile at the score page, then polls the client-rendered DOM until the
// trust score appears and sends `{ type: "score", score, label, ip }` back.
//
// It stays alive holding the window open until the parent asks it to close or
// the IPC channel drops; in both cases it closes the browser first, so a
// service exit cannot leave an orphan window.

import { readFile } from "node:fs/promises";
import { navigationWarning, openSignInBrowser } from "./browser-launcher.mjs";
import { scoreTimeoutMs, waitForTrustScore } from "./proxy-score.mjs";

function send(message) {
  try {
    process.send?.(message);
  } catch {
    // The parent is gone; the process is about to exit anyway.
  }
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    send({
      type: "error",
      code: "launch_failed",
      status: 502,
      message: "The scoring browser host was given no launch payload.",
    });
    process.exitCode = 1;
    return;
  }

  let handle;
  let timeoutMs;
  try {
    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    timeoutMs = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
      ? Math.floor(payload.timeoutMs)
      : scoreTimeoutMs(process.env);
    handle = await openSignInBrowser(payload);
  } catch (error) {
    send({
      type: "error",
      code: typeof error?.code === "string" ? error.code : "launch_failed",
      status: Number.isFinite(error?.status) ? error.status : 502,
      message: String(error?.message ?? error),
    });
    process.exitCode = 1;
    return;
  }

  const warning = navigationWarning(handle?.navigationError);
  send({ type: "ready", pid: process.pid, ...(warning ? { warning } : {}) });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
    process.exit(0);
  };
  process.on("message", (message) => {
    if (message?.type === "close") shutdown();
  });
  // The parent process exiting drops the channel; close the browser instead of
  // leaving it behind.
  process.on("disconnect", shutdown);
  handle.context?.on?.("close", () => process.exit(0));

  const page = handle.page;
  if (!page) {
    send({
      type: "error",
      code: "page_timeout",
      status: 504,
      message: "The scoring browser opened no page.",
    });
    return;
  }

  const result = await waitForTrustScore(page, { timeoutMs });
  if (closing) return;
  if (!result) {
    send({
      type: "error",
      code: "page_timeout",
      status: 504,
      message: "The trust score page did not return a score in time.",
    });
    return;
  }
  send({ type: "score", score: result.score, label: result.label, ip: result.ip });
  // Stop polling, but keep the window open for the user; the parent closes
  // it (or the channel drops and shutdown runs).
}

main();
