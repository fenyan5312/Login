// Account identity: one directory per account, one pin per directory, written
// exactly once. camoufox is never imported; the generator is injected.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_FILE,
  accountDir,
  accountProfileDir,
  camoufoxOs,
  decodeSegment,
  ensureIdentity,
  readIdentity,
  removeAccountDir,
  requireFingerprintModel,
  safeSegment,
} from "../lib/account-identity.mjs";
import { readFingerprintSummary } from "../lib/account-summary.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "clean-login-identity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("accountDir is deterministic and keeps providers and keys apart", () => {
  const env = { MAGPIE_CLEAN_LOGIN_DATA: join("/data", "clean-login") };
  const a = accountDir(env, "workbuddy", "workbuddy");
  const b = accountDir(env, "workbuddy", "workbuddy#ab12");
  const c = accountDir(env, "workbuddy-ai", "workbuddy-ai");
  expect(a).toBe(join("/data", "clean-login", "accounts", "workbuddy", "workbuddy"));
  expect(b).not.toBe(a);
  expect(c).not.toBe(a);
  // A `#` in the key must not become a path separator or a comment.
  expect(b.includes("#")).toBe(false);
  expect(b).toContain("workbuddy%23ab12");
  // The same inputs always map to the same directory.
  expect(accountDir(env, "workbuddy", "workbuddy#ab12")).toBe(b);
});

test("safeSegment leaves filesystem-safe characters alone", () => {
  expect(safeSegment("workbuddy-ai_2.0")).toBe("workbuddy-ai_2.0");
  expect(safeSegment("a/b")).toBe("a%2fb");
  expect(safeSegment("../x")).toBe("..%2fx");
});

test("decodeSegment is the inverse of safeSegment", () => {
  for (const value of [
    "",
    "workbuddy",
    "workbuddy-ai_2.0",
    "workbuddy#ab12",
    "a/b",
    "../x",
    "#",
    "%",
    "é",
    "naïve",
  ]) {
    expect(decodeSegment(safeSegment(value))).toBe(value);
  }
});

test("decodeSegment decodes the variable-width escapes", () => {
  expect(decodeSegment("acct%23d6jtgo")).toBe("acct#d6jtgo");
  expect(decodeSegment("a%2fb")).toBe("a/b");
  expect(decodeSegment("%25")).toBe("%");
  expect(decodeSegment("%e9")).toBe("é");
});

test("decodeSegment keeps obfuscated multi-digit escapes round-trippable", () => {
  // `safeSegment` is not injective above U+00FF: `%4e2d` can be read as `中`
  // or as `Ӣ` + `d`. The decoder takes the shorter escape, so the exact
  // character is not recovered; the segment still round-trips through
  // `safeSegment`, which is what the orphan sweep compares.
  const segment = safeSegment("中");
  expect(segment).toBe("%4e2d");
  expect(safeSegment(decodeSegment(segment))).toBe(segment);
});

test("decodeSegment rejects a segment safeSegment could not have produced", () => {
  for (const value of ["%zz", "%2", "trail%", "中", 5, null, undefined]) {
    expect(decodeSegment(value)).toBeNull();
  }
});

test("the profile directory sits inside the account directory", () => {
  expect(accountProfileDir(join("/data", "accounts", "p", "p"))).toBe(
    join("/data", "accounts", "p", "p", "profile"),
  );
});

test("camoufoxOs maps the three platforms the generator knows", () => {
  expect(camoufoxOs("win32")).toBe("windows");
  expect(camoufoxOs("darwin")).toBe("macos");
  expect(camoufoxOs("linux")).toBe("linux");
  expect(camoufoxOs("freebsd")).toBe("linux");
});

test("ensureIdentity writes the pin once and reuses it byte for byte", async () => {
  const dir = await tempDir();
  const calls = [];
  const generate = async (options) => {
    calls.push(options);
    return { tag: "pinned", options };
  };

  const first = await ensureIdentity(dir, { generate });
  expect(first.created).toBe(true);
  expect(first.identity.tag).toBe("pinned");
  expect(calls).toEqual([{ os: camoufoxOs() }]);

  const file = join(dir, IDENTITY_FILE);
  const text = await readFile(file, "utf8");
  const before = await stat(file);

  const second = await ensureIdentity(dir, {
    generate: async () => {
      throw new Error("must not be called");
    },
  });
  expect(second.created).toBe(false);
  expect(second.identity).toEqual(first.identity);
  expect(await readFile(file, "utf8")).toBe(text);
  // The file is not rewritten: its modification time does not move.
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(calls).toHaveLength(1);
});

test("ensureIdentity falls back to an OS-agnostic fingerprint", async () => {
  const dir = await tempDir();
  const calls = [];
  const { identity, created } = await ensureIdentity(dir, {
    generate: async (options) => {
      calls.push(options);
      if (options.os) throw new Error("unknown os");
      return { tag: "generic" };
    },
  });
  expect(created).toBe(true);
  expect(identity).toEqual({ tag: "generic" });
  expect(calls).toEqual([{ os: camoufoxOs() }, {}]);
});

test("a pin that was never written is not invented: both draws failing throws", async () => {
  const dir = await tempDir();
  await expect(
    ensureIdentity(dir, {
      generate: async () => {
        throw new Error("no model");
      },
    }),
  ).rejects.toThrow("no model");
});

test("a malformed stored pin is not trusted", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, IDENTITY_FILE), "{ not json");
  const { created, identity } = await ensureIdentity(dir, {
    generate: async () => ({ tag: "regenerated" }),
  });
  expect(created).toBe(true);
  expect(identity).toEqual({ tag: "regenerated" });
});

