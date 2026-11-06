// /api/proxy-groups and the group-aware sign-in resolution, with the flow
// controller injected. No browser is started and no plugin is imported.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";
import { accountDir, writeAccountMeta } from "../lib/account-identity.mjs";

const tmp = mkdtempSync(join(tmpdir(), "clean-login-group-routes-"));
const env = {
  ...process.env,
  MAGPIE_CONFIG_DIR: join(tmp, "magpie-config"),
  MAGPIE_CLEAN_LOGIN_DATA: join(tmp, "data"),
};
let service;
let token;
let lastStart = null;

const signIn = {
  async startSignIn(args) {
    lastStart = args;
    return {
      flowId: "flow-1",
      key: args.provider,
      url: "https://provider/signin",
      instructions: "",
      awaitingInput: false,
    };
  },
  status: () => null,
  async cancel() {
    return { cancelled: false, flow: null };
  },
  async complete() {
    return { flow: null };
  },
};

beforeAll(async () => {
  service = await startServer({
    port: 0,
    env,
    dataDir: join(tmp, "data"),
    pluginScanner: { get: () => ({ available: false, providers: [] }), warm() {} },
    signIn,
  });
  await service.prune?.();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /content="([0-9a-f]{64})"/.exec(html)?.[1];
});

afterAll(async () => {
  await service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${service.port}${path}`, {
    method,
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createProxy(name, tags = "") {
  const res = await api("POST", "/api/proxies", {
    name,
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    tags,
  });
  expect(res.status).toBe(201);
  return res.body.proxy;
}

test("a proxy carries its tags without ever returning a password", async () => {
  const proxy = await createProxy("SG 01", "claude, wb");
  expect(proxy.tags).toEqual(["claude", "wb"]);
  expect(proxy.password).toBeUndefined();
});

test("a group is created, listed with usage, updated and deleted", async () => {
  const a = await createProxy("HK 01", "claude-only");
  const b = await createProxy("HK 02", "claude-only");

  const created = await api("POST", "/api/proxy-groups", {
    name: "Claude 御用",
    provider: "claude",
    mode: "group",
    proxyIds: [a.id, b.id],
    perIp: 2,
  });
  expect(created.status).toBe(201);
  const group = created.body.group;
  expect(group).toMatchObject({
    name: "Claude 御用",
    provider: "claude",
    mode: "group",
    perIp: 2,
    used: 0,
    capacity: 4,
    usage: { [a.id]: 0, [b.id]: 0 },
  });
  expect(group.members.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());

  const listed = await api("GET", "/api/proxy-groups");
  expect(listed.status).toBe(200);
  expect(listed.body.groups).toHaveLength(1);

  const updated = await api("PATCH", `/api/proxy-groups/${group.id}`, {
    mode: "tag",
    tag: "claude-only",
    perIp: 1,
  });
  expect(updated.status).toBe(200);
  expect(updated.body.group).toMatchObject({
    mode: "tag",
    tag: "claude-only",
    perIp: 1,
    capacity: 2,
  });
  expect(updated.body.group.members).toHaveLength(2);

  const removed = await api("DELETE", `/api/proxy-groups/${group.id}`);
  expect(removed.status).toBe(200);
  expect((await api("GET", `/api/proxy-groups/${group.id}`)).status).toBe(404);
  // Deleting the group leaves its IPs alone.
  const proxies = await api("GET", "/api/proxies");
  expect(proxies.body.proxies.some((item) => item.id === a.id)).toBe(true);
});

test("a tag group is rejected without a tag and a missing group is a 404", async () => {
  const bad = await api("POST", "/api/proxy-groups", { name: "x", mode: "tag" });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe("invalid_tag");
  expect((await api("PATCH", "/api/proxy-groups/nope", { perIp: 2 })).status).toBe(404);
  expect((await api("DELETE", "/api/proxy-groups/nope")).status).toBe(404);
});

test("a sign-in with a groupId gets a member proxy and the group, not credentials", async () => {
  const proxy = await createProxy("SG group exit", "claude");
  const created = await api("POST", "/api/proxy-groups", {
    name: "Claude one",
    provider: "openai",
    mode: "group",
    proxyIds: [proxy.id],
    perIp: 2,
  });
  const group = created.body.group;
  lastStart = null;
  const res = await api("POST", "/api/signin", { provider: "openai", groupId: group.id });
  expect(res.status).toBe(202);
  expect(lastStart.proxy).toMatchObject({ id: proxy.id, host: "127.0.0.1", port: 8080 });
  expect(lastStart.proxyGroup).toEqual({ id: group.id, name: "Claude one" });
  expect(lastStart.proxyMeta).toEqual({
    id: proxy.id,
    name: "SG group exit",
    region: "",
    type: "http",
  });
  expect(JSON.stringify(res.body)).not.toContain("password");
});

test("a full group is refused instead of exceeding the per-IP cap", async () => {
  const proxy = await createProxy("full exit", "full");
  const created = await api("POST", "/api/proxy-groups", {
    name: "Full",
    provider: "google",
    mode: "group",
    proxyIds: [proxy.id],
    perIp: 1,
  });
  const group = created.body.group;
  // One account already remembers this exit.
  const dir = accountDir(env, "google", "google");
  await writeAccountMeta(dir, {
    version: 1,
    provider: "google",
    key: "google",
    accountId: "someone",
    lastLogin: { proxyId: proxy.id },
  });
  lastStart = null;
  const res = await api("POST", "/api/signin", { provider: "google", groupId: group.id });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("group_full");
  expect(lastStart).toBeNull();
});

test("an explicit proxy outside the chosen group is refused", async () => {
  const inside = await createProxy("inside", "claude");
  const outside = await createProxy("outside", "other");
  const created = await api("POST", "/api/proxy-groups", {
    name: "Scoped",
    mode: "group",
    proxyIds: [inside.id],
    perIp: 2,
  });
  const res = await api("POST", "/api/signin", {
    provider: "openai",
    groupId: created.body.group.id,
    proxy: { id: outside.id },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("group_proxy_mismatch");
});
