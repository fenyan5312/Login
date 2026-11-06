// Read-file checks for the IP-group tree, the tag registry and the import
// dialog's exit pickers. No DOM is started: the page is served to magpie's
// launcher frame, and these tests pin the markup, the wiring and the four
// language tables without a browser.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");
const app = readFileSync(join(root, "ui", "app.js"), "utf8").replaceAll("\r\n", "\n");
const css = readFileSync(join(root, "ui", "style.css"), "utf8");
const importJs = readFileSync(join(root, "ui", "import.js"), "utf8").replaceAll("\r\n", "\n");

test("the proxies tab ships the tag registry panel and its dialog", () => {
  for (const id of [
    "tag-panel", "tag-panel-title", "tag-panel-copy", "add-tag", "add-tag-label",
    "tag-empty", "tag-list",
    "tag-dialog", "tag-dialog-title", "tag-dialog-copy", "tag-name-field",
    "tag-name", "tag-parent", "label-tag-name", "label-tag-parent",
    "tag-parent-hint", "tag-error", "tag-cancel", "tag-close", "save-tag",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
});

test("the group dialog gained a parent picker and a tag select", () => {
  for (const id of [
    "group-parent", "label-group-parent", "group-parent-hint",
    "group-tag", "label-group-tag", "group-tag-hint",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
  // The free-text tag input became a select fed by the registry, but the id is
  // unchanged so the existing group logic keeps working.
  const tagField = /<div class="field" id="group-tag-field"[\s\S]*?<\/div>/.exec(html)?.[0] || "";
  expect(tagField).toContain('<select id="group-tag">');
  expect(tagField).not.toContain('<input id="group-tag"');
});

test("the import dialog ships group and proxy pickers", () => {
  for (const id of [
    "import-group-field", "import-group", "import-group-label", "import-group-hint",
    "import-proxy-field", "import-proxy", "import-proxy-label", "import-proxy-hint",
  ]) {
    expect(html).toContain(`id="${id}"`);
  }
});

test("groups and tags render as indented trees", () => {
  // The service returns both lists depth-first; the view keeps that order and
  // marks each node with its depth instead of re-sorting.
  expect(app).toContain("card.dataset.depth = String(depth)");
  expect(app).toContain("row.dataset.depth = String(depth)");
  expect(app).toContain("depth-${Math.min(Math.max(depth, 1), 3)}");
  expect(app).toContain('return "— ".repeat(level - 1);');
  expect(app).toContain("renderTagList()");
  expect(app).toContain('api("api/tags")');
  // A parent group's picker offers its whole subtree, members included.
  expect(app).toContain("group.members");
  expect(app).toContain("${treeIndent(group.depth)}${group.name}");
  expect(app).toContain("${treeIndent(tag.depth)}${tag.name}");
  // Children cannot be detached from their parent by picking themselves.
  expect(app).toContain("groupSubtreeIds(");
  expect(app).toContain("tagSubtreeNames(");
  // The tree depth is capped at three levels in the parent picker.
  expect(app).toContain("if (depth + movedHeight > 3) continue;");
  for (const depth of ["depth-1", "depth-2", "depth-3"]) {
    expect(css).toContain(`.proxy-group-card.${depth}`);
    expect(css).toContain(`.tag-row.${depth}`);
  }
  expect(css).toContain(".tag-row-meta");
  expect(css).toContain(".group-depth-badge");
});

test("the tag dialog creates with POST and moves with PATCH", () => {
  expect(app).toContain('api("api/tags", { method: "POST"');
  expect(app).toContain("api(`api/tags/${encodeURIComponent(current.name)}`, { method: \"PATCH\"");
  expect(app).toContain("api(`api/tags/${encodeURIComponent(target.id)}`, { method: \"DELETE\"");
  expect(app).toContain("tag_in_use");
  expect(app).toContain("group_has_children");
  // The group payload carries the chosen parent, null at the top level.
  expect(app).toContain('parentId: byId("group-parent").value || null');
  // Every tag button is wired.
  for (const id of ["add-tag", "tag-cancel", "tag-close", "save-tag"]) {
    expect(app).toContain(`byId("${id}").addEventListener`);
  }
  expect(app).toContain('byId("tag-dialog").addEventListener("close", cleanupTagDialog)');
});

test("the import dialog reads the tree and sends groupId plus proxy", () => {
  expect(importJs).toContain('fetch("api/bootstrap"');
  expect(importJs).toContain('"x-clean-login-token"');
  expect(importJs).toContain("group.provider && group.provider !== activeProvider");
  expect(importJs).toContain("payload.groupId = group.id");
  expect(importJs).toContain("payload.proxy = proxy");
  expect(importJs).toContain("function selectedImportProxy()");
  // The public proxy shape only: no password, no stored record.
  expect(importJs).toContain("username: proxy.username || \"\"");
  expect(importJs).not.toContain("password:");
  // Group selection narrows the proxy list to the subtree members.
  expect(importJs).toContain("memberIds(group)");
  expect(importJs).toContain('groupSelect?.addEventListener("change", fillImportProxies)');
  // The success line reports the exit, the group and the fingerprint outcome.
  expect(importJs).toContain("fingerprintCreated");
  expect(importJs).toContain("fingerprintPending");
  expect(importJs).toContain("exitLabel");
  expect(importJs).toContain("groupUsedLabel");
});

test("every new string exists in all four language tables", () => {
  const appKeys = [
    "tagPanelTitle", "tagPanelCopy", "addTag", "tagEmpty", "tagTitleNew",
    "tagTitleMove", "tagDialogCopy", "tagDialogMoveCopy", "tagNameLabel",
    "tagNamePlaceholder", "tagParentLabel", "tagParentTop", "tagParentHint",
    "tagNameRequired", "tagSave", "tagMove", "tagDeleteTitle", "tagDeleteCopy",
    "tagChildCount", "tagProxyCount", "tagGroupCount", "errorTagInUse",
    "errorTagInvalid", "errorTagNotFound", "errorGroupHasChildren",
    "groupParentLabel", "groupParentTop", "groupParentHint", "groupTagNone",
    "groupTagEmptyHint",
  ];
  for (const key of appKeys) {
    const count = (app.match(new RegExp(`${key}:`, "g")) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  }
  const importKeys = [
    "groupLabel", "groupCap", "groupHint", "groupAuto", "proxyLabel",
    "proxyHint", "proxyAuto", "proxyDirect", "exitLabel", "groupUsedLabel",
    "fingerprintCreated", "fingerprintPending",
  ];
  for (const key of importKeys) {
    const count = (importJs.match(new RegExp(`${key}:`, "g")) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  }
  // The four app tables still carry exactly the same key set.
  const tables = [...app.matchAll(/^  (?:en|"zh-Hans"|"zh-Hant"|ja): \{([\s\S]*?)^  \},$/gm)]
    .map((match) => new Set([...match[1].matchAll(/^    ([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])));
  expect(tables.length).toBe(4);
  for (const table of tables) expect(table).toEqual(tables[0]);
});

test("every new control is a type=button and the dialog stays sandbox-safe", () => {
  for (const id of ["add-tag", "tag-close", "tag-cancel", "save-tag"]) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] || "";
    expect(tag).toContain('type="button"');
  }
  const tagDialog = /<dialog id="tag-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0] || "";
  expect(tagDialog).not.toContain('type="submit"');
  expect(tagDialog).not.toContain("<form");
  expect(importJs).not.toMatch(/alert\(|confirm\(|window\.open|localStorage/);
  expect(app).not.toMatch(/alert\(|window\.open|localStorage/);
});

test("moving a subtree respects the three-level cap and a child follows its parent's provider", () => {
  // Group picker excludes any parent whose depth + the moved subtree's height
  // would exceed three levels.
  expect(app).toContain("function groupSubtreeHeight(group)");
  expect(app).toContain("if (depth + movedHeight > 3) continue;");
  // Tag picker does the same for tag subtrees.
  expect(app).toContain("function tagSubtreeHeight(name)");
  expect(app).toContain("if ((Number.isFinite(item.depth) ? item.depth : 1) + movedHeight > 3) continue;");
  // A provider-specific parent forces the child's provider, or the service
  // would reject the save with provider_mismatch.
  expect(app).toContain('byId("group-parent").addEventListener("change"');
  expect(app).toContain("if (!parent?.provider) return;");
  expect(app).toContain('byId("group-provider").value = parent.provider;');
});

test("the new tree error codes are localized in the page and the import dialog", () => {
  for (const key of ["errorInvalidParent", "errorProviderMismatch", "errorGroupFull", "errorGroupProxyMismatch", "errorTagExists"]) {
    expect((app.match(new RegExp(`${key}:`, "g")) || []).length).toBeGreaterThanOrEqual(4);
  }
  expect(app).toContain('invalid_parent: "errorInvalidParent"');
  expect(app).toContain('provider_mismatch: "errorProviderMismatch"');
  expect(app).toContain('group_full: "errorGroupFull"');
  expect(app).toContain('tag_exists: "errorTagExists"');
  // The import dialog maps service codes instead of showing the raw English
  // message, which is exactly what a full group or an out-of-group IP returns.
  expect(importJs).toContain("function importErrorText(error)");
  expect(importJs).toContain("group_full: text.groupFull");
  expect(importJs).toContain("group_proxy_mismatch: text.groupProxyMismatch");
  expect(importJs).toContain("showError(importErrorText(error));");
});

test("a provider-specific group can target an import-only provider", () => {
  // Import-only cards have no `signInProvider`; the group dialog must still
  // offer their registry id, or Claude/Codex could never own a group.
  expect(app).toContain("typeof provider?.signInProvider === \"string\" && provider.signInProvider");
  expect(app).toContain(": typeof provider?.id === \"string\"");
  expect(app).toContain("? provider.id");
});
