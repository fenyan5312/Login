// IP groups: group mode (an explicit member list) and tag mode (members carry
// a tag), the per-IP account cap, and the store that keeps both modes beside
// the proxies. No browser and no network.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateGroupProxy,
  createProxyStore,
  groupMembers,
  groupUsage,
  readTags,
  validateGroupCreate,
  validateGroupUpdate,
} from "../lib/proxies.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-groups-"));
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

test("a group is validated in group mode and tag mode", () => {
  expect(validateGroupCreate({ name: "Claude 御用", mode: "group", perIp: "2" })).toEqual({
    name: "Claude 御用",
    provider: "",
    mode: "group",
    tag: "",
    proxyIds: [],
    perIp: 2,
    note: "",
  });
  expect(
    validateGroupCreate({
      name: "WorkBuddy",
      provider: "workbuddy",
      mode: "tag",
      tag: " wb-5 ",
      perIp: 5,
      proxyIds: ["ignored"],
    }),
  ).toMatchObject({ mode: "tag", tag: "wb-5", proxyIds: [], perIp: 5 });
  expect(() => validateGroupCreate({ name: "x", mode: "tag" })).toThrow("tag");
  expect(() => validateGroupCreate({ name: "x", mode: "pool" })).toThrow("group or tag");
  expect(() => validateGroupCreate({ name: "x", mode: "group", perIp: 0 })).toThrow("1 to 50");
  expect(() => validateGroupCreate({ name: "x", mode: "group", perIp: 51 })).toThrow("1 to 50");
  expect(() => validateGroupCreate({ name: "", mode: "group" })).toThrow("required");
  expect(() => validateGroupCreate({ name: "x", mode: "group", provider: "not a slug" })).toThrow(
    "provider id",
  );
});

test("a group update validates the merged record", async () => {
  expect(validateGroupUpdate({ perIp: 4 })).toEqual({ perIp: 4 });
  expect(() => validateGroupUpdate({})).toThrow("No group fields");
  const dir = await tempDir();
  const store = createProxyStore({ dataDir: dir });
  const group = await store.createGroup(validateGroupCreate({ name: "x", mode: "group" }));
  await expect(store.updateGroup(group.id, { mode: "tag" })).rejects.toThrow("needs a tag");
  const tag = await store.updateGroup(group.id, { mode: "tag", tag: "claude" });
  expect(tag).toMatchObject({ mode: "tag", tag: "claude", proxyIds: [] });
});

test("tags are trimmed, de-duplicated and bounded", () => {
  expect(readTags(" claude, Claude ,, workbuddy ")).toEqual(["claude", "Claude", "workbuddy"]);
  expect(readTags(["a", "a", " b "])).toEqual(["a", "b"]);
  expect(readTags("")).toEqual([]);
  expect(() => readTags({})).toThrow("text");
  expect(() => readTags(["x".repeat(33)])).toThrow("32");
  expect(() => readTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow("20");
});

test("group and tag modes select their members differently", () => {
  const proxies = [
    proxy("p1", { tags: ["claude"] }),
    proxy("p2", { tags: ["claude", "wb"] }),
    proxy("p3", { tags: ["wb"] }),
  ];
  expect(groupMembers({ mode: "group", proxyIds: ["p1", "p3"] }, proxies).map((p) => p.id)).toEqual([
    "p1",
    "p3",
  ]);
  expect(groupMembers({ mode: "tag", tag: "claude" }, proxies).map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(groupMembers({ mode: "tag", tag: "missing" }, proxies)).toEqual([]);
  expect(groupMembers(null, proxies)).toEqual([]);
});

test("usage counts one account per remembered exit and honours the provider scope", () => {
  const proxies = [proxy("p1"), proxy("p2")];
  const group = {
    mode: "group",
    provider: "claude",
    proxyIds: ["p1", "p2"],
    perIp: 2,
  };
  const accounts = [
    account("claude", "p1"),
    account("claude", "p1"),
    account("claude", "p2"),
    account("workbuddy", "p1"),
    account("claude", null),
  ];
  const usage = groupUsage(group, proxies, accounts);
  expect(Object.fromEntries(usage.counts)).toEqual({ p1: 2, p2: 1 });
  expect(usage.used).toBe(3);
  expect(usage.capacity).toBe(4);
  // An account whose exit is not a member does not consume a slot.
  const outside = groupUsage({ ...group, proxyIds: ["p2"] }, proxies, accounts);
  expect(Object.fromEntries(outside.counts)).toEqual({ p2: 1 });
});

test("allocation picks the least-loaded member with room and refuses a full group", () => {
  const proxies = [proxy("p1", { name: "b" }), proxy("p2", { name: "a" })];
  const group = { mode: "group", provider: "claude", proxyIds: ["p1", "p2"], perIp: 2 };
  expect(
    allocateGroupProxy({
      group,
      proxies,
      accounts: [account("claude", "p1"), account("claude", "p1")],
    })?.id,
  ).toBe("p2");
  // Equal load: the name breaks the tie.
  expect(allocateGroupProxy({ group, proxies, accounts: [] })?.id).toBe("p2");
  expect(
    allocateGroupProxy({
      group,
      proxies,
      accounts: [
        account("claude", "p1"),
        account("claude", "p1"),
        account("claude", "p2"),
        account("claude", "p2"),
      ],
    }),
  ).toBeNull();
  expect(allocateGroupProxy({ group: null, proxies, accounts: [] })).toBeNull();
  expect(
    allocateGroupProxy({ group: { ...group, perIp: 0 }, proxies, accounts: [] }),
  ).toBeNull();
});

test("the store keeps groups beside proxies and survives a reload", async () => {
  const dir = await tempDir();
  const store = createProxyStore({ dataDir: dir });
  const one = await store.create({ name: "SG 01", type: "http", host: "127.0.0.1", port: 8080, tags: "claude" });
  const two = await store.create({ name: "SG 02", type: "http", host: "127.0.0.1", port: 8081, tags: "claude, wb" });
  expect(one.tags).toEqual(["claude"]);
  const group = await store.createGroup(
    validateGroupCreate({ name: "Claude 御用", provider: "claude", mode: "group", proxyIds: [one.id], perIp: 2 }),
  );
  const tagGroup = await store.createGroup(
    validateGroupCreate({ name: "WB", provider: "workbuddy", mode: "tag", tag: "wb", perIp: 5 }),
  );

  const reloaded = createProxyStore({ dataDir: dir });
  const groups = await reloaded.listGroups();
  expect(groups.map((item) => item.name).sort()).toEqual(["Claude 御用", "WB"]);
  expect(groups.find((item) => item.id === group.id).proxyIds).toEqual([one.id]);
  expect(groups.find((item) => item.id === tagGroup.id).tag).toBe("wb");

  // Deleting a member IP cleans group mode only; tag membership is computed
  // from the tag and needs no bookkeeping.
  await reloaded.remove(one.id);
  const after = await reloaded.listGroups();
  expect(after.find((item) => item.id === group.id).proxyIds).toEqual([]);
  expect(groupMembers(after.find((item) => item.id === tagGroup.id), await reloaded.list())).toEqual([
    expect.objectContaining({ id: two.id }),
  ]);
  const publicTwo = (await reloaded.list()).find((item) => item.id === two.id);
  expect(publicTwo.tags).toEqual(["claude", "wb"]);
  expect(publicTwo.password).toBeUndefined();
});
