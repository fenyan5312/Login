// Sign-in write-back: key selection and the `client.auth.set` call. Tests use
// only in-memory entries and a fake client (plus temporary directories for the
// key-only reader); they never read or write the real `~/.config/magpie` and
// never touch a network.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountsOf,
  chooseAccountKey,
  normalizeResult,
  readAuthEntries,
  signInKey,
  uidOf,
  whoOf,
  writeBack,
} from "../lib/signin-writeback.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-writeback-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const suffixOf = (r) => r.toString(36).slice(2, 8);
const fixedRandom = () => 0.123456789;
const fixedSuffix = suffixOf(0.123456789);

function fakeClient({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      set: async (input) => {
        if (fail) throw new Error("client.auth.set failed");
        calls.push(input);
      },
    },
  };
}

test("accountsOf puts the bare key first and keeps only the provider's keys", () => {
  const entries = {
    "workbuddy#zzz": {},
    workbuddy: {},
    "workbuddy#aaa": {},
    "workbuddy-ai": {},
    cursor: {},
  };
  expect(accountsOf(entries, "workbuddy")).toEqual(["workbuddy", "workbuddy#aaa", "workbuddy#zzz"]);
  // A provider whose id shares a prefix is not swept in.
  expect(accountsOf(entries, "workbuddy-ai")).toEqual(["workbuddy-ai"]);
});

test("whoOf and uidOf follow magpie's fallback order", () => {
  expect(whoOf({ accountId: "a", metadata: { email: "b" }, email: "c" })).toBe("a");
  expect(whoOf({ metadata: { email: "b" }, email: "c" })).toBe("b");
  expect(whoOf({ email: "c" })).toBe("c");
  expect(whoOf({})).toBe("");
  expect(uidOf({ uid: "u" })).toBe("u");
  expect(uidOf({ uid: 7 })).toBe("");
});

test("signInKey reuses a named account of the same provider", () => {
  const keys = new Set(["workbuddy", "workbuddy#x"]);
  expect(signInKey("workbuddy", "workbuddy#x", keys)).toBe("workbuddy#x");
  // A named account of another provider (or the literal "new") allocates.
  expect(signInKey("workbuddy", "cursor", keys, { random: fixedRandom })).toBe(
    "workbuddy#" + fixedSuffix,
  );
  expect(signInKey("workbuddy", "new", keys, { random: fixedRandom })).toBe(
    "workbuddy#" + fixedSuffix,
  );
});

test("signInKey with single uses the first account key or the bare id", () => {
  const keys = new Set(["workbuddy", "workbuddy#b", "workbuddy#a"]);
  expect(signInKey("workbuddy", undefined, keys, { single: true })).toBe("workbuddy");
  expect(signInKey("cursor", undefined, new Set(), { single: true })).toBe("cursor");
});

test("normalizeResult drops type/provider and flattens the rest", () => {
  expect(
    normalizeResult({
      type: "oauth",
      provider: "workbuddy",
      refresh: "R",
      access: "A",
      expires: 1,
      accountId: "me",
      metadata: { email: "me@example.com" },
    }),
  ).toEqual({
    type: "oauth",
    refresh: "R",
    access: "A",
    expires: 1,
    accountId: "me",
    metadata: { email: "me@example.com" },
  });
});

test("a free bare key is used and reported as created", async () => {
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { provider: "workbuddy", refresh: "r", access: "a", expires: 1, accountId: "me" },
    entries: {},
    client,
  });
  expect(result).toEqual({
    ok: true,
    key: "workbuddy",
    created: true,
    updated: false,
    error: null,
    entry: { provider: "workbuddy", key: "workbuddy", accountId: "me", uid: null, type: "oauth" },
  });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].path.id).toBe("workbuddy");
});

test("an occupied bare key gets a fresh key and never touches the bare key", async () => {
  const entries = { workbuddy: { accountId: "someone-else" } };
  const before = JSON.stringify(entries);
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { provider: "workbuddy", refresh: "r", access: "a", expires: 1, accountId: "new-person" },
    entries,
    client,
    opts: { random: fixedRandom },
  });
  expect(result.ok).toBe(true);
  expect(result.created).toBe(true);
  expect(result.updated).toBe(false);
  expect(result.key).toBe("workbuddy#" + fixedSuffix);
  expect(result.key.startsWith("workbuddy#")).toBe(true);
  // The bare key is untouched: still the only key, still the other account.
  expect(Object.keys(entries)).toEqual(["workbuddy"]);
  expect(entries.workbuddy.accountId).toBe("someone-else");
  expect(JSON.stringify(entries)).toBe(before);
  expect(client.calls.map((call) => call.path.id)).toEqual([result.key]);
  expect(client.calls.some((call) => call.path.id === "workbuddy")).toBe(false);
});

