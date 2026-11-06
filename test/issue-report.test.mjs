// The ready-to-submit issue report: the allowlist that keeps credentials out,
// the truncation that keeps the URL launchable, and the one URL the service
// admits.

import { expect, test } from "bun:test";
import {
  ISSUE_NEW_URL,
  MAX_NOTE_CHARS,
  MAX_URL_CHARS,
  buildIssueReport,
  buildIssueRequest,
  isAllowedIssueUrl,
  issueNewUrl,
  localized,
  oneLine,
} from "../lib/issue-report.mjs";

const provider = {
  id: "antigravity",
  name: { en: "Google Antigravity", "zh-Hans": "Google Antigravity" },
  capabilityState: "pending",
  capabilityReason: { "zh-Hans": "本插件尚未验证 Antigravity 的登录流程。" },
  description: { "zh-Hans": "尚未实现登录。认证主机与回调端口是假定且未验证的。" },
  notice: { "zh-Hans": "" },
  authMethods: [{ type: "browser-oauth", label: "浏览器登录" }],
  sources: { local: true, magpie: true, pluginPackage: "@gruu6y/page-clean-login" },
  pluginPackage: "@gruu6y/page-clean-login",
  // These are not part of the allowlist and must never reach the body.
  cookie: "SESSION=super-secret-value",
  token: "ghp_1234567890abcdef",
  proxyPassword: "hunter2",
};

const base = {
  provider,
  userNote: "点添加账号之后浏览器没有打开。",
  language: "zh-Hans",
  pluginVersion: "0.1.14",
  pluginScan: { available: true, scanned: true, error: null },
  platform: { platform: "win32", arch: "x64" },
  runtime: { name: "bun", version: "1.4.4" },
  now: new Date("2026-11-06T05:40:00.000Z"),
};

test("the body never carries a single credential-shaped field", () => {
  const report = buildIssueReport(base);
  for (const secret of ["SESSION", "super-secret-value", "ghp_", "hunter2"]) {
    expect(report.body).not.toContain(secret);
    expect(report.title).not.toContain(secret);
  }
});

test("the body names the card, the state and the environment", () => {
  const report = buildIssueReport(base);
  expect(report.body).toContain("antigravity");
  expect(report.body).toContain("等待验证 (pending)");
  expect(report.body).toContain("本插件尚未验证 Antigravity 的登录流程。");
  expect(report.body).toContain("浏览器登录");
  expect(report.body).toContain("win32 x64");
  expect(report.body).toContain("0.1.14");
  expect(report.body).toContain("2026-11-06T05:40:00.000Z");
  expect(report.body).toContain("不含账号、cookie、令牌或代理凭据");
});

test("the title is filterable by provider id and carries the reporter's words", () => {
  const report = buildIssueReport(base);
  expect(report.title.startsWith("[antigravity]")).toBe(true);
  expect(report.title).toContain("浏览器没有打开");
});

test("a missing description is not a wall: the report still goes out", () => {
  const report = buildIssueReport({ ...base, userNote: "" });
  expect(report.title).toContain("[antigravity]");
  expect(report.body).toContain("未填写");
  expect(report.truncated).toBe(false);
});

test("a very long note is cut, and the cut is reported", () => {
  const report = buildIssueReport({ ...base, userNote: "啊".repeat(MAX_NOTE_CHARS * 3) });
  expect(report.body).not.toContain("啊".repeat(MAX_NOTE_CHARS + 10));
  expect(report.truncated).toBe(true);
});

test("oneLine flattens control characters and runs of whitespace", () => {
  expect(oneLine("a\u0000b\n\nc\t\td  ")).toBe("a b c d");
  expect(oneLine("x".repeat(400), 10)).toBe(`${"x".repeat(9)}…`);
});

test("localized prefers the reporter's language, then zh, then en", () => {
  const value = { en: "English", "zh-Hans": "简体", ja: "日本語" };
  expect(localized(value, "ja")).toBe("日本語");
  expect(localized(value, "zh-Hans")).toBe("简体");
  expect(localized({ en: "English" }, "ja")).toBe("English");
  expect(localized("plain", "ja")).toBe("plain");
  expect(localized(null, "ja")).toBe("");
});

test("the issue URL is our repo's new-issue form and nothing else", () => {
  expect(isAllowedIssueUrl(ISSUE_NEW_URL)).toBe(true);
  expect(isAllowedIssueUrl(`${ISSUE_NEW_URL}?title=a&body=b`)).toBe(true);
  expect(isAllowedIssueUrl("https://github.com/Gruu6y/clean-login/issues")).toBe(false);
  expect(isAllowedIssueUrl("https://github.com/Gruu6y/clean-login/issues/new/choose")).toBe(false);
  expect(isAllowedIssueUrl("https://github.com/someone-else/clean-login/issues/new")).toBe(false);
  expect(isAllowedIssueUrl("http://github.com/Gruu6y/clean-login/issues/new")).toBe(false);
  expect(isAllowedIssueUrl("https://user:pass@github.com/Gruu6y/clean-login/issues/new")).toBe(false);
  expect(isAllowedIssueUrl("file:///etc/passwd")).toBe(false);
  expect(isAllowedIssueUrl("javascript:alert(1)")).toBe(false);
  expect(isAllowedIssueUrl("not a url")).toBe(false);
  expect(isAllowedIssueUrl("")).toBe(false);
});

test("the URL encodes spaces as %20, so a typed body survives the round trip", () => {
  const url = issueNewUrl({ title: "a b", body: "line one\nline two & more" });
  expect(url).not.toContain("+");
  const query = new URL(url).searchParams;
  expect(query.get("title")).toBe("a b");
  expect(query.get("body")).toBe("line one\nline two & more");
});

test("buildIssueRequest returns a URL that decodes back to the shown body", () => {
  const request = buildIssueRequest(base);
  expect(request.url.startsWith(`${ISSUE_NEW_URL}?`)).toBe(true);
  expect(request.url.length).toBeLessThanOrEqual(MAX_URL_CHARS);
  expect(request.overBudget).toBe(false);
  const query = new URL(request.url).searchParams;
  expect(query.get("body")).toBe(request.body);
  expect(query.get("title")).toBe(request.title);
  expect(query.get("labels")).toBe("user-report");
});

test("even a hostile note keeps the URL inside the launch budget", () => {
  // A note full of characters that expand under percent-encoding: if the
  // budget were only counted in characters, this would blow past the limit.
  const request = buildIssueRequest({ ...base, userNote: "🙂&\n".repeat(1500) });
  expect(request.url.length).toBeLessThanOrEqual(MAX_URL_CHARS);
  expect(isAllowedIssueUrl(request.url)).toBe(true);
});
