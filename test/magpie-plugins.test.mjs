// Second-layer tests: classification, the degraded scan, and the TTL cache.
//
// These tests never import a provider plugin and never spawn a child process.
// `scanMagpiePlugins` accepts an injected `execFile`, and `createPluginScanner`
// accepts an injected `scan`, so both are exercised entirely in-process.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_HINT,
  classifyMethod,
  createPluginScanner,
  normalizeScan,
  pluginRootDir,
  scanMagpiePlugins,
  unavailableScan,
} from "../lib/magpie-plugins.mjs";

// ---------- classification ----------

test("a browser oauth method is a browser method", () => {
  for (const label of [
    "Cursor (browser)",
    "WorkBuddy account (browser)",
    "WorkBuddy AI account (browser)",
    "Sign in with Example (官方授权页)",
    "网页登录",
  ]) {
    const method = classifyMethod({ type: "oauth", label, authorize: () => {} });
    expect(method.browser).toBe(true);
    expect(method.category).toBe("browser");
  }
});

// The third state: an oauth method with an authorize function whose label does
// not explicitly name a browser sign-in is NOT forced into `browser`. A PAT
// form, a device code or an enterprise VPC flow may not be a web page. It is
// reported as `pending`: the method IS runnable, only its kind is unconfirmed
// until authorize() runs.
test("an ambiguous oauth method is reported as pending, not browser", () => {
  for (const label of [
    "Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)",
    "Minimax Code account",
    "Sign in with Qoder PAT",
    "Sign in with Qoder CN Enterprise (VPC)",
    "Sign in with QwenWork",
    "ZCode: Z.ai GLM Coding Plan",
    "Loomy 手机验证码登录（讯飞）",
  ]) {
    const method = classifyMethod({ type: "oauth", label, authorize: () => {} });
    expect(method.browser).toBe(false);
    expect(method.category).toBe("pending");
    expect(method.runnable).toBe(true);
  }
});

test("a local-session oauth method is never a browser method", () => {
  for (const label of [
    "cursor-agent's sign-in",
    "Devin CLI's sign-in",
    "Kiro CLI's or Kiro IDE's sign-in",
    "WorkBuddy desktop's sign-in",
    "ZCode app's sign-in",
    "桌面端登录",
    "本地登录",
  ]) {
    expect(LOCAL_HINT.test(label)).toBe(true);
    expect(classifyMethod({ type: "oauth", label, authorize: () => {} }).browser).toBe(false);
  }
});

test("an api method is never a browser method, authorize or not", () => {
  expect(classifyMethod({ type: "api", label: "Cursor API key", authorize: () => {} }).browser).toBe(false);
  expect(classifyMethod({ type: "api", label: "GLM Coding Plan API key" }).browser).toBe(false);
});

test("an oauth method without an authorize function is not a browser method", () => {
  expect(classifyMethod({ type: "oauth", label: "Something account" }).browser).toBe(false);
  // Without an authorize function the method cannot be run at all, so it is
  // unknown rather than pending.
  expect(classifyMethod({ type: "oauth", label: "Something account" }).category).toBe("unknown");
});

test("the child-process boolean form of authorize is honored", () => {
  expect(classifyMethod({ type: "oauth", label: "Account (browser)", hasAuthorize: true }).browser).toBe(true);
  expect(classifyMethod({ type: "oauth", label: "Account (browser)", hasAuthorize: false }).browser).toBe(false);
});

test("junk still yields a shaped method without throwing", () => {
  expect(classifyMethod()).toEqual({
    type: "",
    label: "",
    browser: false,
    category: "unknown",
    prompts: [],
    runnable: false,
  });
  expect(classifyMethod({ type: 42, label: null })).toEqual({
    type: "",
    label: "",
    browser: false,
    category: "unknown",
    prompts: [],
    runnable: false,
  });
});

// ---------- normalization ----------