// `readIdentity` is read-only: the detection engine uses it to prove a pin
// exists before it opens a browser, without ever drawing a new fingerprint as
// a side effect of merely looking.
test("readIdentity returns the stored pin without generating one", async () => {
  const dir = await tempDir();
  const generated = [];
  const identity = { webgl: { vendor: "X" }, nested: { a: 1 } };
  await ensureIdentity(dir, {
    generate: async () => {
      generated.push(1);
      return identity;
    },
  });
  expect(generated).toHaveLength(1);
  expect(await readIdentity(dir)).toEqual(identity);
  // Reading never calls a generator and never rewrites the file.
  expect(generated).toHaveLength(1);
});

test("readIdentity returns null for a missing, malformed or non-object pin", async () => {
  const dir = await tempDir();
  expect(await readIdentity(dir)).toBeNull();
  expect(await readIdentity(null)).toBeNull();
  // Reading a missing pin must not create the file.
  await expect(readFile(join(dir, IDENTITY_FILE), "utf8")).rejects.toBeTruthy();

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, IDENTITY_FILE), "{ not json");
  expect(await readIdentity(dir)).toBeNull();
  await writeFile(join(dir, IDENTITY_FILE), "[1, 2]");
  expect(await readIdentity(dir)).toBeNull();
  await writeFile(join(dir, IDENTITY_FILE), "null");
  expect(await readIdentity(dir)).toBeNull();
});

test("readFingerprintSummary digests the pin bytes and reports the pinned time", async () => {
  const dir = await tempDir();
  const bytes = Buffer.from('{"tag":"pin"}', "utf8");
  const fixedTime = new Date("2026-11-04T08:09:10.000Z");
  const summary = await readFingerprintSummary(dir, {
    readFile: async () => bytes,
    stat: async () => ({ mtime: fixedTime }),
  });
  const { createHash } = await import("node:crypto");
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  expect(summary).toEqual({
    id: `${hex.slice(0, 4)}·${hex.slice(4)}`,
    pinnedAt: fixedTime.toISOString(),
  });
  expect(summary.id).toMatch(/^[0-9a-f]{4}·[0-9a-f]{8}$/);
});

test("readFingerprintSummary is empty for a missing or corrupt pin", async () => {
  const dir = await tempDir();
  expect(await readFingerprintSummary(dir)).toEqual({ id: null, pinnedAt: null });
  expect(
    await readFingerprintSummary(dir, {
      readFile: async () => "{ not json",
      stat: async () => ({ mtime: new Date() }),
    }),
  ).toEqual({ id: null, pinnedAt: null });
  expect(
    await readFingerprintSummary(dir, {
      readFile: async () => "[1]",
      stat: async () => ({ mtime: new Date() }),
    }),
  ).toEqual({ id: null, pinnedAt: null });
});

test("readFingerprintSummary never returns the identity object or a path", async () => {
  const dir = await tempDir();
  const bytes = Buffer.from(JSON.stringify({ password: "secret", host: "10.0.0.7" }), "utf8");
  const summary = await readFingerprintSummary(dir, {
    readFile: async () => bytes,
    stat: async () => ({ mtime: new Date("2026-11-04T00:00:00.000Z") }),
  });
  expect(JSON.stringify(summary)).not.toContain("secret");
  expect(JSON.stringify(summary)).not.toContain("10.0.0.7");
  expect(JSON.stringify(summary)).not.toContain(dir);
  expect(Object.keys(summary).sort()).toEqual(["id", "pinnedAt"]);
});

test("removeAccountDir removes the profile and the pin together", async () => {
  const dir = await tempDir();
  await ensureIdentity(dir, { generate: async () => ({ tag: "x" }) });
  await removeAccountDir(dir);
  await expect(readFile(join(dir, IDENTITY_FILE), "utf8")).rejects.toBeTruthy();
});

test("a missing fingerprint model surfaces an actionable error", async () => {
  const dataDir = await tempDir();
  const modelRoot = await tempDir();
  const fpgen = {
    MODEL_PIN: { tag: "model-2/2026", sha256: "0".repeat(64), files: ["values.dat.zst"] },
    setModelDir() {},
  };
  const env = { MAGPIE_CLEAN_LOGIN_BROWSER_DIR: modelRoot };
  const dir = join(dataDir, "account");

  // ensureIdentity retries the OS-agnostic path after the first failure, so
  // requireFingerprintModel runs twice; the actionable message must survive.
  await expect(
    ensureIdentity(dir, {
      generate: async () => {
        await requireFingerprintModel({ fpgen, env });
        return { tag: "never" };
      },
    }),
  ).rejects.toThrow(/Prepare browser step/);
  await expect(readFile(join(dir, IDENTITY_FILE), "utf8")).rejects.toBeTruthy();
});

test("requireFingerprintModel points fpgen at the plugin's model directory", async () => {
  const modelRoot = await tempDir();
  const modelDir = join(modelRoot, "fpgen");
  const { MODEL_PIN } = await import("fpgen-js");
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, ".pinned-model"), `${MODEL_PIN.sha256}\n`);
  for (const name of MODEL_PIN.files) await writeFile(join(modelDir, name), "x");

  const set = [];
  const resolved = await requireFingerprintModel({
    fpgen: { MODEL_PIN, setModelDir: (value) => set.push(value) },
    env: { MAGPIE_CLEAN_LOGIN_BROWSER_DIR: modelRoot },
  });
  expect(resolved).toBe(modelDir);
  expect(set).toEqual([modelDir]);
});
