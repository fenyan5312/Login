// The verdict parser against real who.1ms.dog page text. The three fixtures
// are verbatim public-site text (B/C/D grades) copied from the trial run; they
// contain no proxy credential, no username/password/host/port and no path.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHECK_ERROR_CODES,
  CHECK_STATES,
  CHECK_URL,
  DEFAULT_CHECK_TIMEOUT_MS,
  checkProfileDir,
  checkTimeoutMs,
  idleCheckJob,
  parseWhoVerdict,
  waitForIdentityVerdict,
} from "../lib/identity-check.mjs";

const FIXTURES = join(import.meta.dir, "fixtures");
const CASES = [
  { file: "who-verdict-b.txt", grade: "B", exposure: 2, fingerprintId: "60fcf071·b5edbc6e" },
  { file: "who-verdict-c.txt", grade: "C", exposure: 3, fingerprintId: "d76f7983·0d9f8a1c" },
  { file: "who-verdict-d.txt", grade: "D", exposure: 4, fingerprintId: "437fdcb4·36495d9f" },
];

for (const sample of CASES) {
  test(`parseWhoVerdict reads grade ${sample.grade} from ${sample.file}`, async () => {
    const text = await readFile(join(FIXTURES, sample.file), "utf8");
    const verdict = parseWhoVerdict(text);
    expect(verdict).not.toBeNull();
    expect(verdict.grade).toBe(sample.grade);
    expect(verdict.exposure).toBe(sample.exposure);
    expect(verdict.fingerprintId).toBe(sample.fingerprintId);
    // The four narrative lines after "网站眼中的你", never the whole page.
    expect(verdict.summary).toHaveLength(4);
    for (const line of verdict.summary) {
      expect(line.startsWith("你")).toBe(true);
      expect(line.length).toBeGreaterThan(0);
    }
    expect(verdict.summary[0]).toContain("你多半是");
  });

  test(`${sample.file} is public site text with no credentials`, async () => {
    const text = await readFile(join(FIXTURES, sample.file), "utf8");
    // Public site prose only: no stored proxy record, no URL with credentials
    // and no secret assignment. Bare words like "WebRTC host candidate" and
    // "isTypeSupported" are ordinary page text, not credentials.
    expect(text).not.toMatch(/password|passwd|secret|api[_-]?key|bearer/i);
    expect(text).not.toMatch(/[a-z]+:\/\/[^\s]*@/i);
    expect(text).not.toMatch(/(?:username|password|host|port)\s*[:=]\s*\S+/i);
    expect(text).toContain("网站眼中的你");
    expect(text).toContain("浏览器指纹 ID");
  });
}

test("parseWhoVerdict returns null without a grade", () => {
  expect(parseWhoVerdict("")).toBeNull();
  expect(parseWhoVerdict("网站眼中的你\n你多半是中国人\n浏览器指纹 ID\nabcdefgh·ijklmnop")).toBeNull();
  expect(parseWhoVerdict(null)).toBeNull();
  expect(parseWhoVerdict(42)).toBeNull();
});

test("parseWhoVerdict always gives a definite exposure and grade A is clean", () => {
  const a = parseWhoVerdict("网站眼中的你\n你多半是中国人\n浏览器指纹 ID\nabcdefgh·ijklmnop\n评分 A");
  expect(a.grade).toBe("A");
  expect(a.exposure).toBe(0);
  expect(a.summary).toHaveLength(1);
  expect(a.fingerprintId).toBe("abcdefgh·ijklmnop");
});

test("parseWhoVerdict tolerates CRLF and missing optional sections", () => {
  const text = ["网站眼中的你", "你多半是中国人", "你手上这台是电脑", "浏览器指纹 ID", "12345678·90abcdef", "评分 B"].join("\r\n");
  const verdict = parseWhoVerdict(text);
  expect(verdict.grade).toBe("B");
  expect(verdict.exposure).toBe(0);
  expect(verdict.summary).toHaveLength(2);
  expect(verdict.fingerprintId).toBe("12345678·90abcdef");
});

test("waitForIdentityVerdict returns the page text once a verdict appears", async () => {
  const text = await readFile(join(FIXTURES, "who-verdict-b.txt"), "utf8");
  const polls = ["still drawing", "", text.slice(0, 20), text];
  const page = { evaluate: async () => polls.shift() ?? "" };
  const sleeps = [];
  let clock = 0;
  const result = await waitForIdentityVerdict(page, {
    timeoutMs: 10_000,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  expect(result).toBe(text);
  expect(sleeps).toEqual([100, 100, 100]);
});

test("waitForIdentityVerdict returns null on timeout", async () => {
  const page = { evaluate: async () => "no verdict here" };
  let clock = 0;
  const result = await waitForIdentityVerdict(page, {
    timeoutMs: 300,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(result).toBeNull();
});

test("waitForIdentityVerdict ignores a page that throws while closing", async () => {
  const page = { evaluate: async () => { throw new Error("page closed"); } };
  let clock = 0;
  const result = await waitForIdentityVerdict(page, {
    timeoutMs: 100,
    intervalMs: 50,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(result).toBeNull();
});

test("the check constants describe the whole lifecycle", () => {
  expect(CHECK_STATES).toEqual(["idle", "launching", "checking", "done", "error", "cancelled"]);
  expect(CHECK_URL).toBe("https://who.1ms.dog/zh-cn/");
  expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(90_000);
  expect(CHECK_ERROR_CODES).toContain("page_timeout");
  expect(CHECK_ERROR_CODES).toContain("verdict_missing");
  expect(CHECK_ERROR_CODES).toContain("check_busy");
  expect(CHECK_ERROR_CODES).toContain("account_not_found");
});

test("checkProfileDir is a sibling of the login profile", () => {
  expect(checkProfileDir(join("/data", "accounts", "workbuddy", "workbuddy"))).toBe(
    join("/data", "accounts", "workbuddy", "workbuddy", "check-profile"),
  );
});

test("checkTimeoutMs honors the environment override", () => {
  expect(checkTimeoutMs({})).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  expect(checkTimeoutMs({ MAGPIE_CLEAN_LOGIN_CHECK_TIMEOUT_MS: "1500" })).toBe(1500);
  expect(checkTimeoutMs({ MAGPIE_CLEAN_LOGIN_CHECK_TIMEOUT_MS: "nope" })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
  expect(checkTimeoutMs({ MAGPIE_CLEAN_LOGIN_CHECK_TIMEOUT_MS: "-1" })).toBe(DEFAULT_CHECK_TIMEOUT_MS);
});

test("idleCheckJob exposes whitelisted fields only", () => {
  expect(idleCheckJob()).toEqual({
    state: "idle",
    provider: "",
    key: "",
    proxyId: null,
    proxyName: "",
    region: "",
    type: null,
    grade: null,
    exposure: null,
    summary: [],
    fingerprintId: null,
    error: "",
    errorCode: "",
    startedAt: null,
    finishedAt: null,
  });
  expect(JSON.stringify(idleCheckJob())).not.toMatch(/password|host|port|dir|identity/);
});