test("normalizeScan keeps only public, bounded fields", () => {
  const raw = {
    available: true,
    providers: [
      {
        id: "cursor",
        package: "@magpie-community/opencode-cursor-auth",
        methods: [
          { type: "oauth", label: "Cursor (browser)", hasAuthorize: true, authorize: () => {} },
          { type: "oauth", label: "cursor-agent's sign-in", hasAuthorize: true },
          { type: "api", label: "Cursor API key", hasAuthorize: false },
        ],
      },
    ],
  };
  const scan = normalizeScan(raw);
  expect(scan.available).toBe(true);
  expect(scan.providers).toEqual([
    {
      id: "cursor",
      package: "@magpie-community/opencode-cursor-auth",
      methods: [
        { type: "oauth", label: "Cursor (browser)", browser: true, category: "browser", prompts: [], runnable: true },
        { type: "oauth", label: "cursor-agent's sign-in", browser: false, category: "local", prompts: [], runnable: true },
        { type: "api", label: "Cursor API key", browser: false, category: "key", prompts: [], runnable: false },
      ],
    },
  ]);
  // No authorize function survives into the serializable projection.
  expect(JSON.stringify(scan)).not.toContain("authorize");
});

test("normalizeScan deduplicates provider ids and rejects junk", () => {
  const scan = normalizeScan({
    available: true,
    providers: [
      { id: "codex", methods: [] },
      { id: "codex", methods: [{ type: "oauth", label: "second", browser: true }] },
      null,
      42,
    ],
  });
  expect(scan.providers.map((provider) => provider.id)).toEqual(["codex"]);
});

test("normalizeScan is idempotent and preserves an existing browser flag", () => {
  const once = normalizeScan({
    available: true,
    providers: [{ id: "x", methods: [{ type: "oauth", label: "X (browser)", hasAuthorize: true }] }],
  });
  expect(once.providers[0].methods[0].browser).toBe(true);
  expect(once.providers[0].methods[0].category).toBe("browser");
  const twice = normalizeScan(once);
  expect(twice).toEqual(once);
});

test("anything other than a recognized scan degrades to unavailable", () => {
  for (const raw of [null, undefined, 42, {}, { available: false }, { available: true, providers: "nope" }]) {
    expect(normalizeScan(raw)).toEqual(unavailableScan());
    expect(normalizeScan(raw).available).toBe(false);
  }
});

// ---------- plugin root ----------

test("the plugin root follows MAGPIE_CONFIG_DIR, XDG_CONFIG_HOME, then ~/.config", () => {
  const scope = join("plugins", "node_modules");
  expect(pluginRootDir({ MAGPIE_CONFIG_DIR: join("/tmp", "custom") })).toBe(join("/tmp", "custom", scope));
  expect(pluginRootDir({ XDG_CONFIG_HOME: join("/tmp", "xdg") })).toBe(join("/tmp", "xdg", "magpie", scope));
  expect(pluginRootDir({})).toBe(join(homedir(), ".config", "magpie", scope));
});

// ---------- scanMagpiePlugins (injected execFile) ----------

function fakeExecFile(impl) {
  const calls = [];
  const fn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    impl(file, args, options, callback);
  };
  fn.calls = calls;
  return fn;
}

test("scanMagpiePlugins runs the runtime with -e, a timeout and the resolved root", async () => {
  const output = JSON.stringify({
    available: true,
    providers: [{ id: "cursor", package: "@x/cursor", methods: [{ type: "oauth", label: "Cursor (browser)", hasAuthorize: true }] }],
  });
  const exec = fakeExecFile((_file, _args, _options, callback) => callback(null, `${output}\n`));
  const scan = await scanMagpiePlugins({ env: { MAGPIE_CONFIG_DIR: join("/tmp", "magpie") }, execFile: exec, timeoutMs: 5000 });
  expect(scan.available).toBe(true);
  expect(scan.providers[0].methods[0]).toEqual({
    type: "oauth",
    label: "Cursor (browser)",
    browser: true,
    category: "browser",
    prompts: [],
    runnable: true,
  });
  expect(exec.calls).toHaveLength(1);
  const call = exec.calls[0];
  expect(call.args[0]).toBe("-e");
  expect(call.args[1]).toContain("CLEAN_LOGIN_PLUGIN_ROOT");
  expect(call.args[1]).not.toContain("authorize(");
  expect(call.options.timeout).toBe(5000);
  expect(call.options.killSignal).toBe("SIGKILL");
  expect(call.options.env.CLEAN_LOGIN_PLUGIN_ROOT).toBe(pluginRootDir({ MAGPIE_CONFIG_DIR: join("/tmp", "magpie") }));
  // Defect 1 regression: the child must enumerate every scope under
  // node_modules, never one hardcoded scope.
  expect(call.args[1]).not.toContain("@magpie-community");
  expect(call.args[1]).toContain("scopeDir");
});

