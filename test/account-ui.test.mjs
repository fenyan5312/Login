// The pure helpers behind the account identity list and the "continue with an
// existing identity" picker. Read-file style like the other UI tests: the
// helpers are imported, the wiring is checked against app.js/index.html.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountCheckCancelPath,
  accountCheckPath,
  accountIdentityPath,
  accountIdentityView,
  accountLabel,
  defaultAccountKey,
  retiredAccounts,
  signInAccount,
} from "../ui/account-state.js";
import { signInPayload } from "../ui/signin-state.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

const accounts = [
  { provider: "workbuddy", key: "workbuddy", accountId: "signed-in", uid: "u-1", signedIn: true },
  { provider: "workbuddy", key: "workbuddy#a", accountId: "retired-a", uid: "u-2", signedInAt: "2026-11-02T09:00:00.000Z", signedIn: false },
  { provider: "workbuddy", key: "workbuddy#b", accountId: "", uid: "u-3", signedInAt: "2026-11-01T09:00:00.000Z", signedIn: false },
  { provider: "other", key: "other", accountId: "elsewhere", uid: "u-4", signedIn: false },
];

test("accountLabel prefers the account name, then the uid, then the key", () => {
  expect(accountLabel({ accountId: "me", uid: "u", key: "k" })).toBe("me");
  expect(accountLabel({ accountId: "  ", uid: "u", key: "k" })).toBe("u");
  expect(accountLabel({ accountId: "", uid: "", key: "k" })).toBe("k");
  expect(accountLabel({})).toBe("");
  expect(accountLabel(null)).toBe("");
});

test("retiredAccounts keeps only the provider's signed-out identities", () => {
  expect(retiredAccounts(accounts, "workbuddy").map((account) => account.key)).toEqual([
    "workbuddy#a",
    "workbuddy#b",
  ]);
  // The signed-in one and other providers are not offered.
  expect(retiredAccounts(accounts, "workbuddy").some((account) => account.signedIn === true)).toBe(false);
  expect(retiredAccounts(accounts, "nobody")).toEqual([]);
  expect(retiredAccounts(null, "workbuddy")).toEqual([]);
});

test("defaultAccountKey preselects only when there is exactly one identity", () => {
  const single = [{ provider: "p", key: "p#only", signedIn: false }];
  expect(defaultAccountKey(single, "p")).toBe("p#only");
  expect(defaultAccountKey(accounts, "workbuddy")).toBe("");
  expect(defaultAccountKey(accounts, "other")).toBe("other");
  expect(defaultAccountKey([], "p")).toBe("");
});

test("signInAccount carries only the key, and nothing when blank", () => {
  expect(signInAccount("workbuddy#a")).toEqual({ key: "workbuddy#a" });
  expect(signInAccount("  workbuddy#a  ")).toEqual({ key: "workbuddy#a" });
  expect(signInAccount("")).toBeNull();
  expect(signInAccount("   ")).toBeNull();
  expect(signInAccount(null)).toBeNull();
  expect(signInAccount({ key: "x" })).toBeNull();
});

test("signInPayload adds the account only when one was chosen", () => {
  expect(signInPayload("workbuddy", null)).toEqual({ provider: "workbuddy", proxy: null });
  expect(signInPayload("workbuddy", null, null, "")).toEqual({
    provider: "workbuddy",
    proxy: null,
  });
  expect(signInPayload("workbuddy", null, null, "workbuddy#a")).toEqual({
    provider: "workbuddy",
    proxy: null,
    account: { key: "workbuddy#a" },
  });
  // The account rides beside the method label, not instead of it.
  expect(signInPayload("workbuddy", null, "Browser", "workbuddy#a")).toEqual({
    provider: "workbuddy",
    proxy: null,
    methodLabel: "Browser",
    account: { key: "workbuddy#a" },
  });
});

