import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatExitRegion, proxyTestEndpoint, testProxy } from "../lib/proxy-test.mjs";

const key = readFileSync(join(import.meta.dir, "fixtures", "localhost-key.pem"));
const cert = readFileSync(join(import.meta.dir, "fixtures", "localhost-cert.pem"));
const servers = [];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function track(server) {
  servers.push(server);
  return server;
}

async function closeAll() {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
}

afterAll(closeAll);

function startHttpProxy(handler) {
  const server = track(createServer(handler));
  return listen(server).then((port) => ({ port, server }));
}

test("HTTP proxy sends the request to the proxy with proxy authentication", async () => {
  const seen = [];
  const proxy = await startHttpProxy((req, res) => {
    seen.push({ url: req.url, auth: req.headers["proxy-authorization"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "203.0.113.20", region: "Proxyland" }));
  });
  const result = await testProxy(
    { type: "http", host: "127.0.0.1", port: proxy.port, username: "alice", password: "s3cret" },
    // Port 1 is not listening, so a direct fallback would fail: success proves
    // the request really went through the fake proxy.
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(true);
  expect(result.exitIp).toBe("203.0.113.20");
  expect(result.region).toBe("Proxyland");
  expect(result.latency).toBeGreaterThanOrEqual(0);
  expect(seen).toEqual([
    {
      url: "http://127.0.0.1:1/ip",
      auth: `Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("s3cret");
});

test("HTTP proxy failure is safe and never leaks credentials", async () => {
  const proxy = await startHttpProxy((_req, res) => {
    res.writeHead(407);
    res.end();
  });
  const result = await testProxy(
    { type: "http", host: "127.0.0.1", port: proxy.port, username: "alice", password: "s3cret" },
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe("proxy_auth");
  expect(result.error).toBe("Proxy authentication failed.");
  expect(JSON.stringify(result)).not.toContain("s3cret");
  expect(JSON.stringify(result)).not.toContain("alice");
});

test("a refused proxy connection reports a refused, not a direct, result", async () => {
  const probe = createServer();
  const port = await listen(track(probe));
  await new Promise((resolve) => probe.close(resolve));
  const result = await testProxy(
    { type: "http", host: "127.0.0.1", port },
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe("refused");
});

test("a proxy that never answers times out", async () => {
  const proxy = await startHttpProxy(() => {});
  const started = Date.now();
  const result = await testProxy(
    { type: "http", host: "127.0.0.1", port: proxy.port },
    { endpoint: "http://127.0.0.1:1/ip", timeoutMs: 250 },
  );
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe("timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  proxy.server.closeAllConnections?.();
});

function startSocks5({ username = "", password = "", reply = 0x00, body = { ip: "198.51.100.20", region: "Socksland" } }) {
  const seen = {};
  const server = track(
    net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let stage = "greet";
      const flush = () => {
        if (stage === "greet" && buffer.length >= 2) {
          const count = buffer[1];
          if (buffer.length < 2 + count) return;
          const methods = [...buffer.subarray(2, 2 + count)];
          seen.methods = methods;
          buffer = buffer.subarray(2 + count);
          if (methods.includes(0x02)) {
            socket.write(Buffer.from([0x05, 0x02]));
            stage = "auth";
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = "connect";
          }
          flush();
        }
        if (stage === "auth" && buffer.length >= 2) {
          const userLength = buffer[1];
          if (buffer.length < 3 + userLength) return;
          const passwordLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passwordLength) return;
          seen.username = buffer.subarray(2, 2 + userLength).toString();
          seen.password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
          buffer = buffer.subarray(3 + userLength + passwordLength);
          socket.write(Buffer.from([0x01, 0x00]));
          stage = "connect";
          flush();
        }
        if (stage === "connect" && buffer.length >= 4) {
          const atyp = buffer[3];
          let total = 0;
          if (atyp === 0x01) total = 10;
          else if (atyp === 0x03) total = 5 + buffer[4] + 2;
          else if (atyp === 0x04) total = 4 + 16 + 2;
          if (!total || buffer.length < total) return;
          seen.atyp = atyp;
          buffer = buffer.subarray(total);
          if (reply !== 0x00) {
            socket.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          stage = "http";
          flush();
        }
        if (stage === "http") {
          const index = buffer.indexOf("\r\n\r\n");
          if (index < 0) return;
          seen.request = buffer.subarray(0, index).toString();
          buffer = buffer.subarray(index + 4);
          stage = "done";
          const payload = JSON.stringify(body);
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
          );
        }
      };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        flush();
      });
    }),
  );
  return listen(server).then((port) => ({ port, seen }));
}

test("SOCKS5 with authentication reaches the target and returns its region", async () => {
  const proxy = await startSocks5({ username: "alice", password: "s3cret" });
  const result = await testProxy(
    { type: "socks5", host: "127.0.0.1", port: proxy.port, username: "alice", password: "s3cret" },
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(true);
  expect(result.exitIp).toBe("198.51.100.20");
  expect(result.region).toBe("Socksland");
  expect(proxy.seen.methods).toEqual([0x00, 0x02]);
  expect(proxy.seen.username).toBe("alice");
  expect(proxy.seen.password).toBe("s3cret");
  expect(proxy.seen.atyp).toBe(0x01);
  expect(proxy.seen.request).toContain("GET /ip HTTP/1.1");
  expect(proxy.seen.request).toContain("Host: 127.0.0.1:1");
});

test("SOCKS5 without credentials works too", async () => {
  const proxy = await startSocks5({});
  const result = await testProxy(
    { type: "socks5", host: "127.0.0.1", port: proxy.port, username: "", password: "" },
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(true);
  expect(proxy.seen.methods).toEqual([0x00]);
});

test("SOCKS5 refusal is reported as a safe error", async () => {
  const proxy = await startSocks5({ reply: 0x05 });
  const result = await testProxy(
    { type: "socks5", host: "127.0.0.1", port: proxy.port },
    { endpoint: "http://127.0.0.1:1/ip" },
  );
  expect(result.ok).toBe(false);
  expect(result.errorCode).toBe("socks_refused");
  expect(result.error).toBe("The SOCKS5 proxy refused the connection.");
});

test("HTTPS through an HTTP CONNECT tunnel works and validates TLS by default", async () => {
  const origin = track(
    https.createServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ip: "192.0.2.44", region: "TLSland" }));
    }),
  );
  const originPort = await listen(origin);
  const proxy = track(
    net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const index = buffer.indexOf("\r\n\r\n");
        if (index < 0) return;
        const head = buffer.subarray(0, index).toString();
        buffer = buffer.subarray(index + 4);
        socket.off("data", onData);
        const match = /^CONNECT ([^ ]+)/.exec(head);
        const [host, targetPort] = match[1].split(":");
        const upstream = net.connect(Number(targetPort), host, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
      };
      socket.on("data", onData);
    }),
  );
  const proxyPort = await listen(proxy);
  const endpoint = `https://127.0.0.1:${originPort}/ip`;

  const trusted = await testProxy(
    { type: "http", host: "127.0.0.1", port: proxyPort },
    { endpoint, tlsRejectUnauthorized: false },
  );
  expect(trusted.ok).toBe(true);
  expect(trusted.exitIp).toBe("192.0.2.44");
  expect(trusted.region).toBe("TLSland");

  const untrusted = await testProxy(
    { type: "http", host: "127.0.0.1", port: proxyPort },
    { endpoint },
  );
  expect(untrusted.ok).toBe(false);
  expect(untrusted.errorCode).toBe("tls");
});

test("the test endpoint can be overridden by environment/options", () => {
  const url = proxyTestEndpoint({ MAGPIE_CLEAN_LOGIN_IP_ENDPOINT: "http://127.0.0.1:9/ip" });
  expect(url.href).toBe("http://127.0.0.1:9/ip");
  const fallback = proxyTestEndpoint({});
  expect(fallback.protocol).toBe("https:");
});

test("formatExitRegion formats location as 国家/地区", () => {
  expect(formatExitRegion({ country: "HK", region: "Islands", city: "Tung Chung" })).toBe("中国/香港");
  expect(formatExitRegion({ country: "HK", region: "Sha Tin", city: "Sha Tin" })).toBe("中国/香港");
  expect(formatExitRegion({ country: "TW", region: "Taiwan", city: "Taipei" })).toBe("中国/台湾");
  expect(formatExitRegion({ country: "TW", region: "Taipei", city: "Banqiao" })).toBe("中国/台湾");
  expect(formatExitRegion({ country: "SG", region: "Singapore", city: "Singapore" })).toBe("新加坡");
  expect(formatExitRegion({ country: "US", region: "California", city: "Los Angeles" })).toBe("美国/加利福尼亚");
  expect(formatExitRegion({ country: "JP", region: "Tokyo", city: "Tokyo" })).toBe("日本/东京");
  expect(formatExitRegion({ country: "CN", region: "Guangdong", city: "Shenzhen" })).toBe("中国/广东");
  expect(formatExitRegion({ region: "Testland" })).toBe("Testland");
  expect(formatExitRegion({})).toBe("");
});