test("scanMagpiePlugins finds providers in every scope under node_modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-login-scan-"));
  try {
    for (const [scope, pkg, id] of [
      ["@magpie-community", "pkg-a", "alpha"],
      ["@roadkid", "pkg-b", "loomy"],
    ]) {
      const p = join(dir, "plugins", "node_modules", scope, pkg);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ name: `${scope}/${pkg}`, type: "module", main: "./index.mjs" }));
      writeFileSync(
        join(p, "index.mjs"),
        `export const F = async () => ({ auth: { provider: ${JSON.stringify(id)}, methods: [{ type: "oauth", label: "Sign in with ${id} PAT", authorize: async () => {} }] } });\n`,
      );
    }
    const scan = await scanMagpiePlugins({ env: { MAGPIE_CONFIG_DIR: dir }, timeoutMs: 8000 });
    expect(scan.available).toBe(true);
    expect(scan.providers.map((provider) => provider.id).sort()).toEqual(["alpha", "loomy"]);
    const loomy = scan.providers.find((provider) => provider.id === "loomy");
    expect(loomy.package).toBe("@roadkid/pkg-b");
    expect(loomy.methods[0]).toEqual({
      type: "oauth",
      label: "Sign in with loomy PAT",
      browser: false,
      category: "pending",
      prompts: [],
      runnable: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: the per-package loop used to read `dirent`, which only exists in
// the scope loop's inner block, so a package.json WITHOUT a `name` threw a
// ReferenceError inside the child. That took the whole scan down: the parent
// saw `available:false, providers:[]`, every provider card lost its sign-in
// entry and the page showed nothing but "waiting for verification". One broken
// package may contribute zero providers; it may never fail the scan.
test("a package without a name degrades to itself, never to a failed scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-login-nameless-"));
  try {
    const root = join(dir, "plugins", "node_modules");
    const good = join(root, "@scope", "good-auth");
    mkdirSync(good, { recursive: true });
    writeFileSync(
      join(good, "package.json"),
      JSON.stringify({ name: "@scope/good-auth", type: "module", main: "./index.mjs" }),
    );
    writeFileSync(
      join(good, "index.mjs"),
      `export const F = async () => ({ auth: { provider: "good", methods: [{ type: "oauth", label: "Good (browser)", authorize: async () => {} }] } });\n`,
    );

    // A bundled build really ships a package.json without a name (for example
    // yaml/browser on the machine this bug was found on). Only the directory
    // name identifies it.
    const nameless = join(root, "badpkg", "browser");
    mkdirSync(nameless, { recursive: true });
    writeFileSync(join(nameless, "package.json"), JSON.stringify({ type: "module", main: "./index.mjs" }));
    writeFileSync(
      join(nameless, "index.mjs"),
      `export const F = async () => ({ auth: { provider: "nameless", methods: [] } });\n`,
    );

    // A factory that throws must cost its own package only, never the scan.
    const exploding = join(root, "@scope", "exploding");
    mkdirSync(exploding, { recursive: true });
    writeFileSync(
      join(exploding, "package.json"),
      JSON.stringify({ name: "@scope/exploding", type: "module", main: "./index.mjs" }),
    );
    writeFileSync(
      join(exploding, "index.mjs"),
      `export const F = async () => { throw new Error("factory exploded"); };\n`,
    );

    const scan = await scanMagpiePlugins({ env: { MAGPIE_CONFIG_DIR: dir }, timeoutMs: 15000 });
    expect(scan.available).toBe(true);
    // A successful scan carries no error at all, so nothing can be shown as a
    // failed scan.
    expect(scan.error).toBeUndefined();
    expect(scan.providers.map((provider) => provider.id).sort()).toEqual(["good", "nameless"]);
    // The nameless package falls back to its directory name, not to a crash.
    expect(scan.providers.find((provider) => provider.id === "nameless").package).toBe("browser");
    // The good provider keeps its browser method, which is what makes a card
    // signable again.
    const goodScan = scan.providers.find((provider) => provider.id === "good");
    expect(goodScan.methods[0]).toMatchObject({ type: "oauth", category: "browser", runnable: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanMagpiePlugins ignores noise and parses the marked JSON line", async () => {
  const output = JSON.stringify({ available: true, providers: [{ id: "x", methods: [] }] });
  const exec = fakeExecFile((_f, _a, _o, callback) => callback(null, `warn: something\n${output}\n`));
  const scan = await scanMagpiePlugins({ execFile: exec });
  expect(scan.providers).toEqual([{ id: "x", package: null, methods: [] }]);
});

test("a child error or timeout degrades to unavailable without throwing", async () => {
  const killed = Object.assign(new Error("Command failed: timeout"), { killed: true, signal: "SIGKILL" });
  for (const error of [new Error("boom"), killed]) {
    const exec = fakeExecFile((_f, _a, _o, callback) => callback(error));
    const scan = await scanMagpiePlugins({ execFile: exec });
    expect(scan.available).toBe(false);
    expect(scan.providers).toEqual([]);
    expect(typeof scan.error).toBe("string");
  }
});

test("unparseable child output degrades to unavailable", async () => {
  const exec = fakeExecFile((_f, _a, _o, callback) => callback(null, "not json at all"));
  const scan = await scanMagpiePlugins({ execFile: exec });
  expect(scan).toEqual(unavailableScan());
});

// ---------- createPluginScanner ----------

test("the scanner is a no-op when disabled and never calls scan", async () => {
  let calls = 0;
  const scanner = createPluginScanner({
    enabled: false,
    scan: async () => {
      calls += 1;
      return { available: true, providers: [{ id: "x", methods: [] }] };
    },
  });
  const first = scanner.get();
  expect(first).toMatchObject({ available: false, scanned: false, scanning: false });
  await scanner.refresh();
  scanner.warm();
  expect(calls).toBe(0);
});

test("the first get() starts a background scan and never blocks it", async () => {
  let clock = 1000;
  let calls = 0;
  const scanner = createPluginScanner({
    enabled: true,
    ttlMs: 60_000,
    now: () => clock,
    scan: async () => {
      calls += 1;
      return { available: true, providers: [{ id: "devin", package: "@x/devin", methods: [{ type: "oauth", label: "Devin (browser)", browser: true }] }] };
    },
  });
  const first = scanner.get();
  expect(first.scanned).toBe(false);
  expect(first.scanning).toBe(true);
  expect(scanner.get().available).toBe(false); // still no blocking result
  await scanner.refresh();
  expect(calls).toBe(1);
  const second = scanner.get();
  expect(second.available).toBe(true);
  expect(second.scanned).toBe(true);
  expect(second.stale).toBe(false);
  expect(second.providers[0].id).toBe("devin");
});

test("the TTL keeps a warm cache and refreshes only once it expires", async () => {
  let clock = 1000;
  let calls = 0;
  const scanner = createPluginScanner({
    enabled: true,
    ttlMs: 60_000,
    now: () => clock,
    scan: async () => {
      calls += 1;
      return { available: true, providers: [] };
    },
  });
  await scanner.refresh();
  expect(calls).toBe(1);
  clock = 30_000;
  expect(scanner.get().stale).toBe(false);
  expect(calls).toBe(1);
  clock = 70_000;
  expect(scanner.get().stale).toBe(true);
  await scanner.refresh();
  expect(calls).toBe(2);
});

test("a failing scan degrades to unavailable and reports its error", async () => {
  const scanner = createPluginScanner({
    enabled: true,
    scan: async () => {
      throw new Error("third-party import exploded");
    },
  });
  const result = await scanner.refresh();
  expect(result.available).toBe(false);
  const view = scanner.get();
  expect(view.available).toBe(false);
  expect(view.scanned).toBe(true);
  expect(view.error).toContain("exploded");
});

test("a scan that resolves unavailable is cached as a failure, not retried per request", async () => {
  let clock = 1000;
  let calls = 0;
  const scanner = createPluginScanner({
    enabled: true,
    ttlMs: 60_000,
    now: () => clock,
    scan: async () => {
      calls += 1;
      return unavailableScan("plugin directory missing");
    },
  });
  await scanner.refresh();
  expect(scanner.get().scanned).toBe(true);
  expect(scanner.get().stale).toBe(false);
  expect(calls).toBe(1);
  clock = 70_000;
  scanner.get();
  expect(calls).toBe(2);
});

// The default `enabled` flag is derived from NODE_ENV, so `bun test` must
// never start scanning third-party provider code on import.
test("the default scanner is disabled under the test runner", () => {
  expect(createPluginScanner().enabled).toBe(false);
});
