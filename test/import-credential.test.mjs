import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "msg-import-"));
process.env.MAGPIE_CONFIG_DIR = root;

const { ImportError, prepareImport } = await import("../lib/import-credential.mjs");

function jwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function writeAuth(entries) {
  writeFileSync(join(root, "plugin-auth.json"), JSON.stringify(entries));
}

function liveFetch(overrides = {}) {
  return async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        code: 0,
        data: {
          accessToken: jwt({ sub: "u1", nickname: "Alice" }),
          refreshToken: "refresh-2",
          expiresIn: 3600,
          tokenType: "Bearer",
          domain: "copilot.tencent.com",
          ...overrides,
        },
      });
    },
  });
}

beforeEach(() => {
  rmSync(join(root, "plugin-auth.json"), { force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("prepareImport", () => {
  test("reads a nested credential and proves it with one refresh", async () => {
    const access = jwt({ sub: "u1", nickname: "Alice" });
    const text = JSON.stringify({
      account: { uid: "u1", nickname: "Alice" },
      auth: { accessToken: access, refreshToken: "refresh-1", domain: "copilot.tencent.com" },
    });

    const prepared = await prepareImport(text, { fetchImpl: liveFetch() });

    expect(prepared.kind).toBe("oauth");
    expect(prepared.accountId).toBe("Alice");
    expect(prepared.uid).toBe("u1");
    expect(prepared.result.refresh).toBe("refresh-2");
    expect(prepared.result.type).toBe("success");
    expect(prepared.result.access).toContain(".");
  });

  test("reads a Cookie header", async () => {
    const access = jwt({ sub: "u2" });
    const text = `Cookie: access_token=${access}; refresh_token=refresh-cookie`;
    // The refresh response is authoritative: it is the same account, and its
    // claims replace the ones in the pasted cookie.
    const prepared = await prepareImport(text, { fetchImpl: liveFetch({ accessToken: access }) });
    expect(prepared.uid).toBe("u2");
    expect(prepared.accountId).toBe("u2");
  });

  test("takes an API key without a refresh request", async () => {
    const prepared = await prepareImport("ck_abcdefghijklmn", {
      fetchImpl: async () => {
        throw new Error("must not be called for a key");
      },
    });
    expect(prepared.kind).toBe("key");
    expect(prepared.result.type).toBe("success");
    expect(prepared.result.key).toBe("ck_abcdefghijklmn");
  });

  test("refuses a credential without a refresh token", async () => {
    const access = jwt({ sub: "u3" });
    await expect(prepareImport(JSON.stringify({ accessToken: access }))).rejects.toBeInstanceOf(ImportError);
  });

  test("refuses an account magpie already holds", async () => {
    writeAuth({ workbuddy: { type: "oauth", uid: "u1", accountId: "Alice" } });
    const text = JSON.stringify({
      account: { uid: "u1" },
      auth: { accessToken: jwt({ sub: "u1" }), refreshToken: "r" },
    });
    await expect(prepareImport(text, { fetchImpl: liveFetch() })).rejects.toThrow(/已经在 magpie 里/);
  });

  test("refuses a duplicate API key", async () => {
    writeAuth({ workbuddy: { type: "api", key: "ck_abcdefghijklmn" } });
    await expect(prepareImport("ck_abcdefghijklmn")).rejects.toThrow(/API key 已经在/);
  });

  test("reports a refresh rejection instead of storing it", async () => {
    const text = JSON.stringify({
      account: { uid: "u9" },
      auth: { accessToken: jwt({ sub: "u9" }), refreshToken: "dead" },
    });
    const fetchImpl = async () => ({
      ok: false,
      async text() {
        return JSON.stringify({ code: 40001, msg: "token expired" });
      },
    });
    await expect(prepareImport(text, { fetchImpl })).rejects.toThrow(/token expired/);
  });

  test("an empty box is a readable error", async () => {
    await expect(prepareImport("   ")).rejects.toThrow(/框是空的/);
  });
});
