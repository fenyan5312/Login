import { describe, expect, test } from "bun:test";
import { prepareGenericImport, normalizeProviderId } from "../lib/import-generic.mjs";
import { ImportError } from "../lib/import-credential.mjs";

const KEY = "sk-live-abcdefghijklmnop";
const ACCESS = "ya29.abcdefghijklmnopqrstuvwxyz";
const REFRESH = "1//refresh-abcdefghijklmnop";

function fails(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ImportError ${code}`);
}

describe("normalizeProviderId", () => {
  test("accepts a slug and refuses anything that is not one", () => {
    expect(normalizeProviderId("  Codex ")).toBe("codex");
    expect(normalizeProviderId("google.antigravity")).toBe("google.antigravity");
    expect(normalizeProviderId("../etc/passwd")).toBe("");
    expect(normalizeProviderId("a b")).toBe("");
    expect(normalizeProviderId("")).toBe("");
  });
});

describe("prepareGenericImport", () => {
  test("a bare API key becomes an api entry, not oauth", () => {
    const prepared = prepareGenericImport(KEY, { provider: "codex" });
    expect(prepared.kind).toBe("key");
    expect(prepared.body).toEqual({
      type: "api",
      key: KEY,
      accountId: `API key …${KEY.slice(-4)}`,
      uid: `key_${KEY.slice(-4)}`,
    });
    // Nothing but the typed fields ever travels to magpie.
    expect(Object.keys(prepared.body).sort()).toEqual(["accountId", "key", "type", "uid"]);
  });

  test("a base64 key ending in padding is still one key", () => {
    const key = ["dGVzdC1rZXkt", "Zm9yLWdlbmVyaWMtaW1wb3J0=="].join("");
    const prepared = prepareGenericImport(key, { provider: "zcode" });
    expect(prepared.kind).toBe("key");
    expect(prepared.body.key).toBe(key);
  });

  test("JSON oauth keeps only whitelisted fields", () => {
    const prepared = prepareGenericImport(
      JSON.stringify({
        access_token: ACCESS,
        refresh_token: REFRESH,
        email: "someone@example.com",
        expires_in: 1800,
        admin: true,
        nested: { secret: "x" },
      }),
      { provider: "cursor" },
    );
    expect(prepared.kind).toBe("oauth");
    expect(prepared.accountId).toBe("someone@example.com");
    expect(prepared.body.type).toBe("oauth");
    expect(prepared.body.access).toBe(ACCESS);
    expect(prepared.body.refresh).toBe(REFRESH);
    expect(prepared.body.expires).toBeGreaterThan(Date.now());
    expect(prepared.body).not.toHaveProperty("admin");
    expect(prepared.body).not.toHaveProperty("nested");
    expect(JSON.stringify(prepared.body)).not.toContain("secret");
  });

  test("a nested auth wrapper is flattened", () => {
    const prepared = prepareGenericImport(
      JSON.stringify({ account: { email: "a@b.c" }, auth: { accessToken: ACCESS } }),
      { provider: "kiro" },
    );
    expect(prepared.kind).toBe("oauth");
    expect(prepared.body.access).toBe(ACCESS);
    expect(prepared.accountId).toBe("a@b.c");
  });

  test("a Cookie header and key=value pairs are read", () => {
    const cookie = prepareGenericImport(
      `Cookie: access_token=${ACCESS}; refresh_token=${REFRESH}`,
      { provider: "codex" },
    );
    expect(cookie.body.access).toBe(ACCESS);
    expect(cookie.body.refresh).toBe(REFRESH);

    const pairs = prepareGenericImport(`access=${ACCESS}&refresh=${REFRESH}`, { provider: "codex" });
    expect(pairs.body.access).toBe(ACCESS);
    expect(pairs.body.refresh).toBe(REFRESH);
  });

  test("a Bearer line is the access token", () => {
    const prepared = prepareGenericImport(`Bearer ${ACCESS}`, { provider: "codex" });
    expect(prepared.kind).toBe("oauth");
    expect(prepared.body.access).toBe(ACCESS);
    // No refresh token is carried, and the notice says so instead of hiding it.
    expect(prepared.body).not.toHaveProperty("refresh");
    expect(prepared.notice).toContain("refresh");
  });

  test("a JWT is labelled from its own claims", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u-42", email: "jwt@example.com" })).toString(
      "base64url",
    );
    const jwt = `header.${payload}.signature`;
    const prepared = prepareGenericImport(jwt, { provider: "zcode" });
    expect(prepared.uid).toBe("u-42");
    expect(prepared.accountId).toBe("jwt@example.com");
  });

  test("a duplicate key is refused without echoing it", () => {
    const entries = { codex: { type: "api", key: KEY } };
    try {
      prepareGenericImport(KEY, { provider: "codex", entries });
      throw new Error("expected a duplicate");
    } catch (error) {
      expect(error.code).toBe("duplicate_key");
      expect(error.message).not.toContain(KEY);
    }
  });

  test("a duplicate oauth credential is refused", () => {
    const entries = { cursor: { type: "oauth", access: ACCESS, refresh: REFRESH } };
    fails(() => prepareGenericImport(JSON.stringify({ access_token: ACCESS }), {
      provider: "cursor",
      entries,
    }), "duplicate_account");
  });

  test("refuses an empty box, an unreadable JSON and an invalid provider", () => {
    fails(() => prepareGenericImport("   ", { provider: "codex" }), "empty");
    fails(() => prepareGenericImport('{"access_token":', { provider: "codex" }), "unreadable");
    fails(() => prepareGenericImport(KEY, { provider: "../x" }), "invalid_provider");
    fails(() => prepareGenericImport("short", { provider: "codex" }), "no_secret");
  });

  test("seconds are converted to milliseconds", () => {
    const prepared = prepareGenericImport(
      JSON.stringify({ access_token: ACCESS, expires_at: 2_000_000_000 }),
      { provider: "codex" },
    );
    expect(prepared.body.expires).toBe(2_000_000_000_000);
  });
});