test("the same account by accountId reuses its key instead of adding one", async () => {
  const entries = {
    workbuddy: { accountId: "someone-else" },
    "workbuddy#existing": { accountId: "me" },
  };
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { provider: "workbuddy", refresh: "r2", access: "a2", expires: 2, accountId: "me" },
    entries,
    client,
  });
  expect(result).toEqual({
    ok: true,
    key: "workbuddy#existing",
    created: false,
    updated: true,
    error: null,
    entry: { provider: "workbuddy", key: "workbuddy#existing", accountId: "me", uid: null, type: "oauth" },
  });
  expect(Object.keys(entries)).toEqual(["workbuddy", "workbuddy#existing"]);
  expect(client.calls[0].path.id).toBe("workbuddy#existing");
});

test("the same account by accountId and uid reuses its key", async () => {
  const entries = {
    workbuddy: { accountId: "someone-else" },
    "workbuddy#existing": { accountId: "me", uid: "u1" },
  };
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r", accountId: "me", uid: "u1" },
    entries,
    client: fakeClient(),
  });
  expect(result.key).toBe("workbuddy#existing");
  expect(result.updated).toBe(true);
  expect(Object.keys(entries)).toHaveLength(2);
});

test("a conflicting uid is not the same account and gets a new key", async () => {
  const entries = {
    workbuddy: { accountId: "someone-else" },
    "workbuddy#existing": { accountId: "me", uid: "u1" },
  };
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r", accountId: "me", uid: "u2" },
    entries,
    client: fakeClient(),
    opts: { random: fixedRandom },
  });
  expect(result.created).toBe(true);
  expect(result.key).toBe("workbuddy#" + fixedSuffix);
  expect(Object.keys(entries)).toHaveLength(2);
});

test("the written body matches magpie's save shape", async () => {
  const client = fakeClient();
  await writeBack({
    provider: "workbuddy",
    result: {
      provider: "workbuddy",
      type: "oauth",
      refresh: "R",
      access: "A",
      expires: 111,
      accountId: "me",
      uid: "u1",
      metadata: { email: "me@example.com" },
    },
    entries: {},
    client,
  });
  expect(client.calls[0].body).toEqual({
    type: "oauth",
    refresh: "R",
    access: "A",
    expires: 111,
    accountId: "me",
    uid: "u1",
    metadata: { email: "me@example.com" },
  });
  expect("provider" in client.calls[0].body).toBe(false);
});

test("a single provider always lands on its first account key", async () => {
  const entries = {
    workbuddy: { accountId: "someone-else" },
    "workbuddy#zzz": { accountId: "me" },
  };
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { provider: "workbuddy", refresh: "r", access: "a", expires: 1, accountId: "me" },
    entries,
    client,
    opts: { single: true },
  });
  // Even though `workbuddy#zzz` names the same account, a single provider has
  // one slot: the bare key.
  expect(result.key).toBe("workbuddy");
  expect(result.updated).toBe(true);
  expect(client.calls[0].path.id).toBe("workbuddy");
});

test("a failing client returns ok:false instead of throwing", async () => {
  const client = fakeClient({ fail: true });
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r", accountId: "me" },
    entries: {},
    client,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("client.auth.set failed");
  expect(result.key).toBe("workbuddy");
});

test("an allocation failure returns ok:false instead of throwing", async () => {
  const entries = { workbuddy: {}, ["workbuddy#" + fixedSuffix]: {} };
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r" },
    entries,
    client: fakeClient(),
    opts: { random: fixedRandom },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/no free key for "workbuddy"/);
  expect(result.key).toBeNull();
});

