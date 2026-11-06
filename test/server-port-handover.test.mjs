// Regression cover for the two defects behind the reload failure.
//
// 1. A failed bind used to leak listeners. `server.listen(port, host, cb)`
//    registers `cb` as an implicit `listening` listener that a failed bind
//    never removes, and the `error` listener was only removed on success, so
//    magpie's log filled with
//    `MaxListenersExceededWarning: 11 listening listeners added to [Server]`.
// 2. The retry window was bounded by magpie's plugin load budget. These tests
//    cover the retry itself; `server-load-decoupling.test.mjs` covers why the
//    load no longer waits for it.
//
// Real loopback listeners, no mocked sockets.
import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { listenWithPortRetry } from "../lib/server.mjs";

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

test("a failed bind removes both of its listeners", async () => {
  const { server: held, port } = await holdPort();
  const server = createServer(() => {});
  // Bun's own http server carries one internal `listening` listener from the
  // moment it is created, so the baseline is measured rather than assumed.
  const baseline = server.listenerCount("listening");
  try {
    await expect(listenWithPortRetry(server, port, { windowMs: 1200 })).rejects.toThrow();
    // Several bind attempts happened inside that window. Before the fix each
    // one added a listener (measured: 1 -> 2 -> 3 -> 4 -> 5 over four failed
    // attempts with the old `listen(port, host, cb)` pattern); now the count
    // must not grow at all.
    expect(server.listenerCount("listening")).toBe(baseline);
    expect(server.listenerCount("error")).toBe(0);
    expect(server.listening).toBe(false);
  } finally {
    await releasePort(held);
  }
});

test("an unbounded retry outlives the old load budget and binds on handover", async () => {
  const { server: held, port } = await holdPort();
  const server = createServer((_, res) => res.end("ok"));
  // Longer than the first few backoff steps, so several attempts fail first.
  const handover = setTimeout(() => held.close(), 2500);
  const startedAt = Date.now();
  try {
    await listenWithPortRetry(server, port, { windowMs: Number.POSITIVE_INFINITY });
    // A finite window would have rejected instead of waiting for the handover.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2400);
    expect(server.listening).toBe(true);
    expect(server.listenerCount("listening")).toBeLessThanOrEqual(1);
    expect(await statusOf(port, "/")).toBe(200);
  } finally {
    clearTimeout(handover);
    await releasePort(held);
    await releasePort(server);
  }
});

test("the retry throttles its own log instead of writing one line per attempt", async () => {
  const { server: held, port } = await holdPort();
  const server = createServer(() => {});
  const lines = [];
  try {
    await expect(
      listenWithPortRetry(server, port, { windowMs: 4000, log: (m) => lines.push(m) }),
    ).rejects.toThrow();
    // Roughly seven attempts fit in 4s of exponential backoff. Logging all of
    // them is what an unbounded retry must not do forever.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toMatch(/is in use/);
  } finally {
    await releasePort(held);
  }
});

test("a finite window still fails visibly when the port stays taken", async () => {
  const { server: held, port } = await holdPort();
  const server = createServer(() => {});
  const startedAt = Date.now();
  try {
    await expect(listenWithPortRetry(server, port, { windowMs: 600 })).rejects.toThrow(/in use|EADDRINUSE/i);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(5000);
  } finally {
    await releasePort(held);
  }
});
