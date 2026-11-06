// Three-level IP-group and tag trees: the pure helpers, the store's tree
// validation, subtree membership/capacity and the v3 file format. No browser
// and no network.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateGroupProxy,
  createProxyStore,
  groupChildren,
  groupDepth,
  groupDescendantIds,
  groupMembers,
  groupUsage,
  orderGroups,
  orderTags,
  tagDepth,
  tagDescendants,
  tagSummaries,
  validateGroupCreate,
  validateTagCreate,
  validateTagUpdate,
} from "../lib/proxies.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-proxy-tree-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const proxy = (id, over = {}) => ({
  id,
  name: over.name ?? id,
  tags: over.tags ?? [],
  region: over.region ?? "",
  exitIp: over.exitIp ?? "",
  status: over.status ?? "untested",
  ...over,
});

const account = (provider, proxyId) => ({
  provider,
  meta: { provider, lastLogin: proxyId ? { proxyId } : null },
});

const group = (id, parentId = null, over = {}) => ({
  id,
  name: over.name ?? id,
  provider: over.provider ?? "",
  mode: over.mode ?? "group",
  tag: over.tag ?? "",
  proxyIds: over.proxyIds ?? [],
  perIp: over.perIp ?? 2,
  parentId,
});

test("groups nest three levels and the helpers walk the subtree", () => {
  const groups = [
    group("root"),
    group("sibling"),
    group("child", "root"),
    group("grandchild", "child"),
  ];
  expect(groupDepth(groups, "root")).toBe(1);
  expect(groupDepth(groups, "child")).toBe(2);
  expect(groupDepth(groups, "grandchild")).toBe(3);
  expect(groupDepth(groups, "missing")).toBeNull();
  expect(groupChildren(groups, "root").map((item) => item.id)).toEqual(["child"]);
  expect(groupDescendantIds(groups, "root")).toEqual(["root", "child", "grandchild"]);
  expect(groupDescendantIds(groups, "missing")).toEqual([]);
  expect(orderGroups(groups).map((item) => item.id)).toEqual([
    "root",
    "child",
    "grandchild",
    "sibling",
  ]);
});

test("tags nest three levels and the helpers walk the subtree", () => {
  const tags = [
    { name: "claude", parent: null },
    { name: "claude-pro", parent: "claude" },
    { name: "claude-pro-max", parent: "claude-pro" },
    { name: "other", parent: null },
  ];
  expect(tagDepth(tags, "claude")).toBe(1);
  expect(tagDepth(tags, "claude-pro-max")).toBe(3);
  expect(tagDepth(tags, "nope")).toBeNull();
  expect(tagDescendants(tags, "claude")).toEqual(["claude", "claude-pro", "claude-pro-max"]);
  expect(tagDescendants(tags, "nope")).toEqual([]);
  expect(orderTags(tags).map((tag) => tag.name)).toEqual([
    "claude",
    "claude-pro",
    "claude-pro-max",
    "other",
  ]);

  const proxies = [
    proxy("p1", { tags: ["claude"] }),
    proxy("p2", { tags: ["claude-pro"] }),
    proxy("p3", { tags: ["claude-pro-max", "other"] }),
    proxy("p4", { tags: ["other"] }),
  ];
  expect(
    groupMembers({ mode: "tag", tag: "claude" }, proxies, [], tags).map((item) => item.id),
  ).toEqual(["p1", "p2", "p3"]);

  const summaries = tagSummaries(tags, proxies, [
    { mode: "tag", tag: "claude" },
    { mode: "group", tag: "" },
  ]);
  expect(summaries.find((tag) => tag.name === "claude")).toEqual({
    name: "claude",
    parent: null,
    depth: 1,
    childCount: 1,
    proxyCount: 1,
    groupCount: 1,
  });
  expect(summaries.find((tag) => tag.name === "claude-pro-max")).toMatchObject({
    parent: "claude-pro",
    depth: 3,
    childCount: 0,
    proxyCount: 1,
  });
});

test("a parent group owns every member of its subtree", () => {
  const groups = [
    group("root", null, { proxyIds: ["p1"] }),
    group("child", "root", { proxyIds: ["p2"] }),
    group("grandchild", "child", { proxyIds: ["p3"] }),
  ];
  const proxies = [proxy("p3"), proxy("p1"), proxy("p2"), proxy("outside")];
  // Proxy-list order, deduplicated.
  expect(groupMembers(groups[0], proxies, groups).map((item) => item.id)).toEqual([
    "p3",
    "p1",
    "p2",
  ]);
  expect(groupMembers(groups[2], proxies, groups).map((item) => item.id)).toEqual(["p3"]);
  // A tag-mode child contributes its tag to the parent's tag-mode selection
  // only through the tag tree; here the group-mode parent ignores its tag.
  expect(groupMembers(groups[0], proxies, groups, []).map((item) => item.id)).toEqual([
    "p3",
    "p1",
    "p2",
  ]);
});

