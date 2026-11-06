// The reload failure this covers, verbatim from magpie's app.log:
//
//   [clean-login] port 3492 is in use; retrying in 1000ms (attempt 13)
//   plugin github:Gruu6y/clean-login didn't load:
//     Error: Failed to start server. Is port 3492 in use?
//
// magpie loads the replacement plugin in a new host process while the old one
// still owns 3492, and gives `server()` a bounded load budget. Awaiting the
// bind inside `server()` spent that budget, magpie marked the plugin failed,
// and the page then showed `network` forever -- even once the port was free.
//
// The fix is that `server()` no longer waits for the port. These tests drive
// the real plugin entry against a real occupied loopback port.
import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before the entry is imported: the service resolves its data and
// magpie config directories from the environment, and a test must never touch
// the real ~/.config/magpie.
const tmp = mkdtempSync(join(tmpdir(), "clean-login-load-"));
process.env.MAGPIE_CONFIG_DIR = join(tmp, "magpie-config");
process.env.MAGPIE_CLEAN_LOGIN_DATA = join(tmp, "data");

const { default: plugin, __testing } = await import("../index.mjs");

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

test("server() resolves while the port is taken, and the service takes it over later", { timeout: 40000 }, async () => {
  const { server: held, port } = await holdPort();
  let service;
  try {
    const startedAt = Date.now();
    const result = await plugin.server({}, { port });
    const elapsed = Date.now() - startedAt;

    // The whole point: the load answers immediately instead of consuming
    // magpie's load budget waiting for a port it cannot have yet.
    expect(result).toEqual({});
    expect(elapsed).toBeLessThan(5000);
    expect(__testing.service).toBeNull();
    expect(__testing.starting).toBeDefined();

    // A second call must not start a second bind on the same port.
    const pending = __testing.starting;
    expect(await plugin.server({}, { port })).toEqual({});
    expect(__testing.starting).toBe(pending);

    // Keep the port taken past magpie's 20s load budget. Before the fix this
    // is exactly where the plugin was declared "didn't load".
    await new Promise((resolve) => setTimeout(resolve, 21000));
    expect(__testing.service).toBeNull();

    // The old host finally exits. The background retry takes the port over
    // with no restart, no reinstall and no second call from magpie.
    await releasePort(held);
    service = await __testing.starting;
    expect(service).not.toBeNull();
    expect(service.port).toBe(port);
    expect(__testing.service).toBe(service);
    expect(await statusOf(port, "/")).toBe(200);
  } finally {
    await releasePort(held).catch(() => {});
    await service?.close();
    __testing.reset();
    rmSync(tmp, { recursive: true, force: true });
  }
});
