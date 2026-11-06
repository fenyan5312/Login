// Pure ledger helpers. No filesystem, no browser, no network: the whole point
// of these functions is that they can be exercised without touching a real
// config directory or a real proxy credential.
import { expect, test } from "bun:test";
import {
  AccountRecordError,
  CHECK_HISTORY_LIMIT,
  LOGIN_HISTORY_LIMIT,
  NOTE_MAX_LENGTH,
  accountExtras,
  loginSnapshot,
  normalizeNote,
  withCheck,
  withLogin,
  withNote,
} from "../lib/account-records.mjs";

const AT = "2026-11-04T10:00:00.000Z";

// A full stored proxy record: the four whitelisted display fields plus four
// fields that must NEVER reach the ledger or the page.
const FULL_PROXY = {
  id: "p-01",
  name: "Hong Kong 01",
  region: "香港",
  type: "socks5",
  host: "10.0.0.7",
  port: 1080,
  username: "secret-user",
  password: "secret-pass",
  exitIp: "203.0.113.5",
  updatedAt: AT,
};

test("the limits are the contract values", () => {
  expect(NOTE_MAX_LENGTH).toBe(200);
  expect(LOGIN_HISTORY_LIMIT).toBe(20);
  expect(CHECK_HISTORY_LIMIT).toBe(10);
});

test("normalizeNote trims and accepts the boundary", () => {
  expect(normalizeNote("  hello  ")).toBe("hello");
  expect(normalizeNote("")).toBe("");
  expect(normalizeNote("n".repeat(NOTE_MAX_LENGTH))).toBe("n".repeat(NOTE_MAX_LENGTH));
});

test("normalizeNote rejects non-strings and overlong notes", () => {
  for (const value of [undefined, null, 42, {}, ["x"], true]) {
    try {
      normalizeNote(value);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountRecordError);
      expect(error.code).toBe("invalid_note");
      expect(error.status).toBe(400);
    }
  }
  try {
    normalizeNote("n".repeat(NOTE_MAX_LENGTH + 1));
    throw new Error("expected a rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecordError);
    expect(error.code).toBe("invalid_note");
  }
});

test("loginSnapshot whitelists a full proxy record", () => {
  const snapshot = loginSnapshot(FULL_PROXY, AT);
  expect(snapshot).toEqual({
    at: AT,
    proxyId: "p-01",
    proxyName: "Hong Kong 01",
    region: "香港",
    type: "socks5",
  });
  const text = JSON.stringify(snapshot);
  for (const secret of ["secret-user", "secret-pass", "10.0.0.7", "1080", "exitIp"]) {
    expect(text).not.toContain(secret);
  }
});

test("loginSnapshot records a direct connection with no proxy", () => {
  expect(loginSnapshot(null, AT)).toEqual({
    at: AT,
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
  });
});

test("loginSnapshot accepts the sign-in flow's whitelisted proxyMeta", () => {
  expect(loginSnapshot({ id: "p-01", name: "HK", region: "HK", type: "http" }, AT)).toEqual({
    at: AT,
    proxyId: "p-01",
    proxyName: "HK",
    region: "HK",
    type: "http",
  });
});

test("loginSnapshot drops an unknown proxy type", () => {
  expect(loginSnapshot({ ...FULL_PROXY, type: "wireguard" }, AT).type).toBeNull();
});

test("withLogin prepends, preserves other fields and caps at 20", () => {
  const meta = { version: 1, key: "workbuddy", note: "keep me", checks: ["c"] };
  const first = loginSnapshot(null, AT);
  const next = withLogin(meta, first);
  expect(next.note).toBe("keep me");
  expect(next.checks).toEqual(["c"]);
  expect(next.lastLogin).toEqual(first);
  expect(next.loginHistory).toEqual([first]);
  expect(meta.loginHistory).toBeUndefined();

  let grown = { version: 1 };
  for (let i = 0; i < LOGIN_HISTORY_LIMIT + 5; i += 1) {
    grown = withLogin(grown, loginSnapshot(null, `at-${i}`));
  }
  expect(grown.loginHistory).toHaveLength(LOGIN_HISTORY_LIMIT);
  expect(grown.loginHistory[0].at).toBe(`at-${LOGIN_HISTORY_LIMIT + 4}`);
  expect(grown.loginHistory.at(-1).at).toBe("at-5");
});