test("usage and allocation span the subtree capacity", () => {
  const groups = [
    group("root", null, { proxyIds: ["p1"], perIp: 1, provider: "claude" }),
    group("child", "root", { proxyIds: ["p2"], perIp: 1, provider: "claude" }),
  ];
  const proxies = [proxy("p1", { name: "a" }), proxy("p2", { name: "b" })];
  const accounts = [account("claude", "p1"), account("claude", "p2")];
  const usage = groupUsage(groups[0], proxies, accounts, groups);
  expect(usage.used).toBe(2);
  expect(usage.capacity).toBe(2);
  expect(allocateGroupProxy({ group: groups[0], proxies, accounts, groups })).toBeNull();

  // One free slot on p2: allocation lands there and is refused again once the
  // subtree is at its cap.
  const partial = [account("claude", "p1")];
  expect(
    allocateGroupProxy({ group: groups[0], proxies, accounts: partial, groups })?.id,
  ).toBe("p2");
  expect(
    allocateGroupProxy({
      group: groups[0],
      proxies,
      accounts: [account("claude", "p1"), account("claude", "p2")],
      groups,
    }),
  ).toBeNull();
});

test("the store refuses a fourth level, cycles and provider mismatches", async () => {
  const dir = await tempDir();
  const store = createProxyStore({ dataDir: dir });
  const root = await store.createGroup(
    validateGroupCreate({ name: "root", provider: "claude", mode: "group" }),
  );
  expect(root.parentId).toBeNull();
  const child = await store.createGroup({
    ...validateGroupCreate({ name: "child", provider: "claude", mode: "group" }),
    parentId: root.id,
  });
  expect(child.parentId).toBe(root.id);
  const grandchild = await store.createGroup({
    ...validateGroupCreate({ name: "grandchild", provider: "claude", mode: "group" }),
    parentId: child.id,
  });
  expect(grandchild.parentId).toBe(child.id);

  await expect(
    store.createGroup({
      ...validateGroupCreate({ name: "fourth", provider: "claude", mode: "group" }),
      parentId: grandchild.id,
    }),
  ).rejects.toThrow("3 levels");

  // Moving the root under its own grandchild would form a loop.
  await expect(store.updateGroup(root.id, { parentId: grandchild.id })).rejects.toThrow(
    "nested inside",
  );
  await expect(store.updateGroup(child.id, { parentId: child.id })).rejects.toThrow(
    "nested inside",
  );
  await expect(store.updateGroup(child.id, { parentId: "missing" })).rejects.toThrow(
    "does not exist",
  );

  // A scoped parent only accepts children with the same provider.
  await expect(
    store.createGroup({
      ...validateGroupCreate({ name: "wrong provider", provider: "workbuddy", mode: "group" }),
      parentId: root.id,
    }),
  ).rejects.toThrow("provider");
  await expect(
    store.createGroup({
      ...validateGroupCreate({ name: "no provider", mode: "group" }),
      parentId: root.id,
    }),
  ).rejects.toThrow("provider");

  // Without a provider on the parent, any child provider is allowed.
  const open = await store.createGroup(
    validateGroupCreate({ name: "open", mode: "group" }),
  );
  const scopedChild = await store.createGroup({
    ...validateGroupCreate({ name: "scoped child", provider: "workbuddy", mode: "group" }),
    parentId: open.id,
  });
  expect(scopedChild.provider).toBe("workbuddy");

  // Deleting a parent is refused while children remain.
  await expect(store.removeGroup(root.id)).rejects.toThrow("child groups");
  const reloaded = createProxyStore({ dataDir: dir });
  expect((await reloaded.listGroups()).find((item) => item.id === grandchild.id).parentId).toBe(
    child.id,
  );
});

test("tags are created, re-parented and protected from destructive deletes", async () => {
  const dir = await tempDir();
  const store = createProxyStore({ dataDir: dir });
  const root = await store.createTag(validateTagCreate({ name: " claude " }));
  expect(root).toEqual({ name: "claude", parent: null });
  const child = await store.createTag(validateTagCreate({ name: "claude-pro", parent: "claude" }));
  expect(child.parent).toBe("claude");
  const grandchild = await store.createTag(
    validateTagCreate({ name: "claude-pro-max", parent: "claude-pro" }),
  );
  expect(grandchild.parent).toBe("claude-pro");

  await expect(store.createTag(validateTagCreate({ name: "claude" }))).rejects.toThrow(
    "already exists",
  );
  await expect(
    store.createTag(validateTagCreate({ name: "fourth", parent: "claude-pro-max" })),
  ).rejects.toThrow("3 levels");
  await expect(
    store.createTag(validateTagCreate({ name: "orphan", parent: "never-created" })),
  ).rejects.toThrow("does not exist");
  await expect(store.updateTag("claude", { parent: "claude-pro-max" })).rejects.toThrow(
    "nested inside",
  );

  // A tag with children cannot be deleted, and neither can one a proxy or a
  // tag-mode group still names.
  await expect(store.removeTag("claude")).rejects.toThrow("child tags");
  const withTags = await store.create({
    name: "tagged",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    tags: "claude-pro-max",
  });
  expect((await store.listTags()).map((tag) => tag.name)).toContain("claude-pro-max");
  await expect(store.removeTag("claude-pro-max")).rejects.toThrow("carried by a proxy");
  await store.update(withTags.id, { tags: [] });
  const tagGroup = await store.createGroup(
    validateGroupCreate({ name: "tag rule", mode: "tag", tag: "claude-pro-max" }),
  );
  await expect(store.removeTag("claude-pro-max")).rejects.toThrow("proxy group");
  await store.removeGroup(tagGroup.id);
  expect(await store.removeTag("claude-pro-max")).toEqual({
    name: "claude-pro-max",
    parent: "claude-pro",
  });

  // Emptying a tag's parent lifts it to the root.
  expect(await store.updateTag("claude-pro", { parent: null })).toEqual({
    name: "claude-pro",
    parent: null,
  });
});

