// Read-file checks for the accounts page v2: the markup, the app wiring, the
// four language tables and the mobile label stylesheet. No DOM and no browser
// is needed — the real UI is served to the launcher frame, not started here.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");
const app = readFileSync(join(root, "ui", "app.js"), "utf8").replaceAll("\r\n", "\n");
const css = readFileSync(join(root, "ui", "style.css"), "utf8");
const view = readFileSync(join(root, "ui", "account-view.js"), "utf8");
const importJs = readFileSync(join(root, "ui", "import.js"), "utf8");
const state = readFileSync(join(root, "ui", "account-state.js"), "utf8");

const buttonIds = [
  "tab-providers", "tab-proxies", "tab-accounts", "retry", "add-proxy",
  "add-proxy-empty", "environment-prepare", "environment-cancel",
  "environment-retry", "filter-reset", "score-cancel", "proxy-close",
  "test-proxy", "proxy-cancel", "save-proxy", "confirm-close", "confirm-cancel",
  "confirm-action", "signin-close", "signin-cancel", "signin-close-footer",
  "signin-start", "identities-retry", "accounts-refresh",
  "account-filter-all", "account-filter-signed-in", "account-filter-signed-out",
  "account-detail-close", "account-detail-dismiss", "account-detail-check",
  "account-detail-note-save", "account-check-close", "account-check-dismiss",
  "account-check-cancel", "account-check-reexit", "account-check-details",
  "account-check-change-exit", "account-check-start", "account-check-again",
  "account-check-retry",
  "report-close", "report-cancel", "report-copy-body", "report-open",
  "import-credential", "import-close", "import-cancel", "import-submit",
];

