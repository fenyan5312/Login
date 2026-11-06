// The identity-check controller, driven entirely through injected pieces: a
// temporary account directory, a stubbed identity reader, a stubbed launcher
// and a stubbed clock/executable resolver. No browser is opened and no network
// request is made.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDir, writeAccountMeta } from "../lib/account-identity.mjs";
import {
  IdentityCheckError,
  checkProfileDir,
  createIdentityCheck,
} from "../lib/identity-check.mjs";

const tempDirs = [];
const CHECKED_AT = "2026-11-04T12:00:00.000Z";
const VERDICT_TEXT = [
  "网站眼中的你",
  "你多半是中国人",
  "你手上这台是电脑",
  "浏览器指纹 ID",
  "60fcf071·b5edbc6e",
  "2 处可能暴露你",
  "评分 B",
].join("\n");

const FULL_PROXY = {
  id: "p-01",
  name: "Hong Kong 01",
  region: "香港",
  type: "socks5",
  host: "10.0.0.7",
  port: 1080,
  username: "secret-user",
  password: "secret-pass",
};

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-identity-check-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The controller attaches handlers later; keep an unhandled rejection from
  // turning a deliberately delayed failure into a test-runner error.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function harness(overrides = {}) {
  const dir = await tempDir();
  const env = { MAGPIE_CLEAN_LOGIN_DATA: dir, ...(overrides.env ?? {}) };
  const accountPath = accountDir(env, "workbuddy", "workbuddy");
  await mkdir(accountPath, { recursive: true });
  if (overrides.withLedger !== false) {
    await writeAccountMeta(accountPath, {
      version: 1,
      provider: "workbuddy",
      key: "workbuddy",
      accountId: "me",
      uid: "u-1",
      signedInAt: CHECKED_AT,
    });
  }
  if (overrides.withIdentity !== false) {
    await writeFile(join(accountPath, "identity.json"), JSON.stringify({ tag: "pinned" }));
  }

  const checks = [];
  const launches = [];
  const closed = { count: 0 };
  const pending = deferred();
  const controller = createIdentityCheck({
    env,
    dataDir: dir,
    resolveExecutable: overrides.resolveExecutable ?? (async () => "/fake/browser"),
    readIdentity: overrides.readIdentity ?? (async (d) => ({ dir: d, tag: "pinned" })),
    onCheck: async (check) => {
      checks.push(check);
    },
    timeoutMs: overrides.timeoutMs ?? 5000,
    now: () => CHECKED_AT,
    launchBrowser:
      overrides.launchBrowser ??
      (async (args) => {
        launches.push(args);
        return {
          pid: 111,
          result: pending.promise,
          close: async () => {
            closed.count += 1;
          },
        };
      }),
  });
  return { dir, env, accountPath, controller, checks, launches, closed, pending };
}

test("a successful verdict calls onCheck exactly once with whitelisted fields", async () => {
  const { controller, checks, launches, accountPath, pending } = await harness();
  const started = await controller.start({ provider: "workbuddy", key: "workbuddy", proxy: FULL_PROXY });
  expect(started.state).toBe("checking");
  expect(launches).toHaveLength(1);
  expect(launches[0].headless).toBe(true);
  expect(launches[0].url).toBe("https://who.1ms.dog/zh-cn/");
  expect(launches[0].profileDir).toBe(checkProfileDir(accountPath));
  expect(launches[0].identity).toEqual({ dir: accountPath, tag: "pinned" });

  pending.resolve({ text: VERDICT_TEXT });
  await controller.whenSettled();
  const job = controller.status().job;
  expect(job.state).toBe("done");
  expect(job.grade).toBe("B");
  expect(job.exposure).toBe(2);
  expect(job.summary).toEqual(["你多半是中国人", "你手上这台是电脑"]);
  expect(job.fingerprintId).toBe("60fcf071·b5edbc6e");
  expect(job.finishedAt).toBe(CHECKED_AT);
  expect(job.error).toBe("");
  expect(job.errorCode).toBe("");

  expect(checks).toHaveLength(1);
  expect(checks[0]).toEqual({
    ok: true,
    provider: "workbuddy",
    key: "workbuddy",
    proxyId: "p-01",
    proxyName: "Hong Kong 01",
    region: "香港",
    type: "socks5",
    grade: "B",
    exposure: 2,
    summary: ["你多半是中国人", "你手上这台是电脑"],
    fingerprintId: "60fcf071·b5edbc6e",
    checkedAt: CHECKED_AT,
  });
  // A credential may reach the launcher (it must connect), but never the job
  // nor the persistence payload.
  const publicText = JSON.stringify(job) + JSON.stringify(checks);
  for (const secret of ["secret-user", "secret-pass", "10.0.0.7", "1080"]) {
    expect(publicText).not.toContain(secret);
  }
});

test("a direct check reports proxyId null", async () => {
  const { controller, checks, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy", proxy: null });
  expect(controller.status().job.proxyId).toBeNull();
  expect(controller.status().job.type).toBeNull();
  pending.resolve({ text: VERDICT_TEXT });
  await controller.whenSettled();
  expect(checks[0].proxyId).toBeNull();
  expect(checks[0].proxyName).toBe("");
});

test("a failed launch writes no history and reports a mapped code", async () => {
  const { controller, checks } = await harness({
    launchBrowser: async () => {
      const error = new Error("no browser");
      error.code = "runtime_missing";
      throw error;
    },
  });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy", proxy: null }),
  ).rejects.toMatchObject({ code: "browser_missing", status: 503 });
  expect(controller.status().job.state).toBe("error");
  expect(controller.status().job.errorCode).toBe("browser_missing");
  expect(checks).toHaveLength(0);
});

