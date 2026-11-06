// Account-key allocation: pure key maths plus a key-only reader for magpie's
// auth file. Tests touch only temporary directories and never the real
// `~/.config/magpie`, and never a network.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshAccountKey, providerOf, readAuthKeys, readAuthKeysResult } from "../lib/account-keys.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-keys-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The exact suffix magpie's `Math.random().toString(36).slice(2, 8)` yields for
// a source, computed here so the tests state the rule, not a recorded draw.
const suffixOf = (r) => r.toString(36).slice(2, 8);

// A fixed source, like a recorded magpie draw: 0.123456789 is "4fzzzx" in
// base 36 between indices 2 and 8.
const fixedRandom = () => 0.123456789;
const fixedSuffix = suffixOf(0.123456789);

test("providerOf takes the part before the first #", () => {
  expect(providerOf("workbuddy")).toBe("workbuddy");
  expect(providerOf("workbuddy#" + fixedSuffix)).toBe("workbuddy");
  expect(providerOf("workbuddy-ai")).toBe("workbuddy-ai");
  // A different provider whose id shares a prefix is not the same account.
  expect(providerOf("workbuddy-ai")).not.toBe(providerOf("workbuddy#" + fixedSuffix));
});

test("returns the bare provider key when it is free", () => {
  expect(freshAccountKey("workbuddy", new Set())).toBe("workbuddy");
  expect(freshAccountKey("cursor", [])).toBe("cursor");
  expect(freshAccountKey("codex", new Set(["claude", "codex-extra"]))).toBe("codex");
});

test("returns a fresh provider# suffix when the bare key is taken", () => {
  const existing = new Set(["workbuddy"]);
  const key = freshAccountKey("workbuddy", existing, fixedRandom);
  expect(key).toBe("workbuddy#" + fixedSuffix);
  expect(existing.has(key)).toBe(false);
  expect(key.startsWith("workbuddy#")).toBe(true);
  // The suffix is between 0 and 6 base36 characters long, as magpie's
  // slice(2, 8) can be.
  expect(key.length).toBeGreaterThan("workbuddy#".length);
  expect(key.length).toBeLessThanOrEqual("workbuddy#".length + 6);

  const free = freshAccountKey("cursor", ["cursor"], () => 0.999999);
  expect(free).toBe("cursor#" + suffixOf(0.999999));
  expect(free).not.toBe("cursor");
  expect(free.startsWith("cursor#")).toBe(true);
});

test("keys from other providers never force a suffix", () => {
  const existing = new Set(["cursor", "cursor#abc123", "claude#zzz"]);
  expect(freshAccountKey("workbuddy", existing)).toBe("workbuddy");
});

test("the suffix is base36 only, matching magpie's slice(2, 8)", () => {
  const existing = new Set(["workbuddy"]);
  const key = freshAccountKey("workbuddy", existing, fixedRandom);
  const suffix = key.slice("workbuddy#".length);
  expect(suffix).toMatch(/^[0-9a-z]+$/);
  expect(existing.has(key)).toBe(false);
  // `toString(36)` can be shorter than six fractional digits; magpie keeps
  // that short suffix and so do we. 0.5 is "0.i", so the key is `#i`.
  expect(freshAccountKey("workbuddy", existing, () => 0.5)).toBe("workbuddy#" + suffixOf(0.5));
  expect(suffixOf(0.5)).toBe("i");
});

test("an always-colliding random source throws at the bound, not forever", () => {
  const existing = new Set(["workbuddy", "workbuddy#" + fixedSuffix]);
  let calls = 0;
  const alwaysCollides = () => {
    calls++;
    return 0.123456789;
  };
  expect(() => freshAccountKey("workbuddy", existing, alwaysCollides)).toThrow(
    /no free key for "workbuddy" after 1000 attempts/,
  );
  expect(calls).toBe(1000);
});

test("readAuthKeys returns an empty set when the file is missing", async () => {
  const dir = await tempDir();
  const keys = readAuthKeys({ MAGPIE_CONFIG_DIR: dir });
  expect(keys).toBeInstanceOf(Set);
  expect(keys.size).toBe(0);
});

