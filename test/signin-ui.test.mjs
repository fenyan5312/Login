// The add-account dialog: its static wiring (no sandbox-hostile controls) and
// the pure request-shape helpers. Read-file style, like providers-ui.test.mjs.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  signInActive,
  signInMethodLabel,
  signInPayload,
  signInProxy,
  signInSettled,
} from "../ui/signin-state.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

test("the sign-in dialog posts the card's signInProvider to /api/signin", () => {
  expect(app).toContain("provider: provider.signInProvider");
  expect(app).toContain("signInPayload(");
  expect(app).toContain("selectedSignInProxy()");
  expect(app).toContain("selectedSignInMethod()");
  expect(app).toContain("selectedSignInAccount()");
  expect(app).toContain('api("api/signin", {');
  expect(app).toContain('api("api/signin/cancel", { method: "POST" })');
  // The status poll is a GET of the same route.
  expect(app).toContain('const data = await api("api/signin");');
  // The proxy list is re-read from GET /api/proxies when the dialog opens.
  expect(app).toContain('await api("api/proxies")');
});

test("the dialog is sandbox-safe: type=button controls and no form submission", () => {
  const dialog = /<dialog id="signin-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0] || "";
  expect(dialog).toContain('id="signin-proxy"');
  expect(dialog).toContain('id="signin-start"');
  expect(dialog).toContain('id="signin-cancel"');
  expect(dialog).toContain('id="signin-dialog"');
  // Every control is an explicit type=button; a submit control is silently
  // dead in magpie's allow-scripts-only frame.
  const buttons = dialog.match(/<button[^>]*>/g) || [];
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) expect(button).toContain('type="button"');
  expect(dialog).not.toContain('type="submit"');
});

// The method picker for a plugin with several runnable oauth methods (ZCode's
// per-site flows). It is a plain select, so it needs no submit, and the whole
// dialog stays free of alert/confirm/window.open/localStorage.
test("the dialog offers a method picker for a plugin with several sign-in methods", () => {
  const dialog = /<dialog id="signin-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0] || "";
  expect(dialog).toContain('id="signin-method"');
  expect(dialog).toContain('id="signin-method-field"');
  expect(dialog).toContain('id="signin-method-hint"');
  // A select needs no form submission, so it is sandbox-safe as it is.
  expect(dialog).not.toContain('type="submit"');
  // The forbidden browser APIs never appear in the sign-in code.
  const signInCode = /function renderSignInMethods[\s\S]*?function openSignInDialog/.exec(app)?.[0] || "";
  expect(signInCode).not.toMatch(/alert\(|confirm\(|window\.open|localStorage/);
  // The picker is filled from the card's signInMethods and its choice is sent.
  expect(app).toContain("provider?.signInMethods");
  expect(app).toContain("selectedSignInMethod()");
  expect(app).toContain("signInMethodHint");
});

test("signInPayload carries the chosen method label, and omits it when there is none", () => {
  expect(
    signInPayload("zcode", null, "ZCode: BigModel (智谱) GLM Coding Plan"),
  ).toEqual({
    provider: "zcode",
    proxy: null,
    methodLabel: "ZCode: BigModel (智谱) GLM Coding Plan",
  });
  // No choice made: the field is absent, so the service picks as before.
  expect(signInPayload("zcode", null)).toEqual({ provider: "zcode", proxy: null });
  expect(signInPayload("zcode", null, "")).toEqual({ provider: "zcode", proxy: null });
  expect(signInPayload("zcode", null, "   ")).toEqual({ provider: "zcode", proxy: null });
  expect(signInMethodLabel("  ZCode  ")).toBe("ZCode");
  expect(signInMethodLabel("")).toBeNull();
  expect(signInMethodLabel(null)).toBeNull();
  expect(signInMethodLabel(42)).toBeNull();
});

test("the dialog shows the required opened message and stops polling on close", () => {
  expect(app).toContain("text.signInOpened");
  expect(app).toContain("已在隔离浏览器窗口打开登录页，请在那个窗口里完成登录");
  // Closing the dialog cancels a still-running flow and always stops polling.
  expect(app).toContain("function stopSignInPolling()");
  expect(app).toContain("function cleanupSignInDialog()");
  expect(app).toContain("signInActive(signInContext.flow?.state)");
  const cleanup = /function cleanupSignInDialog\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] || "";
  expect(cleanup).toContain("stopSignInPolling()");
});

test("a sign-in error shows the server's own code and message", () => {
  expect(app).toContain("error?.serverMessage");
  expect(app).toContain("serverErrorText(flow?.error)");
  // Never collapsed into a generic \"unknown error\" for a server reply.
  expect(app).not.toContain("signInUnknownError");
});

test("a waiting-login navigation warning keeps the state label and shows a localised hint", () => {
  const rendered = /function renderSignIn\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] || "";
  expect(rendered).toContain("statusState.textContent = signInStateLabel(state)");
  expect(rendered).toContain('state === "waiting-login"');
  expect(rendered).toContain('navigationWarningText(flow?.warning, "signInNavigationWarning")');
  expect(rendered).toContain("statusDetail.hidden = !warning");
  expect(app).toContain("const NAVIGATION_WARNING_CODE = \"navigation_failed\";");
  expect(app).toContain("return warning?.code === NAVIGATION_WARNING_CODE ? text[key] : \"\";");
  expect((app.match(/\bsignInNavigationWarning:/g) || []).length).toBeGreaterThanOrEqual(4);
});

test("signInProxy keeps only public fields and never a password", () => {
  const payload = signInPayload("workbuddy", {
    id: "p1",
    name: "SG · 01",
    type: "http",
    host: "1.2.3.4",
    port: 8080,
    username: "user",
    password: "s3cret",
    hasPassword: true,
  });
  expect(payload).toEqual({
    provider: "workbuddy",
    proxy: { id: "p1", type: "http", host: "1.2.3.4", port: 8080, username: "user" },
  });
  expect(payload.proxy).not.toHaveProperty("password");
  expect(JSON.stringify(payload)).not.toContain("s3cret");
});

test("signInProxy sends null for the no-proxy selection", () => {
  expect(signInPayload("workbuddy", null)).toEqual({ provider: "workbuddy", proxy: null });
  expect(signInPayload("workbuddy", {})).toEqual({ provider: "workbuddy", proxy: null });
  expect(signInPayload("workbuddy", { id: "" })).toEqual({ provider: "workbuddy", proxy: null });
  expect(signInProxy(undefined)).toBeNull();
});

test("signInActive and signInSettled partition the state machine", () => {
  for (const state of ["authorizing", "waiting-login", "finishing"]) {
    expect(signInActive(state)).toBe(true);
    expect(signInSettled(state)).toBe(false);
  }
  for (const state of ["done", "error", "cancelled"]) {
    expect(signInActive(state)).toBe(false);
    expect(signInSettled(state)).toBe(true);
  }
  for (const state of ["idle", "", undefined]) {
    expect(signInActive(state)).toBe(false);
    expect(signInSettled(state)).toBe(false);
  }
});
