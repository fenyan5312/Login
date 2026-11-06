// Builds a ready-to-submit GitHub issue from one provider card, so someone who
// hits a problem can report it in a few clicks without writing an issue body.
//
// Two rules shape this file:
//
//   1. Everything in the body comes from a fixed allowlist of fields, each
//      flattened to a single line and cut to a fixed length. Nothing is passed
//      through raw from the page, nothing is read from the credential files,
//      and no field is rendered unless it is named here. Account names,
//      cookies, tokens and proxy credentials therefore cannot reach the issue
//      through this path.
//
//   2. The issue URL must stay short enough for the shortest launch path we
//      use (the Windows `start` command caps a command line at 8191
//      characters), so the body has a budget and the final URL is checked
//      before the service hands it to the operating system.

export const ISSUE_REPO = "fenyan5312/Login";
export const ISSUE_NEW_URL = `https://github.com/${ISSUE_REPO}/issues/new`;
export const MAX_NOTE_CHARS = 1500;
export const MAX_FIELD_CHARS = 300;
export const MAX_TITLE_CHARS = 140;
export const MAX_BODY_CHARS = 5000;
// Windows' CreateProcess ceiling is 32767 characters; stay well below it so a
// long body can never make the launch fail, while leaving room for CJK prose
// (nine percent-encoded characters per glyph).
export const MAX_URL_CHARS = 12000;

// What the reader sees when the reporter did not describe the problem. The
// body still goes out: a card report with no description is still useful, and
// asking for a description must never be a wall between the user and the
// button.
export const NOTE_PLACEHOLDER = "（未填写：请补充你看到的现象）";

const STATES = {
  pending: "等待验证 (pending)",
  ready: "就绪 (ready)",
  blocked: "已阻止 (blocked)",
};

// One line, no control characters, no runs of whitespace, cut to `max`.
// Control characters are dropped rather than escaped because they would
// otherwise travel into the URL and the issue body.
export function oneLine(value, max = MAX_FIELD_CHARS) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!max || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// A localized value can be a plain string or the { en, zh, "zh-TW", ja }
// object the provider registry uses. Pick the reporter's language, then zh,
// then en, then anything — never JSON-dump the whole object into the issue.
export function localized(value, language = "zh") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const order = [language, "zh-Hans", "zh", "en", "zh-TW", "ja"];
  for (const key of order) {
    const hit = value[key];
    if (typeof hit === "string" && hit.trim()) return hit;
  }
  for (const hit of Object.values(value)) {
    if (typeof hit === "string" && hit.trim()) return hit;
  }
  return "";
}

// A Markdown table cell: pipes and newlines would break the row.
function cell(value) {
  return oneLine(value).replace(/\|/g, "\\|") || "—";
}

function methodLine(methods) {
  if (!Array.isArray(methods) || !methods.length) return "";
  return methods
    .map((method) => oneLine(method?.label || method?.type || "", 80))
    .filter(Boolean)
    .join(" · ");
}

function sourceLine(sources = {}) {
  const names = [];
  if (sources.local) names.push("本地注册表");
  if (sources.magpie) names.push("magpie 名单");
  if (sources.pluginPackage) names.push("已安装插件");
  return names.join(" · ");
}

function scanLine(scan) {
  if (!scan || typeof scan !== "object") return "";
  if (scan.error) return `失败：${oneLine(scan.error, 120)}`;
  if (scan.scanned) return "已完成";
  if (scan.available) return "可用，未完成扫描";
  return "不可用";
}

// `${id}` prefix keeps the title filterable; the tail is the reporter's own
// words so the issue list reads like a list of problems, not of providers.
export function issueTitle({ providerId, providerName, note }) {
  const id = oneLine(providerId, 40) || "unknown";
  const name = oneLine(providerName, 60);
  const head = name && name !== id ? `[${id}] ${name}` : `[${id}]`;
  const tail = oneLine(note, 80);
  const title = tail ? `${head} — ${tail}` : `${head} Login 问题反馈`;
  return oneLine(title, MAX_TITLE_CHARS);
}

