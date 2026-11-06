// The one place this service hands a URL to the operating system.
//
// A magpie page is embedded in <iframe sandbox="allow-scripts">, so the page
// cannot open a link itself: no allow-popups, no allow-forms, no top
// navigation. The service can, and this module is the whole of that power.
//
// It is deliberately narrow:
//   * the URL is checked against an allowlist before anything is spawned, so a
//     page cannot turn this into an arbitrary-URL or arbitrary-program launch
//     ("file:", "javascript:", another host, or a path with credentials);
//   * the URL is passed as a single argv entry, never through a shell, so `&`,
//     spaces and quotes in a query string cannot become another command;
//   * the child is detached and unreferenced: the browser outlives the request
//     and the service never waits on a GUI program.

import { spawn } from "node:child_process";
import { isAllowedIssueUrl } from "./issue-report.mjs";

export class OpenExternalError extends Error {
  constructor(message, code = "open-external", status = 502) {
    super(message);
    this.name = "OpenExternalError";
    this.code = code;
    this.status = status;
  }
}

// explorer.exe on Windows rather than `cmd /c start`: it is launched directly
// by CreateProcess, so no shell parses the URL, and its command line limit
// (32767) is far above the one we enforce on the issue URL. `open` and
// `xdg-open` take the URL as a plain argument, which is the same property.
export function openCommand(platform, url) {
  if (platform === "win32") return { command: "explorer.exe", args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export async function openExternal(url, options = {}) {
  const {
    platform = process.platform,
    spawnImpl = spawn,
    allow = isAllowedIssueUrl,
    detached = true,
  } = options;

  if (!allow(url)) {
    throw new OpenExternalError("拒绝打开这个地址：只允许 GitHub 的新建 issue 页面。", "url-not-allowed", 400);
  }

  const { command, args } = openCommand(platform, url);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnImpl(command, args, {
        detached,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(new OpenExternalError(`无法启动系统浏览器：${error?.message || error}`, "spawn-failed"));
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        try {
          child.unref?.();
        } catch {
          /* an already-exited child cannot be unreferenced; harmless */
        }
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof OpenExternalError) throw error;
    throw new OpenExternalError(`无法启动系统浏览器：${error?.message || error}`, "spawn-failed");
  }

  return { ok: true, command, url };
}

// Test helper: the command shape without spawning anything.
export function describeOpen(platform, url) {
  const { command, args } = openCommand(platform, url);
  return `${command} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}
