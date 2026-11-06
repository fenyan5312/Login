// The identity-check routes. A temporary data directory holds the account
// layout, a temporary magpie config directory holds plugin-auth.json, and a
// stub launcher replaces the forked browser host. Nothing here opens a real
// browser, reaches the network or reads ~/.config/magpie.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";
import { accountDir, readAccountMeta, writeAccountMeta } from "../lib/account-identity.mjs";
import { idleCheckJob } from "../lib/identity-check.mjs";

const tmp = mkdtempSync(join(tmpdir(), "clean-login-check-routes-"));
const dataDir = join(tmp, "data");
const configDir = join(tmp, "magpie-config");
const env = {
  ...process.env,
  MAGPIE_CONFIG_DIR: configDir,
  MAGPIE_CLEAN_LOGIN_DATA: dataDir,
};
const accountPath = accountDir(env, "workbuddy", "workbuddy");
const VERDICT_TEXT = [
  "网站眼中的你",
  "你多半是中国人",
  "你手上这台是电脑",
  "浏览器指纹 ID",
  "60fcf071·b5edbc6e",
  "2 处可能暴露你",
  "评分 B",
].join("\n");

let service;
let token;
const launches = [];
let pending = null;
let closedCount = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function checkLauncher(args) {
  launches.push(args);
  pending = deferred();
  return {
    pid: 777,
    result: pending.promise,
    close: async () => {
      closedCount += 1;
    },
  };
}