test("the accounts tab and panel ship every control", () => {
  for (const id of [
    "tab-accounts", "tab-accounts-label", "account-count", "panel-accounts",
    "accounts-title", "accounts-copy", "accounts-refresh", "accounts-notice",
    "account-toolbar", "account-search", "account-search-label",
    "account-sort", "account-sort-label", "account-sort-last-login",
    "account-sort-name", "account-sort-provider", "account-sort-grade",
    "account-filters", "account-filter-label", "account-filter-chips",
    "account-filter-count", "grade-legend", "grade-legend-label",
    "grade-a", "grade-b", "grade-c", "grade-d", "grade-disclaimer",
    "account-table", "accounts-list", "accounts-empty",
    "account-col-name", "account-col-fingerprint", "account-col-last-login",
    "account-col-check", "account-col-status", "account-col-actions",
    "toasts",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
  for (const value of ["all", "signedIn", "signedOut"]) {
    expect(html).toContain(`data-account-filter="${value}"`);
  }
  // Six columns, in the contract's order.
  const head = /<div class="proxy-table-head account-table-head"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  for (const id of [
    "account-col-name", "account-col-fingerprint", "account-col-last-login",
    "account-col-check", "account-col-status", "account-col-actions",
  ]) {
    expect(head).toContain(`id="${id}"`);
  }
  expect(html).toContain('id="account-detail-dialog"');
  expect(html).toContain('id="account-check-dialog"');
  expect(html).toContain('id="account-check-proxy"');
  expect(html).toContain('id="account-detail-note"');
  expect(html).toContain('id="toasts"');
});

test("both dialogs ship their four check states and real footer controls", () => {
  for (const id of [
    "account-check-setup", "account-check-running", "account-check-result",
    "account-check-failed", "account-check-error", "account-check-grade",
    "account-check-summary", "account-check-verdict", "account-check-lines",
    "account-check-exit", "account-check-time", "account-check-failed-title",
    "account-check-failed-detail", "account-check-failed-lines",
    "account-detail-facts", "account-detail-history", "account-detail-error",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
});

test("every button is type=button, has an id, and is really wired", () => {
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  expect(buttons.length).toBe(buttonIds.length);
  for (const tag of buttons) {
    expect(tag).toContain('type="button"');
    expect(tag).not.toContain('type="submit"');
  }
  for (const id of buttonIds) {
    expect(html).toContain(`id="${id}"`);
    if (id === "save-proxy") continue;
    // The paste-credential dialog owns its own controls; every other button
    // is wired by the main app module.
    if (id.startsWith("import-")) {
      expect(importJs).toContain(`byId("${id}")`);
      continue;
    }
    expect(app).toContain(`byId("${id}").addEventListener`);
  }
  // No demonstration markup, no injection sink, no placeholder actions.
  expect(html).not.toMatch(/innerHTML|mock|preview|data-add|account-menu/i);
  expect(app).not.toMatch(/innerHTML|\bmock\b|simulat|preview|example\.com|data-add/i);
  expect(view).not.toMatch(/innerHTML|\bmock\b|simulat|preview/i);
  expect(state).not.toMatch(/innerHTML|\bmock\b|simulat|preview/i);
});

test("the page only reads real endpoints and never invents a verdict", () => {
  for (const needle of [
    'api("api/accounts")',
    'api("api/proxies")',
    'api("api/accounts")',
    'method: "PATCH"',
    'method: "POST"',
    'body: { note }',
    'body: { proxyId }',
    "accountCheckPath(context.provider, context.key)",
    "${accountCheckPath(context.provider, context.key)}/cancel",
    "ACCOUNT_CHECK_POLL_MS = 800",
    "serverErrorText(error)",
    "loadAccountIdentities()",
    "renderAccounts()",
    "formatCheckSummary(job",
    "formatExit(",
    "filterAccounts(accountIdentities",
    "sortAccounts(",
    "openSignInDialog(provider, { accountKey: view.key })",
    "askClearIdentity(account)",
  ]) {
    expect(app).toContain(needle);
  }
  // Failure never overwrites the last verdict: the server is re-read.
  expect(app).toContain("renderCheckFailed(context.job, context.lastCheck)");
  expect(app).toContain("accountCheckFailedNoVerdict");
  expect(app).toContain("accountCheckFailedKeepPrevious");
});

test("mobile cells show their own field labels", () => {
  expect(app).toContain('setAttribute("data-label", label)');
  expect(css).toContain("@media (max-width: 940px)");
  expect(css).toContain("content: attr(data-label)");
});

test("every new string exists in all four language tables", () => {
  const keys = [
    "accounts", "accountsTitle", "accountsCopy", "accountsRefresh",
    "accountsRefreshing", "accountsRefreshed", "accountSearchLabel",
    "accountSearchPlaceholder", "accountSortLabel", "accountSortLastLogin",
    "accountSortName", "accountSortProvider", "accountSortGrade",
    "accountFilterLabel", "accountFilterAll", "accountFilterSignedIn",
    "accountFilterSignedOut", "accountFilterCount", "accountEmpty",
    "accountEmptyCopy", "accountNoMatch", "accountColName",
    "accountColFingerprint", "accountColLastLogin", "accountColCheck",
    "accountColStatus", "accountColActions", "accountUnverified",
    "accountUnverifiedTitle", "accountSignedIn", "accountSignedOut",
    "accountCheckNone", "accountChecking", "accountFingerprintPinned",
    "accountFingerprintNone", "accountExitDirect", "accountLastLoginAt",
    "accountCheckExposure", "accountRelogin", "accountReloginTitle",
    "accountCheck", "accountDetail", "accountClear", "accountCheckBusy",
    "gradeLegendLabel", "gradeA", "gradeB", "gradeC", "gradeD",
    "gradeDisclaimer", "gradeMeaningA", "gradeMeaningB", "gradeMeaningC",
    "gradeMeaningD", "accountDetailTitle", "accountDetailProvider",
    "accountDetailKey", "accountDetailFingerprint", "accountDetailPinnedAt",
    "accountDetailLastLoginExit", "accountDetailStatus", "accountDetailNote",
    "accountDetailNoteSave", "accountDetailNoteSaving", "accountDetailNoteHint",
    "accountDetailNoteEmpty", "accountDetailSaved",
    "accountDetailNoteTooLong", "accountDetailSigninHint",
    "accountDetailRetiredHint", "accountDetailHistoryTitle",
    "accountDetailHistoryEmpty", "accountDetailHistoryLine",
    "accountDetailDismiss", "accountCheckFailedExit", "accountCheckTitle",
    "accountCheckCopy", "accountCheckProxyLabel", "accountCheckProxyDirect",
    "accountCheckProxyHint", "accountCheckTargetLabel", "accountCheckEtaLabel",
    "accountCheckEtaValue", "accountCheckExitLabel", "accountCheckTimeLabel",
    "accountCheckGradeLabel", "accountCheckIdentityLabel", "accountCheckNote",
    "accountCheckStart", "accountCheckRunningOpening",
    "accountCheckRunningReading", "accountCheckElapsed", "accountCheckCancel",
    "accountCheckCancelled", "accountCheckSummary", "accountCheckNoExposure",
    "accountCheckResultNote", "accountCheckAgain", "accountCheckReexit",
    "accountCheckDetails", "accountCheckFailedTitle",
    "accountCheckFailedDetail", "accountCheckFailedNoVerdict",
    "accountCheckFailedKeepPrevious", "accountCheckFailedNoPrevious",
    "accountCheckRetry", "accountCheckChangeExit", "accountCheckDismiss",
    "checkErrorBrowserMissing", "checkErrorExecutableMissing",
    "checkErrorIdentityMissing", "checkErrorLaunchFailed",
    "checkErrorLaunchTimeout", "checkErrorPageTimeout",
    "checkErrorVerdictMissing", "checkErrorCancelled",
    "checkErrorProxyNotFound", "checkErrorAccountNotFound",
    "checkErrorCheckBusy", "checkErrorInternal", "checkErrorUnknown",
    "errorInvalidNote", "toastNoteSaved", "toastCheckDone",
    "toastCheckCancelled", "toastRefreshed",
  ];
  for (const key of keys) {
    const count = (app.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  }
  // The four tables carry exactly the same key set: no language is missing a
  // new string and no stray key was added to only one table.
  const tables = [...app.matchAll(/^  (?:en|"zh-Hans"|"zh-Hant"|ja): \{([\s\S]*?)^  \},$/gm)]
    .map((match) => new Set([...match[1].matchAll(/^    ([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])));
  expect(tables.length).toBe(4);
  for (const table of tables) expect(table).toEqual(tables[0]);
  expect(tables[0].size).toBeGreaterThan(280);
});
