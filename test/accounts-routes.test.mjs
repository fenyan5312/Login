// The account identity routes. A temporary data directory holds the account
// layout and a temporary magpie config directory holds `plugin-auth.json`, so
// the real `readAccountMeta`/`removeAccountDir` run without touching the real
// ~/.config/magpie.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";
import { accountDir, readAccountMeta, writeAccountMeta } from "../lib/account-identity.mjs";

const tmp = mkdtempSync(join(tmpdir(), "clean-login-accounts-routes-"));
const dataDir = join(tmp, "data");
const configDir = join(tmp, "magpie-config");
let service;
let token;

const signedInDir = accountDir({ MAGPIE_CLEAN_LOGIN_DATA: dataDir }, "workbuddy", "workbuddy");
const retiredDir = accountDir({ MAGPIE_CLEAN_LOGIN_DATA: dataDir }, "workbuddy", "workbuddy#ab12");

beforeAll(async () => {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "plugin-auth.json"),
    JSON.stringify({ workbuddy: { type: "oauth", access: "SECRET", accountId: "signed-in" } }),
  );
  await writeAccountMeta(signedInDir, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "signed-in",
    uid: "u-1",
    signedInAt: "2026-11-03T10:00:00.000Z",
  });
  await writeAccountMeta(retiredDir, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy#ab12",
    accountId: "retired",
    uid: "u-2",
    signedInAt: "2026-11-02T09:00:00.000Z",
  });
  // A directory with no ledger must never show up in the account list.
  await mkdir(accountDir({ MAGPIE_CLEAN_LOGIN_DATA: dataDir }, "workbuddy", "workbuddy#no-ledger"), {
    recursive: true,
  });

  service = await startServer({
    port: 0,
    env: {
      ...process.env,
      MAGPIE_CONFIG_DIR: configDir,
      MAGPIE_CLEAN_LOGIN_DATA: dataDir,
    },
    dataDir,
    pluginScanner: {
      get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
      warm: () => {},
    },
  });
  await service.prune();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(html)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function api(method, path, { withToken = true } = {}) {
  const headers = withToken ? { [TOKEN_HEADER]: token } : {};
  return fetch(`http://127.0.0.1:${service.port}${path}`, { method, headers });
}

test("GET /api/accounts lists the ledger fields and the signed-in flag", async () => {
  const res = await api("GET", "/api/accounts");
  expect(res.status).toBe(200);
  const body = await res.json();
  // No identity.json was written for these accounts, so the fingerprint
  // summary is honestly empty rather than invented.
  const extras = {
    note: "",
    lastLogin: null,
    loginHistory: [],
    lastCheck: null,
    checks: [],
    fingerprint: { id: null, pinnedAt: null },
  };
  expect(body.accounts).toEqual([
    {
      provider: "workbuddy",
      key: "workbuddy",
      accountId: "signed-in",
      uid: "u-1",
      signedInAt: "2026-11-03T10:00:00.000Z",
      signedIn: true,
      ...extras,
    },
    {
      provider: "workbuddy",
      key: "workbuddy#ab12",
      accountId: "retired",
      uid: "u-2",
      signedInAt: "2026-11-02T09:00:00.000Z",
      signedIn: false,
      ...extras,
    },
  ]);
  // No path and no credential in the response.
  const text = JSON.stringify(body);
  expect(text).not.toContain(tmp);
  expect(text).not.toContain("SECRET");
});

test("GET /api/accounts whitelists optional ledger fields", async () => {
  await writeAccountMeta(signedInDir, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "signed-in",
    uid: "u-1",
    signedInAt: "2026-11-03T10:00:00.000Z",
    note: "a note",
    lastLogin: { at: "2026-11-03T10:00:00.000Z", proxyId: "p-1", proxyName: "HK", region: "香港", type: "socks5", password: "secret-pass", host: "10.0.0.1", port: 1080 },
    loginHistory: [{ at: "2026-11-03T09:00:00.000Z", proxyId: null, proxyName: "", region: "", type: null }],
    checks: [{ at: "2026-11-03T08:00:00.000Z", grade: "B", proxyId: "p-1", proxyName: "HK", region: "香港", exposure: 2, summary: ["one"], password: "secret-pass", dir: "/secret/path" }],
  });
  const res = await api("GET", "/api/accounts");
  const account = (await res.json()).accounts.find((a) => a.key === "workbuddy");
  expect(account.note).toBe("a note");
  expect(account.lastLogin).toEqual({
    at: "2026-11-03T10:00:00.000Z",
    proxyId: "p-1",
    proxyName: "HK",
    region: "香港",
    type: "socks5",
  });
  expect(account.loginHistory).toHaveLength(1);
  expect(account.lastCheck).toEqual({
    at: "2026-11-03T08:00:00.000Z",
    grade: "B",
    proxyId: "p-1",
    proxyName: "HK",
    region: "香港",
    exposure: 2,
    summary: ["one"],
  });
  expect(account.checks).toHaveLength(1);
  expect(JSON.stringify(account)).not.toContain("secret-pass");
  expect(JSON.stringify(account)).not.toContain("/secret/path");
});