beforeAll(async () => {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "plugin-auth.json"),
    JSON.stringify({ workbuddy: { type: "oauth", access: "SECRET", accountId: "signed-in" } }),
  );
  await mkdir(accountPath, { recursive: true });
  await writeFile(join(accountPath, "identity.json"), JSON.stringify({ tag: "pinned" }));
  await writeAccountMeta(accountPath, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "signed-in",
    uid: "u-1",
    signedInAt: "2026-11-03T10:00:00.000Z",
  });

  service = await startServer({
    port: 0,
    env,
    dataDir,
    environment: {
      status: async () => ({ executablePath: "/fake/browser", ready: true }),
      job: () => null,
      prepare: async () => ({ started: false, job: null }),
      cancel: () => ({ cancelled: false, job: null }),
    },
    pluginScanner: {
      get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
      warm: () => {},
    },
    checkLauncher,
  });
  await service.prune();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(html)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function api(method, path, body) {
  const headers = { [TOKEN_HEADER]: token };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`http://127.0.0.1:${service.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForState(state) {
  for (let i = 0; i < 100; i += 1) {
    const res = await api("GET", "/api/accounts/workbuddy/workbuddy/check");
    const job = (await res.json()).job;
    if (job.state === state) return job;
    await Bun.sleep(5);
  }
  throw new Error(`job never reached ${state}`);
}

test("GET /api/accounts adds whitelisted extras and a fingerprint digest", async () => {
  const res = await api("GET", "/api/accounts");
  expect(res.status).toBe(200);
  const account = (await res.json()).accounts.find((a) => a.key === "workbuddy");
  expect(account).toMatchObject({
    provider: "workbuddy",
    key: "workbuddy",
    signedIn: true,
    note: "",
    lastLogin: null,
    loginHistory: [],
    lastCheck: null,
    checks: [],
  });
  expect(account.fingerprint.id).toMatch(/^[0-9a-f]{4}·[0-9a-f]{8}$/);
  expect(typeof account.fingerprint.pinnedAt).toBe("string");
  const text = JSON.stringify(account);
  expect(text).not.toContain(tmp);
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain(accountPath);
});

test("PATCH saves a trimmed note without dropping other ledger fields", async () => {
  await writeAccountMeta(accountPath, {
    version: 1,
    provider: "workbuddy",
    key: "workbuddy",
    accountId: "signed-in",
    uid: "u-1",
    signedInAt: "2026-11-03T10:00:00.000Z",
    note: "old",
    lastLogin: { at: "2026-11-03T10:00:00.000Z", proxyId: null, proxyName: "", region: "", type: null },
    loginHistory: [{ at: "2026-11-03T10:00:00.000Z", proxyId: null, proxyName: "", region: "", type: null }],
    checks: [{ at: "2026-11-03T09:00:00.000Z", grade: "A", proxyId: null, proxyName: "", region: "", exposure: 0, summary: [] }],
  });
  const res = await api("PATCH", "/api/accounts/workbuddy/workbuddy", { note: "  new note  " });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.account.note).toBe("new note");
  expect(body.account.lastCheck.grade).toBe("A");
  expect(body.account.loginHistory).toHaveLength(1);
  expect(body.account.fingerprint.id).toMatch(/^[0-9a-f]{4}·[0-9a-f]{8}$/);
  const meta = await readAccountMeta(accountPath);
  expect(meta.note).toBe("new note");
  expect(meta.checks).toHaveLength(1);
  expect(meta.lastLogin.at).toBe("2026-11-03T10:00:00.000Z");
  expect(JSON.stringify(body)).not.toContain(tmp);
  expect(JSON.stringify(body)).not.toContain("SECRET");
});

test("PATCH rejects a bad note and an unknown account", async () => {
  const bad = await api("PATCH", "/api/accounts/workbuddy/workbuddy", { note: "n".repeat(201) });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid_note");
  const nonString = await api("PATCH", "/api/accounts/workbuddy/workbuddy", { note: 42 });
  expect(nonString.status).toBe(400);
  expect((await nonString.json()).error).toBe("invalid_note");
  const missing = await api("PATCH", "/api/accounts/workbuddy/workbuddy%23unknown", { note: "x" });
  expect(missing.status).toBe(404);
  expect((await missing.json()).error).toBe("not_found");
});

test("POST /check starts a headless check and GET polls the same job", async () => {
  const before = launches.length;
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", { proxyId: null });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.job.state).toBe("checking");
  expect(body.job.provider).toBe("workbuddy");
  expect(body.job.key).toBe("workbuddy");
  expect(body.job.proxyId).toBeNull();
  expect(launches).toHaveLength(before + 1);
  expect(launches.at(-1).headless).toBe(true);
  expect(launches.at(-1).url).toBe("https://who.1ms.dog/zh-cn/");
  expect(launches.at(-1).profileDir).toBe(join(accountPath, "check-profile"));

  const polled = await api("GET", "/api/accounts/workbuddy/workbuddy/check");
  expect((await polled.json()).job.state).toBe("checking");
  // A different account never inherits another account's job.
  const other = await api("GET", "/api/accounts/workbuddy/workbuddy%23other/check");
  expect((await other.json()).job).toEqual(idleCheckJob());
});

test("a second POST while one runs is a 409 check_busy", async () => {
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", {});
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("check_busy");
});

test("POST /check on an account with no ledger is a 404", async () => {
  // Settle the check left running by the polling test so the controller is
  // free; a cancelled run must not write history either.
  await api("POST", "/api/accounts/workbuddy/workbuddy/check/cancel", {});
  pending.resolve({ text: VERDICT_TEXT });
  await Bun.sleep(5);
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy%23missing/check", {});
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("account_not_found");
});

test("POST /check with an unknown proxy id is a 404", async () => {
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", { proxyId: "no-such-proxy" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not_found");
});

test("the check routes reject other methods", async () => {
  const wrong = await api("DELETE", "/api/accounts/workbuddy/workbuddy/check");
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("allow")).toBe("GET, POST");
  const cancelWrong = await api("GET", "/api/accounts/workbuddy/workbuddy/check/cancel");
  expect(cancelWrong.status).toBe(405);
  expect(cancelWrong.headers.get("allow")).toBe("POST");
});

test("cancel closes the window and writes no history", async () => {
  const before = await readAccountMeta(accountPath);
  const checksBefore = before.checks?.length ?? 0;
  const started = await api("POST", "/api/accounts/workbuddy/workbuddy/check", {});
  expect(started.status).toBe(202);
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check/cancel", {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.job.state).toBe("cancelled");
  expect(body.job.errorCode).toBe("cancelled");
  // Resolve the in-flight launcher result with a good verdict: a cancelled
  // run must STILL not write history.
  pending.resolve({ text: VERDICT_TEXT });
  await Bun.sleep(10);
  const after = await readAccountMeta(accountPath);
  expect(after.checks?.length ?? 0).toBe(checksBefore);
  expect(after.note).toBe(before.note);
});

test("a failed verdict writes no history", async () => {
  const before = await readAccountMeta(accountPath);
  const checksBefore = before.checks?.length ?? 0;
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", {});
  expect(res.status).toBe(202);
  pending.resolve({ text: "the page is still drawing" });
  const job = await waitForState("error");
  expect(job.errorCode).toBe("verdict_missing");
  const after = await readAccountMeta(accountPath);
  expect(after.checks?.length ?? 0).toBe(checksBefore);
  expect(after.lastCheck ?? null).toBe(before.lastCheck ?? null);
});

test("a successful verdict writes one whitelisted check record", async () => {
  const before = await readAccountMeta(accountPath);
  const checksBefore = before.checks?.length ?? 0;
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", {});
  expect(res.status).toBe(202);
  pending.resolve({ text: VERDICT_TEXT });
  const job = await waitForState("done");
  expect(job.grade).toBe("B");
  expect(job.exposure).toBe(2);
  expect(job.summary).toEqual(["你多半是中国人", "你手上这台是电脑"]);

  // The ledger write is awaited before the job is reported done.
  for (let i = 0; i < 100; i += 1) {
    const meta = await readAccountMeta(accountPath);
    if ((meta.checks?.length ?? 0) > checksBefore) break;
    await Bun.sleep(5);
  }
  const after = await readAccountMeta(accountPath);
  expect(after.checks).toHaveLength(checksBefore + 1);
  const record = after.checks[0];
  expect(record.grade).toBe("B");
  expect(record.exposure).toBe(2);
  expect(record.summary).toEqual(["你多半是中国人", "你手上这台是电脑"]);
  expect(record.proxyId).toBeNull();
  expect(record.proxyName).toBe("");
  expect(Object.keys(record).sort()).toEqual(
    ["at", "exposure", "grade", "proxyId", "proxyName", "region", "summary"].sort(),
  );
  // The other ledger fields survive the write.
  expect(after.note).toBe(before.note);
  expect(after.lastLogin).toEqual(before.lastLogin);
  expect(after.loginHistory).toEqual(before.loginHistory);
  // Nothing secret or path-like is stored.
  const text = JSON.stringify(after);
  for (const secret of ["secret-pass", "10.0.0.7", "1080", tmp, accountPath]) {
    expect(text).not.toContain(secret);
  }
});

test("a successful check caps history at 10 and preserves earlier records", async () => {
  const older = Array.from({ length: 10 }, (_, i) => ({
    at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`,
    grade: "C",
    proxyId: "p-old",
    proxyName: "Old exit",
    region: "旧地区",
    exposure: 3,
    summary: [`older-${i}`],
  }));
  const meta = await readAccountMeta(accountPath);
  await writeAccountMeta(accountPath, { ...meta, checks: older });

  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", {});
  expect(res.status).toBe(202);
  pending.resolve({ text: VERDICT_TEXT });
  await waitForState("done");
  for (let i = 0; i < 100; i += 1) {
    const current = await readAccountMeta(accountPath);
    if (current.checks?.[0]?.grade === "B") break;
    await Bun.sleep(5);
  }
  const after = await readAccountMeta(accountPath);
  expect(after.checks).toHaveLength(10);
  expect(after.checks[0].grade).toBe("B");
  expect(after.checks[0].summary).toEqual(["你多半是中国人", "你手上这台是电脑"]);
  // The nine most recent earlier records keep every whitelisted field.
  expect(after.checks[1]).toEqual(older[0]);
  expect(after.checks[9]).toEqual(older[8]);
  expect(after.checks.some((c) => c.summary[0] === "older-9")).toBe(false);
});

