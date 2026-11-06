// The generic /api/import path: any provider can receive a pasted key or
// token, and only the typed fields reach magpie's account store. A fake client
// records what would have been written; nothing leaves the temp directory.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";

const tmp = mkdtempSync(join(tmpdir(), "login-import-routes-"));
const dataDir = join(tmp, "data");
const configDir = join(tmp, "magpie-config");
const KEY = "sk-generic-abcdefghijklmnop";
const ACCESS = "ya29.genericaccessabcdefghijklmn";
const REFRESH = "1//genericrefreshabcdefghijklmn";
const writes = [];
let service;
let token;

beforeAll(async () => {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "plugin-auth.json"), JSON.stringify({}));
  service = await startServer({
    port: 0,
    env: { ...process.env, MAGPIE_CONFIG_DIR: configDir, MAGPIE_CLEAN_LOGIN_DATA: dataDir },
    dataDir,
    pluginScanner: {
      get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
      warm() {},
    },
    client: {
      auth: {
        async set(payload) {
          writes.push(payload);
          return { ok: true };
        },
      },
    },
    signIn: { async startSignIn() { return {}; }, status: () => null, async cancel() { return {}; } },
  });
  await service.prune?.();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(html)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function importCredential(body) {
  return fetch(`http://127.0.0.1:${service.port}/api/import`, {
    method: "POST",
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an API key for any provider becomes an api entry", async () => {
  writes.length = 0;
  const response = await importCredential({ provider: "codex", text: KEY });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, kind: "key", created: true });
  expect(writes).toHaveLength(1);
  expect(writes[0].path.id).toBe("codex");
  expect(writes[0].body).toEqual({
    type: "api",
    key: KEY,
    accountId: `API key …${KEY.slice(-4)}`,
    uid: `key_${KEY.slice(-4)}`,
  });
  // The secret is written to magpie; it never comes back in the answer.
  expect(JSON.stringify(body)).not.toContain(KEY);
});

test("the same key is refused as a duplicate once it is in the auth file", async () => {
  await writeFile(
    join(configDir, "plugin-auth.json"),
    JSON.stringify({ codex: { type: "api", key: KEY } }),
  );
  writes.length = 0;
  const response = await importCredential({ provider: "codex", text: KEY });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("duplicate_key");
  expect(writes).toHaveLength(0);
});

test("an oauth credential keeps only the whitelisted fields", async () => {
  writes.length = 0;
  const response = await importCredential({
    provider: "cursor",
    text: JSON.stringify({
      access_token: ACCESS,
      refresh_token: REFRESH,
      email: "who@example.com",
      admin: true,
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.kind).toBe("oauth");
  expect(body.accountId).toBe("who@example.com");
  expect(writes[0].path.id).toBe("cursor");
  expect(writes[0].body.access).toBe(ACCESS);
  expect(writes[0].body.refresh).toBe(REFRESH);
  expect(writes[0].body.type).toBe("oauth");
  expect(writes[0].body).not.toHaveProperty("admin");
  expect(JSON.stringify(body)).not.toContain(ACCESS);
});

test("a provider id that is not a slug is refused before any write", async () => {
  writes.length = 0;
  const response = await importCredential({ provider: "../escape", text: KEY });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("invalid_provider");
  expect(writes).toHaveLength(0);
});

test("the route still requires the page token", async () => {
  const response = await fetch(`http://127.0.0.1:${service.port}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex", text: KEY }),
  });
  expect(response.status).toBe(403);
});