test("readAuthKeys returns an empty set on malformed JSON without throwing", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "plugin-auth.json"), "{ not json");
  expect(readAuthKeys({ MAGPIE_CONFIG_DIR: dir }).size).toBe(0);

  await writeFile(join(dir, "plugin-auth.json"), "null");
  expect(readAuthKeys({ MAGPIE_CONFIG_DIR: dir }).size).toBe(0);

  await writeFile(join(dir, "plugin-auth.json"), '"a string"');
  expect(readAuthKeys({ MAGPIE_CONFIG_DIR: dir }).size).toBe(0);

  await writeFile(join(dir, "plugin-auth.json"), "[1, 2, 3]");
  expect(readAuthKeys({ MAGPIE_CONFIG_DIR: dir }).size).toBe(3);
});

test("readAuthKeys returns only key names, never values", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, "plugin-auth.json"),
    JSON.stringify({
      workbuddy: { token: "value-1" },
      "cursor#aaaaaa": { token: "value-2" },
    }),
  );
  const keys = readAuthKeys({ MAGPIE_CONFIG_DIR: dir });
  expect([...keys].sort()).toEqual(["cursor#aaaaaa", "workbuddy"]);
  expect(keys.has("value-1")).toBe(false);
  expect(keys.has("value-2")).toBe(false);
  expect(keys.has("token")).toBe(false);
});

test("readAuthKeysResult keeps the four auth-file states distinct", async () => {
  const dir = await tempDir();

  // 1. Missing file: not an empty key set. The sweep must treat this as
  // "cannot read", never as "no accounts".
  const missing = readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir });
  expect(missing.ok).toBe(false);
  expect(missing.reason).toBe("auth_missing");
  expect(missing.keys).toBeUndefined();

  // 2. Malformed JSON.
  await writeFile(join(dir, "plugin-auth.json"), "not json");
  const malformed = readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir });
  expect(malformed.ok).toBe(false);
  expect(malformed.reason).toBe("auth_invalid");

  // 2b. Parsed but not an object.
  await writeFile(join(dir, "plugin-auth.json"), "null");
  expect(readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir }).ok).toBe(false);
  await writeFile(join(dir, "plugin-auth.json"), '"a string"');
  expect(readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir }).ok).toBe(false);

  // 3. A readable empty object is a valid empty key set: the sweep may run.
  await writeFile(join(dir, "plugin-auth.json"), "{}");
  const empty = readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir });
  expect(empty.ok).toBe(true);
  expect(empty.keys).toBeInstanceOf(Set);
  expect(empty.keys.size).toBe(0);

  // 4. A readable key set.
  await writeFile(
    join(dir, "plugin-auth.json"),
    JSON.stringify({ workbuddy: { token: "secret" }, "cursor#aaaaaa": { token: "secret" } }),
  );
  const real = readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir });
  expect(real.ok).toBe(true);
  expect([...real.keys].sort()).toEqual(["cursor#aaaaaa", "workbuddy"]);
  expect(real.keys.has("secret")).toBe(false);
});

test("readAuthKeysResult reports a read failure, not a missing file", async () => {
  const dir = await tempDir();
  // Reading a directory as a file fails with EISDIR (or a platform
  // permission error), which is a read failure, not ENOENT.
  await mkdir(join(dir, "plugin-auth.json"), { recursive: true });
  const result = readAuthKeysResult({ MAGPIE_CONFIG_DIR: dir });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("auth_unreadable");
});

test("readAuthKeys follows the shared magpie config path", async () => {
  const dir = await tempDir();
  // `magpieConfigDir` appends "magpie" under XDG_CONFIG_HOME, so a file in
  // the XDG root itself is not read.
  await writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ zed: {} }));
  expect([...readAuthKeys({ XDG_CONFIG_HOME: dir })].length).toBe(0);

  const magpieDir = join(dir, "magpie");
  await mkdir(magpieDir, { recursive: true });
  await writeFile(join(magpieDir, "plugin-auth.json"), JSON.stringify({ zed: {}, "zed#a1": {} }));
  expect([...readAuthKeys({ XDG_CONFIG_HOME: dir })].sort()).toEqual(["zed", "zed#a1"]);
});