test("a stored proxy id resolves to a real exit without exposing credentials", async () => {
  const proxy = await service.store.create({
    name: "Hong Kong 01",
    type: "socks5",
    host: "10.0.0.7",
    port: 1080,
    username: "secret-user",
    password: "secret-pass",
  });
  const before = launches.length;
  const res = await api("POST", "/api/accounts/workbuddy/workbuddy/check", { proxyId: proxy.id });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.job.proxyId).toBe(proxy.id);
  expect(body.job.proxyName).toBe("Hong Kong 01");
  // The launcher needs the credentials to connect; the job must not report them.
  expect(launches.at(-1).proxy.host).toBe("10.0.0.7");
  expect(launches).toHaveLength(before + 1);
  const text = JSON.stringify(body);
  for (const secret of ["secret-user", "secret-pass", "10.0.0.7", "1080"]) {
    expect(text).not.toContain(secret);
  }
  await api("POST", "/api/accounts/workbuddy/workbuddy/check/cancel", {});
  pending.resolve({ text: VERDICT_TEXT });
});

test("an injected fake identityCheck controller is used by the routes", async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), "clean-login-check-fake-"));
  const fakeData = join(fakeTmp, "data");
  const fakeConfig = join(fakeTmp, "config");
  const fakeEnv = {
    ...process.env,
    MAGPIE_CONFIG_DIR: fakeConfig,
    MAGPIE_CLEAN_LOGIN_DATA: fakeData,
  };
  await mkdir(fakeConfig, { recursive: true });
  await writeFile(join(fakeConfig, "plugin-auth.json"), "{}");
  const job = { ...idleCheckJob(), state: "checking", provider: "workbuddy", key: "workbuddy" };
  let starts = 0;
  let cancels = 0;
  let closes = 0;
  const fake = {
    start: async ({ provider, key, proxy }) => {
      starts += 1;
      expect(provider).toBe("workbuddy");
      expect(key).toBe("workbuddy");
      expect(proxy).toBeNull();
      return job;
    },
    status: () => ({ job, browserOpen: true }),
    cancel: async () => {
      cancels += 1;
      return { cancelled: true, job };
    },
    close: async () => {
      closes += 1;
    },
  };
  let fakeService;
  try {
    fakeService = await startServer({
      port: 0,
      env: fakeEnv,
      dataDir: fakeData,
      identityCheck: fake,
      pluginScanner: {
        get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
        warm: () => {},
      },
    });
    const html = await (await fetch(`http://127.0.0.1:${fakeService.port}/`)).text();
    const fakeToken = /name="clean-login-token" content="([0-9a-f]+)"/.exec(html)?.[1];
    const headers = { [TOKEN_HEADER]: fakeToken, "content-type": "application/json" };
    const started = await fetch(`http://127.0.0.1:${fakeService.port}/api/accounts/workbuddy/workbuddy/check`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(started.status).toBe(202);
    expect((await started.json()).job).toEqual(job);
    const cancelled = await fetch(`http://127.0.0.1:${fakeService.port}/api/accounts/workbuddy/workbuddy/check/cancel`, {
      method: "POST",
      headers,
    });
    expect((await cancelled.json()).ok).toBe(true);
    expect(starts).toBe(1);
    expect(cancels).toBe(1);
  } finally {
    await fakeService?.close();
    expect(closes).toBe(1);
    rmSync(fakeTmp, { recursive: true, force: true });
  }
});

test("the check routes require the page token", async () => {
  const headers = { "content-type": "application/json" };
  const res = await fetch(`http://127.0.0.1:${service.port}/api/accounts/workbuddy/workbuddy/check`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(res.status).toBe(403);
});
