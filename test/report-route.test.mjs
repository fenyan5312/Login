// The reporting routes over real HTTP: the body is assembled by the service
// (never echoed from the page), the route is closed without the page token,
// and the one route that launches anything refuses every URL but GitHub's
// new-issue form for this repo.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scanner = {
  get: () => ({
    available: true,
    providers: [],
    scanned: true,
    stale: false,
    scanning: false,
    error: null,
  }),
  warm: () => {},
};

test("the report routes are token-gated, allowlisted and credential-free", async () => {
  const { startServer } = await import("../lib/server.mjs");
  const root = mkdtempSync(join(tmpdir(), "clean-login-report-"));
  let service;
  try {
    service = await startServer({
      port: 0,
      env: {
        ...process.env,
        MAGPIE_CONFIG_DIR: root,
        MAGPIE_CLEAN_LOGIN_DATA: join(root, "data"),
      },
      pluginScanner: scanner,
    });
    const base = `http://127.0.0.1:${service.port}`;
    // The page token is embedded in the served document; read it the way the
    // page does instead of reaching into the service.
    const html = await (await fetch(`${base}/`)).text();
    const token = /name="clean-login-token"\s+content="([0-9a-f]+)"/.exec(html)?.[1] || "";
    expect(token).toHaveLength(64);

    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "x-clean-login-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Closed without the token, exactly like every other API route.
    const denied = await fetch(`${base}/api/report`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("unauthorized");

    const built = await (
      await post("/api/report", {
        provider: {
          id: "antigravity",
          name: "Google Antigravity",
          capabilityState: "pending",
          // Not part of the allowlist: must never reach the body.
          cookie: "SESSION=should-not-appear",
          token: "ghp_should_not_appear",
        },
        note: "点添加账号之后没有反应",
        language: "zh-Hans",
      })
    ).json();

    expect(built.report.body).toContain("antigravity");
    expect(built.report.body).toContain("点添加账号之后没有反应");
    expect(built.report.body).not.toContain("should-not-appear");
    expect(built.report.body).not.toContain("ghp_should_not_appear");
    expect(built.report.url.startsWith("https://github.com/fenyan5312/Login/issues/new?")).toBe(true);
    expect(built.report.url.length).toBeLessThanOrEqual(12000);

    // The launch route refuses anything that is not our issue form, and it
    // never spawns a process for those (the unit tests assert the spawn side).
    for (const bad of [
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "https://github.com/Gruu6y/clean-login/issues",
      "https://example.com/issues/new",
    ]) {
      const refused = await post("/api/report/open", { url: bad });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe("url_not_allowed");
    }
  } finally {
    await service?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
