// Credential import with an IP group: the exit is checked before the write,
// recorded in the ledger, pinned to a fingerprint and synced into magpie's
// account -> proxy map. A fake client and a fake fingerprint pin keep the whole
// test inside a temp directory.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER, startServer } from "../lib/server.mjs";
import { accountDir, readAccountMeta, writeAccountMeta } from "../lib/account-identity.mjs";

const tmp = mkdtempSync(join(tmpdir(), "login-import-group-"));
const dataDir = join(tmp, "data");
const configDir = join(tmp, "magpie-config");
const env = { ...process.env, MAGPIE_CONFIG_DIR: configDir, MAGPIE_CLEAN_LOGIN_DATA: dataDir };

const writes = [];
const syncs = [];
const pins = [];
let fingerprintFails = false;
let service;
let token;

beforeAll(async () => {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "plugin-auth.json"), JSON.stringify({}));
  service = await startServer({
    port: 0,
    env,
    dataDir,
    pluginScanner: {
      get: () => ({ available: false, providers: [], scanned: false, stale: false, scanning: false, error: null }),
      warm() {},
    },
    client: {
      auth: {
        async set(payload) {
          writes.push(payload);
          return { ok: true };
        },
      },
    },
    signIn: {
      async startSignIn() {
        return {};
      },
      status: () => null,
      async cancel() {
        return {};
      },
    },
    async ensureAccountIdentity(dir) {
      pins.push(dir);
      if (fingerprintFails) throw new Error("the fingerprint model is not installed");
      return { identity: { id: "fake" }, created: true };
    },
    accountProxySync: {
      async syncSignIn(args) {
        syncs.push(args);
        return { ok: true, reason: "written" };
      },
      async backfill() {
        return { ok: true, reason: "nothing_to_sync" };
      },
    },
  });
  await service.prune?.();
  const html = await (await fetch(`http://127.0.0.1:${service.port}/`)).text();
  token = /name="clean-login-token" content="([0-9a-f]+)"/.exec(html)?.[1];
});

beforeEach(() => {
  writes.length = 0;
  syncs.length = 0;
  pins.length = 0;
  fingerprintFails = false;
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
    username: "user",
    password: "secret-password",
    tags,
  });
  expect(res.status).toBe(201);
  return res.body.proxy;
}

async function createGroup(body) {
  const res = await api("POST", "/api/proxy-groups", body);
  expect(res.status).toBe(201);
  return res.body.group;
}

test("an import with a group records the exit, the group and the fingerprint", async () => {
  const a = await createProxy("import A", "imp");
  const b = await createProxy("import B", "imp");
  const group = await createGroup({
    name: "Import group",
    provider: "impone",
    mode: "group",
    proxyIds: [a.id, b.id],
    perIp: 2,
  });

  const res = await api("POST", "/api/import", {
    provider: "impone",
    text: "sk-import-one-abcdefghijkl",
    groupId: group.id,
  });
  expect(res.status).toBe(200);
  expect(res.body.fingerprintCreated).toBe(true);
  expect(res.body.fingerprintPending).toBe(false);
  expect(res.body.proxyGroupId).toBe(group.id);
  expect(res.body.proxyGroupName).toBe("Import group");
  expect(res.body.proxySync).toEqual({ ok: true, reason: "written" });
  expect([a.id, b.id]).toContain(res.body.proxy.id);
  expect(res.body.proxy).toEqual({
    id: res.body.proxy.id,
    name: res.body.proxy.name,
    region: "",
    type: "http",
  });
  expect(JSON.stringify(res.body)).not.toContain("secret-password");
  expect(JSON.stringify(res.body)).not.toContain("sk-import-one-abcdefghijkl");

  // The ledger carries the rule and the exact exit, and the exit snapshot is
  // the one the response names.
  const dir = accountDir(env, "impone", res.body.key);
  const meta = await readAccountMeta(dir);
  expect(meta.proxyGroupId).toBe(group.id);
  expect(meta.proxyGroupName).toBe("Import group");
  expect(meta.lastLogin.proxyId).toBe(res.body.proxy.id);
  expect(meta.lastLogin.proxyName).toBe(res.body.proxy.name);
  expect(meta.lastLogin.type).toBe("http");
  expect(meta.accountId).toBe(res.body.accountId);

  // The pin is created for this account's own directory, and magpie's map is
  // asked to follow the same exit.
  expect(pins).toEqual([dir]);
  expect(syncs).toHaveLength(1);
  expect(syncs[0]).toMatchObject({ provider: "impone", proxy: { id: res.body.proxy.id } });

  // The allocation is real: the group now counts one account.
  const listed = await api("GET", "/api/proxy-groups");
  const view = listed.body.groups.find((item) => item.id === group.id);
  expect(view.used).toBe(1);
});