test("accountIdentityPath URL-encodes both segments", () => {
  expect(accountIdentityPath("workbuddy", "workbuddy#ab12")).toBe(
    "api/accounts/workbuddy/workbuddy%23ab12",
  );
  expect(accountIdentityPath("a/b", "c d")).toBe("api/accounts/a%2Fb/c%20d");
});

test("accountIdentityView exposes no fingerprint and no path", () => {
  const view = accountIdentityView(accounts[1]);
  expect(view).toEqual({
    label: "retired-a",
    uid: "u-2",
    retiredAt: "2026-11-02T09:00:00.000Z",
    provider: "workbuddy",
    key: "workbuddy#a",
    signedIn: false,
    note: "",
    lastLogin: null,
    lastCheck: null,
  });
  // Still never a fingerprint, a path, or a credential.
  expect(Object.keys(view).some((key) => /fingerprint|path|password|host|port/i.test(key))).toBe(false);
  expect(accountIdentityView({}).label).toBe("");
});

test("the check endpoints URL-encode both segments", () => {
  expect(accountCheckPath("workbuddy", "workbuddy#ab12")).toBe(
    "api/accounts/workbuddy/workbuddy%23ab12/check",
  );
  expect(accountCheckCancelPath("a/b", "c d")).toBe(
    "api/accounts/a%2Fb/c%20d/check/cancel",
  );
});

test("the sign-in dialog offers the identity picker and posts the chosen key", () => {
  const dialog = /<dialog id="signin-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0] || "";
  expect(dialog).toContain('id="signin-account"');
  expect(dialog).toContain('id="signin-account-field"');
  expect(dialog).toContain('id="signin-account-hint"');
  expect(app).toContain("retiredAccounts(accountIdentities, provider)");
  expect(app).toContain("defaultAccountKey(accountIdentities, provider)");
  expect(app).toContain("selectedSignInAccount()");
});

test("the identity card lists each identity and wires its clear entry", () => {
  expect(html).toContain('id="account-identities"');
  expect(html).toContain('id="account-identities-list"');
  expect(html).toContain('id="identities-retry"');
  expect(app).toContain("function renderIdentities()");
  expect(app).toContain("function identityRow(account)");
  expect(app).toContain("function askClearIdentity(account)");
  expect(app).toContain('api("api/accounts")');
  expect(app).toContain("accountIdentityPath(account.provider, account.key)");
  expect(app).toContain('method: "DELETE"');
  // The clear button is a real two-step action and then the list reloads.
  expect(app).toContain("loadAccountIdentities()");
  expect(app).toContain("clear.disabled = clearing || Boolean(clearingIdentityKey)");
  // Every new string exists in all four language tables.
  for (const key of [
    "identitiesTitle",
    "identitiesCopy",
    "identitiesEmpty",
    "identitiesLoading",
    "identitiesError",
    "identitiesRetry",
    "identitiesClear",
    "identitiesClearing",
    "identitiesCleared",
    "identitiesClearTitle",
    "identitiesClearCopy",
    "identitiesClearConfirm",
    "signInAccountLabel",
    "signInAccountHint",
    "signInAccountNew",
    // accounts page v2 copy, also counted in all four tables
    "accountsTitle",
    "accountSearchLabel",
    "accountFilterAll",
    "gradeDisclaimer",
    "accountDetailNoteSave",
    "accountCheckFailedNoVerdict",
    "checkErrorInternal",
    "toastNoteSaved",
  ]) {
    const count = (app.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  }
});

test("the accounts tab and its dialogs are wired to real requests", () => {
  expect(html).toContain('id="tab-accounts"');
  expect(html).toContain('id="panel-accounts"');
  expect(html).toContain('id="account-detail-dialog"');
  expect(html).toContain('id="account-check-dialog"');
  expect(app).toContain('byId("tab-accounts").addEventListener');
  expect(app).toContain('byId("account-check-start").addEventListener');
  expect(app).toContain("openSignInDialog(provider, { accountKey: view.key })");
  expect(app).toContain("accountCheckPath(context.provider, context.key)");
  expect(app).toContain('method: "PATCH"');
});
