// Regression cover for the reload handover.
//
// magpie loads a plugin in a fresh host process after an update, and the host it
// replaces keeps the plugin's loopback listener until it exits. A bind attempted
// inside that window fails with EADDRINUSE; that used to end the load --
// `plugin github:Gruu6y/clean-login didn't load: Error: Failed to start server.
// Is port 3492 in use?` -- and left the page without a service until magpie
// restarted. The page reads its port from `window.magpie.options` and has no
// fallback, so waiting for the port is the only fix available to the plugin.
//
// Both tests below hold a real loopback listener across the first bind
// attempts, the way the previous host process does.
import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Injected so the suite never imports a provider plugin and never spawns a
// child process (the installed-plugin scan is third-party code).
const pluginScanner = {
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

function startOptions(dataDir) {
  return {
    dataDir,
    // Keep magpie's config directory inside the temp root: the startup orphan
    // sweep must never read or write the real ~/.config/magpie.
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: join(dataDir, "magpie-config"),
      MAGPIE_CLEAN_LOGIN_DATA: dataDir,
    },
    pluginScanner,
  };
}

// A real listener on a real loopback port, so the port is genuinely taken.
function holdPort() {
  return new Promise((resolve) => {
    const server = createServer((_, res) => res.end("held"));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function releasePort(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function statusOf(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("startServer binds once the previous instance releases the port", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clean-login-port-retry-"));
  const { startServer } = await import("../lib/server.mjs");
  const { server: previous, port } = await holdPort();
  // The replacement starts binding immediately and keeps retrying while the
  // previous host is still up; it lets go in the middle of that window.
  const handover = setTimeout(() => previous.close(), 300);
  const startedAt = Date.now();
  let service;
  try {
    service = await startServer({ port, portRetryMs: 5000, ...startOptions(join(tmp, "data")) });
    // Waiting is the point: without the retry this call rejects on the first
    // attempt instead of coming up on the page's fixed port.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(service.port).toBe(port);
    expect(await statusOf(port, "/")).toBe(200);
  } finally {
    clearTimeout(handover);
    await service?.close();
    await releasePort(previous);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("startServer still fails when the port stays taken for the whole window", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "clean-login-port-retry-"));
  const { startServer } = await import("../lib/server.mjs");
  const { server: held, port } = await holdPort();
  const startedAt = Date.now();
  let error = null;
  try {
    await startServer({ port, portRetryMs: 600, ...startOptions(join(tmp, "data")) });
  } catch (caught) {
    error = caught;
  }
  const elapsed = Date.now() - startedAt;
  try {
    // The failure stays recognisable as the port being taken, and the retry
    // never outlives its window: magpie gives a plugin 20s to load, and a port
    // that really is owned elsewhere has to fail visibly instead of hanging.
    expect(error).not.toBeNull();
    expect(String(error?.message ?? "")).toMatch(/in use|EADDRINUSE/i);
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(5000);
  } finally {
    await releasePort(held);
    rmSync(tmp, { recursive: true, force: true });
  }
});