test("a full group refuses the import before anything is written", async () => {
  const proxy = await createProxy("full import exit", "fullimport");
  const group = await createGroup({
    name: "Full import",
    provider: "impfull",
    mode: "group",
    proxyIds: [proxy.id],
    perIp: 1,
  });
  await writeAccountMeta(accountDir(env, "impfull", "impfull"), {
    version: 1,
    provider: "impfull",
    key: "impfull",
    accountId: "existing",
    lastLogin: { proxyId: proxy.id },
  });

  const res = await api("POST", "/api/import", {
    provider: "impfull",
    text: "sk-import-full-abcdefghijkl",
    groupId: group.id,
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("group_full");
  expect(writes).toHaveLength(0);
  expect(pins).toHaveLength(0);
  expect(await readAccountMeta(accountDir(env, "impfull", "impfull#blocked"))).toBeNull();
});

test("an explicit proxy outside the group is a 400", async () => {
  const inside = await createProxy("mismatch inside", "mismatch");
  const outside = await createProxy("mismatch outside", "mismatch");
  const group = await createGroup({
    name: "Mismatch",
    provider: "impmismatch",
    mode: "group",
    proxyIds: [inside.id],
    perIp: 2,
  });
  const res = await api("POST", "/api/import", {
    provider: "impmismatch",
    text: "sk-import-mismatch-abcdefgh",
    groupId: group.id,
    proxy: { id: outside.id },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("group_proxy_mismatch");
  expect(writes).toHaveLength(0);
});

test("unknown proxies and groups are 404s before the write", async () => {
  const missingProxy = await api("POST", "/api/import", {
    provider: "imp404",
    text: "sk-import-404-abcdefghijkl",
    proxy: { id: "not-a-real-proxy" },
  });
  expect(missingProxy.status).toBe(404);
  expect(missingProxy.body.error).toBe("not_found");

  const missingGroup = await api("POST", "/api/import", {
    provider: "imp404",
    text: "sk-import-404-abcdefghijkl",
    groupId: "not-a-real-group",
  });
  expect(missingGroup.status).toBe(404);
  expect(missingGroup.body.error).toBe("not_found");
  expect(writes).toHaveLength(0);
});

test("a missing fingerprint model does not undo an import", async () => {
  fingerprintFails = true;
  const res = await api("POST", "/api/import", {
    provider: "impfingerprint",
    text: "sk-import-fingerprint-abcd",
  });
  expect(res.status).toBe(200);
  expect(res.body.fingerprintCreated).toBe(false);
  expect(res.body.fingerprintPending).toBe(true);
  expect(res.body.proxy).toBeNull();
  expect(res.body.proxyGroupId).toBeNull();
  expect(writes).toHaveLength(1);
  // A direct import still gets a ledger with an empty exit snapshot.
  const meta = await readAccountMeta(accountDir(env, "impfingerprint", res.body.key));
  expect(meta.lastLogin.proxyId).toBeNull();
  expect(meta.proxyGroupId).toBeNull();
});

test("an explicit proxy is used without a group and recorded", async () => {
  const proxy = await createProxy("explicit exit", "explicit");
  const res = await api("POST", "/api/import", {
    provider: "impexplicit",
    text: "sk-import-explicit-abcdefg",
    proxy: { id: proxy.id },
  });
  expect(res.status).toBe(200);
  expect(res.body.proxy).toMatchObject({ id: proxy.id, name: "explicit exit", type: "http" });
  expect(res.body.proxyGroupId).toBeNull();
  expect(res.body.proxyGroupName).toBe("");
  const meta = await readAccountMeta(accountDir(env, "impexplicit", res.body.key));
  expect(meta.lastLogin.proxyId).toBe(proxy.id);
  expect(syncs[0].proxy.id).toBe(proxy.id);
});

test("an import without a group reuses the provider's only group and the remembered exit", async () => {
  const proxy = await createProxy("remembered exit", "remembered");
  const group = await createGroup({
    name: "Remembered",
    provider: "impremembered",
    mode: "group",
    proxyIds: [proxy.id],
    perIp: 2,
  });
  // First import assigns the group and the exit.
  const first = await api("POST", "/api/import", {
    provider: "impremembered",
    text: "sk-import-remembered-one",
    groupId: group.id,
  });
  expect(first.status).toBe(200);
  const meta = await readAccountMeta(accountDir(env, "impremembered", first.body.key));
  expect(meta.proxyGroupId).toBe(group.id);
  expect(meta.lastLogin.proxyId).toBe(proxy.id);

  // A second import without a group still lands on the remembered rule and
  // the remembered exit, because the key resolves to the same account.
  const second = await api("POST", "/api/import", {
    provider: "impremembered",
    text: "sk-import-remembered-two",
  });
  expect(second.status).toBe(200);
  expect(second.body.key).toBe(first.body.key);
  expect(second.body.proxyGroupId).toBe(group.id);
  expect(second.body.proxy.id).toBe(proxy.id);
});
