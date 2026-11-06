// The identity-check browser's host process.
//
// Forked by `launchIdentityCheckBrowser` with a JSON payload path as its only
// argument. It opens the account's OWN pinned identity through the chosen exit
// using the same launch path as a sign-in (but headless, in a separate
// `check-profile/`), then polls the client-rendered page until who.1ms.dog
// prints a verdict. The raw page text is sent back as `{ type: "identity" }`;
// the parent parses it, so no verdict is invented inside the host.
//
// It holds the window until the parent closes it or the IPC channel drops, and
// closes the browser first in every one of those cases.

import { readFile } from "node:fs/promises";
import { openSignInBrowser } from "./browser-launcher.mjs";
import { checkTimeoutMs, waitForIdentityVerdict } from "./identity-check.mjs";

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
      message: "The identity-check browser host was given no launch payload.",
    });
    process.exitCode = 1;
    return;
  }

  let handle;
  let timeoutMs;
  try {
    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    timeoutMs =
      Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
        ? Math.floor(payload.timeoutMs)
        : checkTimeoutMs(process.env);
    handle = await openSignInBrowser(payload);
  } catch (error) {
    send({
      type: "error",
      code: typeof error?.code === "string" ? error.code : "launch_failed",
      message: String(error?.message ?? error),
    });
    process.exitCode = 1;
    return;
  }

  send({ type: "ready", pid: process.pid });

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
  // The parent exiting drops the channel; close the browser instead of
  // leaving an orphan window behind.
  process.on("disconnect", shutdown);
  handle.context?.on?.("close", () => process.exit(0));

  const page = handle.page;
  if (!page) {
    send({ type: "error", code: "page_timeout", message: "The identity-check browser opened no page." });
    return;
  }

  let text;
  try {
    text = await waitForIdentityVerdict(page, { timeoutMs });
  } catch (error) {
    send({
      type: "error",
      code: "page_timeout",
      message: String(error?.message ?? error),
    });
    return;
  }
  if (closing) return;
  if (!text) {
    send({
      type: "error",
      code: "page_timeout",
      message: "The identity page did not return a verdict in time.",
    });
    return;
  }
  send({ type: "identity", text });
  // The parent closes the window (or the channel drops and shutdown runs).
}

main();