test("a missing executable maps to executable_missing", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      const error = new Error("exe gone");
      error.code = "executable_missing";
      throw error;
    },
  });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "executable_missing" });
});

test("an unknown launch code maps to launch_failed", async () => {
  const { controller } = await harness({
    launchBrowser: async () => {
      throw new Error("who knows");
    },
  });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "launch_failed" });
});

test("a page timeout writes no history", async () => {
  const { controller, checks, pending } = await harness({ timeoutMs: 5 });
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  // Never resolve the launcher result: the withTimeout guard fires.
  await controller.whenSettled();
  expect(controller.status().job.state).toBe("error");
  expect(controller.status().job.errorCode).toBe("page_timeout");
  expect(checks).toHaveLength(0);
  pending.resolve({ text: VERDICT_TEXT });
});

test("a launcher rejection writes no history", async () => {
  const { controller, checks, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  pending.reject(Object.assign(new Error("page died"), { code: "page_timeout" }));
  await controller.whenSettled();
  expect(controller.status().job.errorCode).toBe("page_timeout");
  expect(checks).toHaveLength(0);
});

test("an unreadable verdict writes no history", async () => {
  const { controller, checks, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  pending.resolve({ text: "the page is still drawing" });
  await controller.whenSettled();
  expect(controller.status().job.state).toBe("error");
  expect(controller.status().job.errorCode).toBe("verdict_missing");
  expect(checks).toHaveLength(0);
});

test("cancel closes the window and writes no history", async () => {
  const { controller, checks, closed, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  const result = await controller.cancel();
  expect(result.cancelled).toBe(true);
  expect(result.job.state).toBe("cancelled");
  expect(result.job.errorCode).toBe("cancelled");
  expect(closed.count).toBe(1);
  pending.resolve({ text: VERDICT_TEXT });
  await controller.whenSettled();
  expect(checks).toHaveLength(0);
  expect(controller.status().job.state).toBe("cancelled");
});

test("a second start is refused while one is running", async () => {
  const { controller, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toBeInstanceOf(IdentityCheckError);
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "check_busy", status: 409 });
  pending.resolve({ text: VERDICT_TEXT });
  await controller.whenSettled();
  // A terminal state frees the slot.
  expect(controller.status().job.state).toBe("done");
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  await controller.cancel();
});

test("a missing ledger is a 404 and never opens a browser", async () => {
  const { controller, launches } = await harness({ withLedger: false });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "account_not_found", status: 404 });
  expect(launches).toHaveLength(0);
});

test("a missing pinned identity is a 409 and never opens a browser", async () => {
  const { controller, launches } = await harness({ readIdentity: async () => null });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "identity_missing", status: 409 });
  expect(launches).toHaveLength(0);
});

test("a missing browser executable is a 503 before any launch", async () => {
  const { controller, launches } = await harness({ resolveExecutable: async () => null });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "browser_missing", status: 503 });
  expect(launches).toHaveLength(0);
});

test("readIdentity is read-only: it never generates a fingerprint", async () => {
  const { controller, launches } = await harness({
    withIdentity: false,
    readIdentity: async () => null,
  });
  await expect(
    controller.start({ provider: "workbuddy", key: "workbuddy" }),
  ).rejects.toMatchObject({ code: "identity_missing" });
  expect(launches).toHaveLength(0);
});

test("status starts idle and reports whether a window is open", async () => {
  const { controller, pending } = await harness();
  expect(controller.status()).toEqual({ job: expect.objectContaining({ state: "idle" }), browserOpen: false });
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  expect(controller.status().browserOpen).toBe(true);
  await controller.cancel();
  expect(controller.status().browserOpen).toBe(false);
  pending.resolve({ text: VERDICT_TEXT });
});

test("a swallowed onCheck failure does not turn a verdict into an error", async () => {
  const dir = await tempDir();
  const env = { MAGPIE_CLEAN_LOGIN_DATA: dir };
  const accountPath = accountDir(env, "workbuddy", "workbuddy");
  await mkdir(accountPath, { recursive: true });
  await writeAccountMeta(accountPath, { version: 1, provider: "workbuddy", key: "workbuddy" });
  const controller = createIdentityCheck({
    env,
    resolveExecutable: async () => "/fake/browser",
    readIdentity: async () => ({ tag: "pinned" }),
    onCheck: async () => {
      throw new Error("disk full");
    },
    now: () => CHECKED_AT,
    launchBrowser: async () => ({
      pid: 1,
      result: Promise.resolve({ text: VERDICT_TEXT }),
      close: async () => {},
    }),
  });
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  await controller.whenSettled();
  expect(controller.status().job.state).toBe("done");
  expect(controller.status().job.grade).toBe("B");
});

test("close marks a pending run cancelled and closes the window", async () => {
  const { controller, checks, closed, pending } = await harness();
  await controller.start({ provider: "workbuddy", key: "workbuddy" });
  await controller.close();
  expect(closed.count).toBe(1);
  pending.resolve({ text: VERDICT_TEXT });
  await controller.whenSettled();
  expect(checks).toHaveLength(0);
});