test("PATCH /api/accounts saves a note and keeps the rest of the ledger", async () => {
  await writeAccountMeta(signedInDir, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "signed-in",
    uid: "u-1",
    signedInAt: "2026-11-03T10:00:00.000Z",
    checks: [{ at: "2026-11-03T08:00:00.000Z", grade: "A", proxyId: null, proxyName: "", region: "", exposure: 0, summary: [] }],
    loginHistory: [],
  });
  const res = await fetch(`http://127.0.0.1:${service.port}/api/accounts/workbuddy/workbuddy`, {
    method: "PATCH",
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    body: JSON.stringify({ note: "  saved note  " }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.account.note).toBe("saved note");
  expect(body.account.provider).toBe("workbuddy");
  expect(body.account.key).toBe("workbuddy");
  expect(body.account.lastCheck.grade).toBe("A");
  expect(body.account.fingerprint.id).toBeNull();
  const meta = await readAccountMeta(signedInDir);
  expect(meta.note).toBe("saved note");
  expect(meta.checks).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain(tmp);
  expect(JSON.stringify(body)).not.toContain("SECRET");
});

test("PATCH /api/accounts rejects an invalid note and an unknown account", async () => {
  const patch = (path, body) =>
    fetch(`http://127.0.0.1:${service.port}${path}`, {
      method: "PATCH",
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const overlong = await patch("/api/accounts/workbuddy/workbuddy", { note: "n".repeat(201) });
  expect(overlong.status).toBe(400);
  expect((await overlong.json()).error).toBe("invalid_note");
  const nonString = await patch("/api/accounts/workbuddy/workbuddy", { note: 7 });
  expect(nonString.status).toBe(400);
  expect((await nonString.json()).error).toBe("invalid_note");
  const unknown = await patch("/api/accounts/workbuddy/workbuddy%23unknown", { note: "x" });
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).error).toBe("not_found");
});

test("GET /api/accounts requires the page token", async () => {
  const res = await api("GET", "/api/accounts", { withToken: false });
  expect(res.status).toBe(403);
});

test("GET /api/accounts rejects another method", async () => {
  const res = await api("POST", "/api/accounts");
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("GET");
});

test("DELETE refuses a signed-in account with 409 and keeps its directory", async () => {
  const res = await api("DELETE", "/api/accounts/workbuddy/workbuddy");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "signed_in",
    message: "This account is still signed in; sign out first.",
  });
  expect(existsSync(signedInDir)).toBe(true);
  expect(await readAccountMeta(signedInDir)).toBeTruthy();
});

test("DELETE removes a signed-out identity and its ledger", async () => {
  const res = await api("DELETE", "/api/accounts/workbuddy/workbuddy%23ab12");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(existsSync(retiredDir)).toBe(false);
});

test("DELETE on a directory without a ledger is a 404", async () => {
  const res = await api("DELETE", "/api/accounts/workbuddy/workbuddy%23no-ledger");
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not_found");
});

test("DELETE on an unknown account is a 404", async () => {
  const res = await api("DELETE", "/api/accounts/workbuddy/workbuddy%23unknown");
  expect(res.status).toBe(404);
});

test("DELETE rejects another method", async () => {
  const res = await api("GET", "/api/accounts/workbuddy/workbuddy");
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("DELETE");
});

// With no readable key set the service cannot tell a signed-in account from a
// signed-out one, so it reports the flag it can prove (false) and refuses the
// delete rather than risk a live credential's pin.
test("an unreadable auth file reports signedIn=false and refuses the delete", async () => {
  await writeFile(join(configDir, "plugin-auth.json"), "{ not json");
  const list = await api("GET", "/api/accounts");
  expect(list.status).toBe(200);
  const body = await list.json();
  expect(body.accounts.length).toBeGreaterThan(0);
  expect(body.accounts.every((account) => account.signedIn === false)).toBe(true);

  const res = await api("DELETE", "/api/accounts/workbuddy/workbuddy");
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe("auth_unreadable");
  expect(existsSync(signedInDir)).toBe(true);
});