test("withNote keeps every other ledger field", () => {
  const meta = { version: 1, key: "k", lastLogin: { at: AT }, checks: ["c"] };
  const next = withNote(meta, "a note");
  expect(next).toEqual({ ...meta, note: "a note" });
  expect(meta.note).toBeUndefined();
});

test("withCheck prepends, caps at 10 and keeps earlier records intact", () => {
  const older = { at: AT, grade: "A", proxyId: null, proxyName: "", region: "", exposure: 0, summary: [] };
  const meta = { version: 1, key: "k", note: "keep", loginHistory: [older] };
  const first = { at: "new", grade: "B", proxyId: "p", proxyName: "HK", region: "HK", exposure: 2, summary: ["s"] };
  const next = withCheck(meta, first);
  expect(next.checks).toEqual([first]);
  expect(next.note).toBe("keep");
  expect(next.loginHistory).toEqual([older]);

  let grown = { version: 1, checks: Array.from({ length: 10 }, (_, i) => ({ ...older, at: `old-${i}` })) };
  grown = withCheck(grown, first);
  expect(grown.checks).toHaveLength(CHECK_HISTORY_LIMIT);
  expect(grown.checks[0]).toEqual(first);
  // The oldest record is dropped, the nine more recent ones keep their fields.
  expect(grown.checks.at(-1).at).toBe("old-8");
  expect(grown.checks[9].summary).toEqual([]);
});

test("accountExtras gives defaults for a bare ledger", () => {
  expect(accountExtras(null)).toEqual({
    note: "",
    lastLogin: null,
    loginHistory: [],
    lastCheck: null,
    checks: [],
  });
  expect(accountExtras({ version: 1, key: "k" })).toEqual({
    note: "",
    lastLogin: null,
    loginHistory: [],
    lastCheck: null,
    checks: [],
  });
});

test("accountExtras derives lastCheck and whitelists nested fields", () => {
  const check = {
    at: AT,
    grade: "B",
    proxyId: "p-01",
    proxyName: "HK",
    region: "香港",
    exposure: 2,
    summary: ["one", "two"],
    password: "secret-pass",
    dir: "/home/user/.config/magpie/accounts/x",
    identity: { huge: true },
  };
  const login = {
    at: AT,
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
    host: "10.0.0.7",
    port: 1080,
  };
  const extras = accountExtras({
    note: "n".repeat(NOTE_MAX_LENGTH + 20),
    lastLogin: login,
    loginHistory: [login],
    checks: [check],
  });
  expect(extras.note).toHaveLength(NOTE_MAX_LENGTH);
  expect(extras.lastLogin).toEqual({
    at: AT,
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
  });
  expect(extras.loginHistory).toHaveLength(1);
  expect(extras.checks).toEqual([
    {
      at: AT,
      grade: "B",
      proxyId: "p-01",
      proxyName: "HK",
      region: "香港",
      exposure: 2,
      summary: ["one", "two"],
    },
  ]);
  expect(extras.lastCheck).toEqual(extras.checks[0]);
  const text = JSON.stringify(extras);
  for (const secret of ["secret-pass", "10.0.0.7", "1080", "/home/user", "huge"]) {
    expect(text).not.toContain(secret);
  }
});

test("accountExtras normalizes malformed history entries", () => {
  const extras = accountExtras({
    note: 42,
    lastLogin: "not an object",
    loginHistory: [null, 7, { at: AT, grade: "D", exposure: 4, summary: ["x", 9] }],
    checks: [null, 7, { at: AT, grade: "Z", exposure: -1, summary: "nope" }],
  });
  expect(extras.note).toBe("");
  expect(extras.lastLogin).toBeNull();
  expect(extras.loginHistory).toHaveLength(3);
  expect(extras.checks).toHaveLength(3);
  expect(extras.checks[0].grade).toBeNull();
  expect(extras.checks[0].exposure).toBe(0);
  expect(extras.checks[0].summary).toEqual([]);
  expect(extras.checks[2].grade).toBeNull();
  expect(extras.checks[2].summary).toEqual([]);
});

test("accountExtras caps histories at their limits", () => {
  const extras = accountExtras({
    loginHistory: Array.from({ length: 30 }, (_, i) => ({ at: `l-${i}` })),
    checks: Array.from({ length: 15 }, (_, i) => ({ at: `c-${i}` })),
  });
  expect(extras.loginHistory).toHaveLength(LOGIN_HISTORY_LIMIT);
  expect(extras.checks).toHaveLength(CHECK_HISTORY_LIMIT);
  expect(extras.lastCheck.at).toBe("c-0");
});