test("tag validators trim, bound and require the documented shape", () => {
  expect(validateTagCreate({ name: "  pro  " })).toEqual({ name: "pro", parent: null });
  expect(validateTagCreate({ name: "pro", parent: " ai " })).toEqual({
    name: "pro",
    parent: "ai",
  });
  expect(() => validateTagCreate({ name: "" })).toThrow("required");
  expect(() => validateTagCreate({ name: "x".repeat(33) })).toThrow("too long");
  expect(() => validateTagCreate({ name: "bad\nname" })).toThrow("control");
  expect(() => validateTagCreate({ name: "x", parent: 4 })).toThrow("text");
  expect(validateTagUpdate({ parent: "" })).toEqual({ parent: null });
  expect(() => validateTagUpdate({})).toThrow("No tag fields");
});

test("an unknown proxy tag is registered at the root and the file is v3", async () => {
  const dir = await tempDir();
  const store = createProxyStore({ dataDir: dir });
  await store.create({
    name: "SG",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    tags: "alpha, beta",
  });
  expect((await store.listTags()).map((tag) => tag.name).sort()).toEqual(["alpha", "beta"]);
  const stored = JSON.parse(await readFile(join(dir, "proxies.json"), "utf8"));
  expect(stored.version).toBe(3);
  expect(stored.tags.map((tag) => tag.name).sort()).toEqual(["alpha", "beta"]);
});

test("a v2 file loads with no tags and is upgraded to v3 on the next write", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, "proxies.json"),
    JSON.stringify({
      version: 2,
      proxies: [],
      groups: [
        {
          id: "g1",
          name: "Legacy",
          provider: "",
          mode: "group",
          tag: "",
          proxyIds: [],
          perIp: 2,
          note: "",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const store = createProxyStore({ dataDir: dir });
  expect(await store.listTags()).toEqual([]);
  const [legacy] = await store.listGroups();
  expect(legacy.parentId).toBeNull();
  await store.create({ name: "later", type: "http", host: "127.0.0.1", port: 8081 });
  const stored = JSON.parse(await readFile(join(dir, "proxies.json"), "utf8"));
  expect(stored.version).toBe(3);
  expect(stored.tags).toEqual([]);
});

test("an impossible nesting in a hand-edited file is lifted to the root on load", async () => {
  const dir = await tempDir();
  const stamp = "2026-01-01T00:00:00.000Z";
  const base = {
    provider: "",
    mode: "group",
    tag: "",
    proxyIds: [],
    perIp: 2,
    note: "",
    createdAt: stamp,
    updatedAt: stamp,
  };
  await writeFile(
    join(dir, "proxies.json"),
    JSON.stringify({
      version: 3,
      proxies: [],
      groups: [
        { id: "a", name: "a", ...base, parentId: null },
        { id: "b", name: "b", ...base, parentId: "a" },
        { id: "c", name: "c", ...base, parentId: "b" },
        // A fourth level would be invalid.
        { id: "d", name: "d", ...base, parentId: "c" },
        // A missing parent.
        { id: "e", name: "e", ...base, parentId: "gone" },
      ],
      tags: [
        { name: "t1", parent: null },
        { name: "t2", parent: "t1" },
        { name: "t3", parent: "t2" },
        { name: "t4", parent: "t3" },
        { name: "t5", parent: "gone" },
      ],
    }),
  );
  const store = createProxyStore({ dataDir: dir });
  const groups = await store.listGroups();
  expect(groups.find((item) => item.id === "c").parentId).toBe("b");
  expect(groups.find((item) => item.id === "d").parentId).toBeNull();
  expect(groups.find((item) => item.id === "e").parentId).toBeNull();
  const tags = await store.listTags();
  expect(tags.find((tag) => tag.name === "t3").parent).toBe("t2");
  expect(tags.find((tag) => tag.name === "t4").parent).toBeNull();
  expect(tags.find((tag) => tag.name === "t5").parent).toBeNull();
});
