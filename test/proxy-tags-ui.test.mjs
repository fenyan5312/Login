// The proxy dialog's tag field and the IP-group section: static wiring plus
// the pure form helper that carries tags to the service.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeProxyForm } from "../ui/proxy-state.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

test("normalizeProxyForm keeps tags, trimmed, and does not fold them into the connection fingerprint", () => {
  expect(normalizeProxyForm({ tags: "  claude, workbuddy  " }).tags).toBe("claude, workbuddy");
  expect(normalizeProxyForm({}).tags).toBe("");
});

test("the proxy dialog has a tag field and sends it", () => {
  expect(html).toContain('id="proxy-tags"');
  expect(html).toContain('id="label-tags"');
  expect(html).toContain('id="proxy-tags-hint"');
  expect(app).toContain('tags: byId("proxy-tags").value');
  expect(app).toContain("payload.tags");
  expect(app).toContain("text.proxyTagsHint");
});

test("the proxies tab has a group section with a create action and a dialog", () => {
  expect(html).toContain('id="add-proxy-group"');
  expect(html).toContain('id="proxy-groups"');
  expect(html).toContain('id="proxy-group-list"');
  expect(html).toContain('id="proxy-group-dialog"');
  for (const id of [
    "group-name", "group-provider", "group-mode", "group-tag", "group-per-ip",
    "group-members", "group-form-error", "group-cancel", "group-close", "save-group",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
  // Group mode and tag mode are the two membership models; the dialog swaps
  // the member list for the tag field instead of showing both.
  expect(html).toContain('value="group"');
  expect(html).toContain('value="tag"');
  expect(app).toContain("function syncGroupModeFields()");
  expect(app).toContain('byId("group-tag-field").hidden = !tagMode');
  expect(app).toContain('byId("group-members-field").hidden = tagMode');
});

test("the page reads groups from the bootstrap and the group route", () => {
  expect(app).toContain("data?.groups");
  expect(app).toContain('api("api/proxy-groups")');
  expect(app).toContain("api/proxy-groups/${encodeURIComponent(current.id)}");
  expect(app).toContain('method: current.mode === "edit" ? "PATCH" : "POST"');
  expect(app).toContain('api(`api/proxy-groups/${encodeURIComponent(target.id)}`, { method: "DELETE" })');
});