export function buildIssueReport(input = {}) {
  const provider = input.provider && typeof input.provider === "object" ? input.provider : {};
  const language = oneLine(input.language, 12) || "zh";
  // noteLimit lets buildIssueRequest shrink the reporter's own words until the
  // finished URL fits, without touching anything else in the body.
  const noteLimit = Number.isFinite(input.noteLimit)
    ? Math.max(0, Math.floor(input.noteLimit))
    : MAX_NOTE_CHARS;
  const noteFull = oneLine(input.userNote, 1e9);
  const note = oneLine(input.userNote, noteLimit);
  const platform = input.platform && typeof input.platform === "object" ? input.platform : {};
  const runtime = input.runtime && typeof input.runtime === "object" ? input.runtime : {};

  const providerId = oneLine(provider.id, 60);
  const providerName = oneLine(localized(provider.name, language), 80);
  const state = provider.capabilityState || provider.capability?.state || "";
  const reason = localized(provider.capabilityReason ?? provider.capability?.reason, language);
  const description = localized(provider.description, language);
  const notice = localized(provider.notice, language);
  const methods = methodLine(provider.authMethods);
  const sources = sourceLine(provider.sources);
  const pluginPackage = oneLine(provider.pluginPackage, 80);
  const scan = scanLine(input.pluginScan);
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const stamp = Number.isNaN(now.getTime()) ? "未知" : now.toISOString();

  const rows = [
    ["供应商", providerId ? `${cell(providerName)} (\`${oneLine(providerId, 60)}\`)` : cell(providerName)],
    ["状态", cell(STATES[state] || state)],
    ["状态说明", cell(reason)],
    ["卡片说明", cell(description)],
    ["插件说明", cell(notice)],
    ["登录方式", cell(methods)],
    ["名单来源", cell(sources)],
    ["插件条目", cell(pluginPackage)],
  ].filter(([, value]) => value && value !== "—");

  const envRows = [
    ["Login", cell(input.pluginVersion)],
    ["插件扫描", cell(scan)],
    ["系统", cell([platform.platform, platform.arch].filter(Boolean).join(" "))],
    ["运行时", cell([runtime.name, runtime.version].filter(Boolean).join(" "))],
    ["时间", cell(stamp)],
  ].filter(([, value]) => value && value !== "—");

  const parts = [
    "### 现象",
    "",
    note || NOTE_PLACEHOLDER,
    "",
    "### 出问题的卡片",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "### 运行环境",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    ...envRows.map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "### 说明",
    "",
    "此正文由 Login 的「报告问题」按钮自动生成：只包含上面这些字段，**不含账号、cookie、令牌或代理凭据**。",
    "如果你能补充复现步骤、你点过的按钮和实际结果，会非常有帮助。",
  ];

  let body = parts.join("\n");
  // The note may have been cut to fit the URL budget, or the body as a whole
  // may have hit its own ceiling; either way the reporter is told.
  let truncated = note !== noteFull;
  if (body.length > MAX_BODY_CHARS) {
    truncated = true;
    body = `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
  }

  return {
    title: issueTitle({ providerId, providerName, note }),
    body,
    truncated,
    repo: ISSUE_REPO,
  };
}

// percent-encode with %20 instead of "+": GitHub parses the query as a form,
// but a literal "+" in the body would then turn into a space and mangle any
// text a user typed. encodeURIComponent leaves no ambiguity.
function encode(value) {
  return encodeURIComponent(value);
}

export function issueNewUrl({ title, body, labels }) {
  const query = [`title=${encode(oneLine(title, MAX_TITLE_CHARS))}`, `body=${encode(body ?? "")}`];
  if (labels) query.push(`labels=${encode(oneLine(labels, 120))}`);
  return `${ISSUE_NEW_URL}?${query.join("&")}`;
}

// The one URL the service will ask the operating system to open. The page
// sends a provider id and a note; the service builds the URL. Nothing a page
// can send may widen this: it must be GitHub's issue form for our own repo.
export function isAllowedIssueUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "github.com") return false;
  if (parsed.pathname !== `/${ISSUE_REPO}/issues/new`) return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

export function buildIssueRequest(input = {}) {
  // Chinese prose percent-encodes to nine characters per glyph and an emoji to
  // twelve, so a character-count budget would sail past the real limit. Shrink
  // the note against the encoded length until the finished URL fits.
  let limit = Number.isFinite(input.noteLimit) ? input.noteLimit : MAX_NOTE_CHARS;
  let report = buildIssueReport({ ...input, noteLimit: limit });
  let url = issueNewUrl({ title: report.title, body: report.body, labels: "user-report" });
  for (let guard = 0; guard < 60 && url.length > MAX_URL_CHARS && limit > 0; guard += 1) {
    const excess = url.length - MAX_URL_CHARS;
    limit = Math.max(0, limit - Math.max(1, Math.ceil(excess / 9)));
    report = buildIssueReport({ ...input, noteLimit: limit });
    url = issueNewUrl({ title: report.title, body: report.body, labels: "user-report" });
  }
  return { ...report, url, urlLength: url.length, overBudget: url.length > MAX_URL_CHARS };
}