test("a failed entry read does not stop a write with the bare key", async () => {
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r", accountId: "me" },
    client,
    opts: {
      readEntries: () => {
        throw new Error("unreadable auth file");
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(result.key).toBe("workbuddy");
  expect(result.created).toBe(true);
});

test("an entries function that throws degrades to no entries", async () => {
  const result = await writeBack({
    provider: "workbuddy",
    result: { refresh: "r", accountId: "me" },
    entries: () => {
      throw new Error("boom");
    },
    client: fakeClient(),
  });
  expect(result.ok).toBe(true);
  expect(result.key).toBe("workbuddy");
});

test("readAuthEntries returns only non-credential fields", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, "plugin-auth.json"),
    JSON.stringify({
      workbuddy: {
        type: "oauth",
        access: "ACCESS-SECRET",
        refresh: "REFRESH-SECRET",
        key: "KEY-SECRET",
        expires: 123,
        accountId: "me",
        uid: "u1",
        email: "me@example.com",
        metadata: { email: "meta@example.com", token: "META-SECRET" },
      },
      "workbuddy#x": { type: "oauth", metadata: { email: "fallback@example.com" } },
    }),
  );
  const entries = readAuthEntries({ MAGPIE_CONFIG_DIR: dir });
  expect(Object.keys(entries).sort()).toEqual(["workbuddy", "workbuddy#x"]);
  expect(entries.workbuddy).toEqual({
    type: "oauth",
    accountId: "me",
    uid: "u1",
    email: "me@example.com",
  });
  expect(entries["workbuddy#x"]).toEqual({ type: "oauth", email: "fallback@example.com" });
  for (const entry of Object.values(entries)) {
    for (const field of ["access", "refresh", "key", "metadata"]) {
      expect(field in entry).toBe(false);
    }
    expect(Object.keys(entry).every((key) => ["accountId", "uid", "type", "email"].includes(key))).toBe(
      true,
    );
  }
});

test("readAuthEntries degrades to an empty object on missing or malformed input", async () => {
  const dir = await tempDir();
  expect(readAuthEntries({ MAGPIE_CONFIG_DIR: dir })).toEqual({});
  await writeFile(join(dir, "plugin-auth.json"), "{ not json");
  expect(readAuthEntries({ MAGPIE_CONFIG_DIR: dir })).toEqual({});
  await writeFile(join(dir, "plugin-auth.json"), "null");
  expect(readAuthEntries({ MAGPIE_CONFIG_DIR: dir })).toEqual({});
  await writeFile(join(dir, "plugin-auth.json"), "[1, 2, 3]");
  expect(readAuthEntries({ MAGPIE_CONFIG_DIR: dir })).toEqual({});
});

test("forceKey writes to the named key and skips the settle match", async () => {
  const entries = {
    workbuddy: { accountId: "someone-else" },
    "workbuddy#existing": { accountId: "me", uid: "u1" },
  };
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: { provider: "workbuddy", refresh: "r", access: "a", expires: 1, accountId: "me", uid: "u1" },
    entries,
    client,
    opts: { forceKey: "workbuddy#chosen", random: fixedRandom },
  });
  // The settle name match would have picked `workbuddy#existing`; forceKey
  // wins because a reused identity must land on the key the user chose.
  expect(result.ok).toBe(true);
  expect(result.key).toBe("workbuddy#chosen");
  expect(result.created).toBe(true);
  expect(result.entry).toEqual({
    provider: "workbuddy",
    key: "workbuddy#chosen",
    accountId: "me",
    uid: "u1",
    type: "oauth",
  });
  expect(client.calls.map((call) => call.path.id)).toEqual(["workbuddy#chosen"]);
});

test("the returned entry never carries a credential", async () => {
  const client = fakeClient();
  const result = await writeBack({
    provider: "workbuddy",
    result: {
      provider: "workbuddy",
      refresh: "R",
      access: "A",
      expires: 1,
      accountId: "me",
      uid: "u1",
      metadata: { email: "me@example.com" },
      key: "KEY-SECRET",
    },
    entries: {},
    client,
  });
  expect(Object.keys(result.entry).sort()).toEqual([
    "accountId",
    "key",
    "provider",
    "type",
    "uid",
  ]);
  for (const field of ["access", "refresh", "metadata", "expires"]) {
    expect(field in result.entry).toBe(false);
  }
  expect(JSON.stringify(result.entry)).not.toContain("SECRET");
});

test("chooseAccountKey is importable and returns the bare key when free", () => {
  expect(chooseAccountKey("workbuddy", { refresh: "r", accountId: "me" }, {}, {})).toBe("workbuddy");
});
