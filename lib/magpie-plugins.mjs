// Second provider-derivation layer: the sign-in methods exposed by the
// provider plugins magpie has actually installed.
//
// magpie keeps installed plugins under
//   <MAGPIE_CONFIG_DIR>/plugins/node_modules/<scope>/<package>/
// and EVERY npm scope there is scanned, not a single hardcoded scope, because
// an installed provider can ship under any scope (for example @roadkid). A
// missing node_modules, a missing scope, or a scope with no provider package
// is tolerated and simply contributes nothing.
//
// Each provider package's entry module exports a factory (or several).
// Calling a factory with a minimal stub returns `{ hook }`-style hooks whose
// `auth` field is `{ provider, methods[] }`. That is the only authoritative
// source for how a provider signs in, so this module reads it.
//
// This is third-party code: importing it can be slow and a single hung plugin
// import cannot be interrupted inside this process. Everything therefore runs
// in a child process with a hard timeout, and any failure degrades to
// `{ available: false, providers: [] }`. The scan never rejects and it is
// never allowed to break a request.
//
// Nothing here calls a method's `authorize` function. Only its presence and
// the method's own declared fields (label, type, prompts) are inspected, never
// invoked.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { magpieConfigDir } from "./paths.mjs";

// Labels that describe re-using a sign-in the user already has on this machine
// (the desktop app, the vendor's CLI, a local session) rather than opening a
// browser.
export const LOCAL_HINT = /'s sign-in|desktop|\bCLI\b|桌面端|本地/i;

// Labels that explicitly name a browser/web sign-in. Only these turn an oauth
// method that carries an authorize function into `browser`. An ambiguous oauth
// method (a device code, a PAT form, an enterprise VPC flow) is NOT forced
// into `browser`; it is reported as `pending` (runnable, kind unconfirmed)
// instead of guessing.
export const BROWSER_HINT = /\(browser\)|网页登录|浏览器登录|授权页|官方授权页|browser sign[ -]?in|browser login/i;

// Prompt field types that require the user to type something. Their presence in
// an oauth method's `prompts` is evidence of a form the user must fill in (for
// example Kiro's Start URL and region) rather than a flow that opens a browser
// by itself. A `select` alone is NOT enough: ZCode's team method asks the user
// to pick a site and is still a browser sign-in.
const INPUT_PROMPT_TYPES = new Set(["text", "password"]);

// Prompt field types that carry a secret the user pastes in (a PAT, a token).
// Their method is a paste-a-key flow, not a fill-in form.
const SECRET_PROMPT_TYPES = new Set(["password"]);

// The categories a method can carry.
//
//   browser  a known browser sign-in (the label names it)
//   form     a method the user must fill in before it can proceed
//   secret   a method that asks for a pasted secret (a PAT or a token)
//   local    a local-session reuse (the desktop app, the vendor CLI)
//   key      the vendor's API-key type
//   pending  an oauth method with a real authorize function whose kind is
//            only revealed when authorize() runs (a device code, a browser
//            page). NOT "unknown": the method exists and is runnable, only its
//            kind is unconfirmed. The real kind is reported at sign-in time by
//            lib/signin-flow.mjs's classifyAuthorizedFlow().
//   unknown  nothing classifiable at all (no authorize function, or a type the
//            scan does not know)
export const METHOD_CATEGORIES = Object.freeze([
  "browser",
  "form",
  "key",
  "local",
  "pending",
  "secret",
  "unknown",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Project a method's `prompts` into a bounded, public-safe shape: only the
// field type, its key, its message and its options' label/value. Defaults,
// placeholders, entered values and validate/transform functions are dropped, so
// no user input, function or secret can travel into an API response. Pure and
// idempotent, so re-projecting an already-projected array is a no-op.
export function projectPrompts(prompts) {
  if (!Array.isArray(prompts)) return [];
  return prompts.filter(isPlainObject).map((prompt) => ({
    type: typeof prompt.type === "string" ? prompt.type : "",
    key: typeof prompt.key === "string" ? prompt.key : "",
    message: typeof prompt.message === "string" ? prompt.message : "",
    options: Array.isArray(prompt.options)
      ? prompt.options.filter(isPlainObject).map((option) => ({
          label: typeof option.label === "string" ? option.label : "",
          value: typeof option.value === "string" ? option.value : "",
        }))
      : [],
  }));
}

// True when the projected prompts contain a field the user must type into. Used
// by the scan to tell "needs a form" from "just opens a browser".
export function requiresFormInput(prompts) {
  return projectPrompts(prompts).some((prompt) => INPUT_PROMPT_TYPES.has(prompt.type));
}

// True when the projected prompts carry a secret the user pastes in (a PAT or a
// token). Such a method is a paste-a-key flow, which the card names apart from
// a plain fill-in form.
export function requiresSecretInput(prompts) {
  return projectPrompts(prompts).some((prompt) => SECRET_PROMPT_TYPES.has(prompt.type));
}

// Pure, unit-testable classifier for one method. It returns one of the
// categories in METHOD_CATEGORIES:
//
//   local   label matches LOCAL_HINT: it reuses the desktop app's, the
//           vendor CLI's or another local sign-in, so it is not a browser flow.
//   browser oauth + an authorize function + a label that explicitly names a
//           browser/web sign-in (BROWSER_HINT).
//   secret  oauth + an authorize function + a prompt that asks for a secret
//           the user pastes in (a PAT or a token).
//   form    oauth + an authorize function + prompts that ask the user to type
//           something else (for example Kiro's Start URL/region), so a form must
//           be filled before the flow can proceed.
//   key     the vendor's API-key type (type "api" or "key").
//   pending oauth + an authorize function whose label names no kind. The
//           method IS runnable; only its kind is unconfirmed, because the
//           plugin reveals it in authorize()'s return value. The scan never
//           calls authorize(), so it says "pending" rather than guessing
//           "browser" and rather than claiming "nothing was found".
//   unknown everything else.
//
// `browser` stays a boolean for existing consumers and is true exactly when
// the category is "browser". `hasAuthorize` may be passed as a boolean (the
// shape the child process prints), as the `runnable` flag (the shape the scan
// publishes) or as the real function (when a plugin module is inspected
// directly in a test). The returned object also carries the public-safe
// `prompts` projection; no function or entered value ever survives it.
export function classifyMethod(method = {}) {
  const type = typeof method?.type === "string" ? method.type : "";
  const label = typeof method?.label === "string" ? method.label : "";
  const hasAuthorize =
    method?.hasAuthorize === true || method?.runnable === true || typeof method?.authorize === "function";
  const prompts = projectPrompts(method?.prompts);
  let category;
  if (LOCAL_HINT.test(label)) category = "local";
  else if (type === "oauth" && hasAuthorize && BROWSER_HINT.test(label)) category = "browser";
  else if (type === "oauth" && hasAuthorize && requiresSecretInput(prompts)) category = "secret";
  else if (type === "oauth" && hasAuthorize && requiresFormInput(prompts)) category = "form";
  else if (type === "api" || type === "key") category = "key";
  else if (type === "oauth" && hasAuthorize) category = "pending";
  else category = "unknown";
  return { type, label, browser: category === "browser", category, prompts, runnable: hasAuthorize };
}

// The shape every failure degrades to. `error` is a short diagnostic string
// only; it is never rendered verbatim as provider content.
export function unavailableScan(error = null) {
  return { available: false, providers: [], error: error || null };
}

function normalizeMethod(method) {
  // Already-classified methods (from a previous scan or from an injected
  // fixture) pass through untouched so re-normalizing is idempotent.
  if (method && typeof method === "object" && typeof method.browser === "boolean") {
    const prompts = projectPrompts(method.prompts);
    const runnable = method.runnable === true || method.hasAuthorize === true;
    return {
      type: typeof method.type === "string" ? method.type : "",
      label: typeof method.label === "string" ? method.label : "",
      browser: method.browser,
      // Fixtures may carry only the legacy boolean; keep a typed category so
      // re-normalizing an already-normalized scan stays idempotent.
      category:
        typeof method.category === "string" && method.category
          ? method.category
          : method.browser
            ? "browser"
            : requiresSecretInput(prompts)
              ? "secret"
              : requiresFormInput(prompts)
                ? "form"
                : type === "api" || type === "key"
                  ? "key"
                  : runnable
                    ? "pending"
                    : "unknown",
      prompts,
      runnable,
    };
  }
  return classifyMethod(method);
}

// Accepts anything and returns the public-safe scan shape. Never throws and
// never carries a function or an unbounded field into the API response.
export function normalizeScan(raw) {
  if (!raw || typeof raw !== "object" || raw.available !== true || !Array.isArray(raw.providers)) {
    return unavailableScan(typeof raw?.error === "string" ? raw.error : null);
  }
  const seen = new Set();
  const providers = [];
  for (const entry of raw.providers) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    const methods = Array.isArray(entry.methods)
      ? entry.methods.map(normalizeMethod)
      : [];
    providers.push({
      id,
      package: typeof entry.package === "string" && entry.package ? entry.package : null,
      methods,
    });
  }
  return { available: true, providers };
}

// Where magpie's installed plugin packages live. Derived from the same config
// directory resolution the rest of the plugin uses, so an override of
// MAGPIE_CONFIG_DIR / XDG_CONFIG_HOME keeps working. This is the shared
// `node_modules`; the child enumerates every scope inside it.
export function pluginRootDir(env = process.env) {
  return join(magpieConfigDir(env), "plugins", "node_modules");
}

// The child program. It is passed to the runtime with `-e`, scans every npm
// scope under node_modules, calls each exported factory with a stub, and
// prints one JSON line. It must never import anything from magpie and must
// never call `authorize`. The parent relies on `{"available":` so only that
// line is parsed back.
const CHILD_SOURCE = String.raw`
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.CLEAN_LOGIN_PLUGIN_ROOT || "";
const client = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
  config: { get: async () => ({ data: {} }) },
};
const providers = [];

function emit(payload) {
  const text = JSON.stringify(payload);
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

try {
  const rootEntries = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [];
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    if (seen.has(dir) || !existsSync(join(dir, "package.json"))) return;
    seen.add(dir);
    dirs.push(dir);
  };
  // Unscoped plugins are declared in <plugins>/package.json; node_modules also
  // holds hundreds of ordinary dependencies, so only the declared ones are
  // candidates. Scopes are still enumerated wholesale, because a plugin can be
  // installed under any npm scope.
  try {
    const manifest = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));
    for (const name of Object.keys(manifest?.dependencies || {})) push(join(root, name));
  } catch { /* no manifest: scoped packages only */ }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const scopeDir = join(root, entry.name);
    // A directory with its own package.json is an unscoped package, covered
    // above when it is declared.
    if (existsSync(join(scopeDir, "package.json"))) continue;
    const inner = existsSync(scopeDir) ? readdirSync(scopeDir, { withFileTypes: true }) : [];
    for (const dirent of inner) {
      if (dirent.isDirectory()) push(join(scopeDir, dirent.name));
    }
  }
  for (const dir of dirs) {
    // One broken package may contribute zero providers; it may never fail the
    // scan. Reading a package.json, importing its entry and calling its
    // factories are all third-party work and all live inside this try, so a
    // nameless manifest, a module that throws on import or a factory that
    // throws costs exactly one package.
    try {
      const pkgFile = join(dir, "package.json");
      if (!existsSync(pkgFile)) continue;
      let pkg = null;
      try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); } catch { continue; }
      // A manifest without a name is legal (a bundled browser build ships one),
      // so fall back to the directory name. Do NOT reach for dirent here: it
      // only exists inside the scope loop above, and reading it threw a
      // ReferenceError that took the whole scan down.
      const packageName =
        typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(dir);
      const entry = typeof pkg?.main === "string" && pkg.main ? pkg.main : "index.mjs";
      const mainFile = join(dir, entry);
      if (!existsSync(mainFile)) continue;
      let mod = null;
      try { mod = await import(pathToFileURL(mainFile).href); } catch { continue; }
      for (const key of Object.keys(mod)) {
        const factory = mod[key];
        if (typeof factory !== "function") continue;
        let hooks = null;
        try {
          hooks = await factory({
            client,
            directory: process.cwd(),
            worktree: process.cwd(),
            project: {},
            magpie: undefined,
          });
        } catch { continue; }
        const auth = hooks && hooks.auth;
        if (!auth || typeof auth.provider !== "string" || !auth.provider) continue;
        const list = Array.isArray(auth.methods) ? auth.methods : [];
        providers.push({
          id: auth.provider,
          package: packageName,
          methods: list.map((method) => ({
            type: typeof method?.type === "string" ? method.type : "",
            label: typeof method?.label === "string" ? method.label : "",
            // Whether the method really carries an authorize function. The scan
            // never calls it; it only sees that it is there, and that is what
            // makes the method runnable at sign-in time.
            runnable: typeof method?.authorize === "function",
            prompts: Array.isArray(method?.prompts)
              ? method.prompts.map((prompt) => ({
                  type: typeof prompt?.type === "string" ? prompt.type : "",
                  key: typeof prompt?.key === "string" ? prompt.key : "",
                  message: typeof prompt?.message === "string" ? prompt.message : "",
                  options: Array.isArray(prompt?.options)
                    ? prompt.options.map((option) => ({
                        label: typeof option?.label === "string" ? option.label : "",
                        value: typeof option?.value === "string" ? option.value : "",
                      }))
                    : [],
                }))
              : [],
          })),
        });
      }
    } catch { continue; }
  }
  await emit({ available: true, providers });
} catch (error) {
  await emit({ available: false, providers: [], error: String((error && error.message) || error) });
}
process.exit(0);
`;

function parseScanOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "available" in parsed) return parsed;
    } catch {
      // Not the scan line; keep looking upward.
    }
  }
  return null;
}

// Run the child and return the normalized scan. `execFileImpl` is injectable
// so tests never spawn the real runtime and never import a provider plugin.
export async function scanMagpiePlugins({
  env = process.env,
  execFile: execFileImpl = execFile,
  execPath = process.execPath,
  timeoutMs = 8000,
} = {}) {
  const root = pluginRootDir(env);
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFileImpl(
        execPath,
        ["-e", CHILD_SOURCE],
        {
          env: { ...env, CLEAN_LOGIN_PLUGIN_ROOT: root },
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, out) => {
          if (error) reject(error);
          else resolve(out);
        },
      );
    });
    return normalizeScan(parseScanOutput(stdout));
  } catch (error) {
    return unavailableScan(String((error && error.message) || error));
  }
}

// Scan cache with a TTL, designed so no request path ever waits on the child.
//
//   get()     returns the last known scan immediately, kicking off a
//             background refresh when the TTL has expired. It never throws.
//   refresh() runs a scan now and resolves with its result.
//   warm()    non-blocking hint used once at startup.
//
// `enabled: false` (also implied by NODE_ENV=test) makes every access a
// no-op unavailable result, so test suites and CI never import third-party
// provider code.
export function createPluginScanner({
  scan = scanMagpiePlugins,
  ttlMs = 60_000,
  enabled = typeof process !== "undefined" && process.env
    ? process.env.NODE_ENV !== "test"
    : true,
  now = () => Date.now(),
} = {}) {
  let cache = null;
  let scannedAt = 0;
  let inflight = null;

  const fresh = () => scannedAt > 0 && now() - scannedAt < ttlMs;

  function snapshot(scanning) {
    return {
      available: Boolean(cache && cache.available),
      providers: cache && Array.isArray(cache.providers) ? cache.providers : [],
      scanned: scannedAt > 0,
      stale: !fresh(),
      scanning: Boolean(scanning),
      error: cache && cache.error ? cache.error : null,
    };
  }

  function refresh() {
    if (!enabled) return Promise.resolve(unavailableScan());
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await scan();
        cache = normalizeScan(result);
      } catch (error) {
        cache = unavailableScan(String((error && error.message) || error));
      } finally {
        scannedAt = now();
        inflight = null;
      }
      return cache;
    })();
    return inflight;
  }

  function get() {
    if (!enabled) return { ...unavailableScan(), scanned: false, stale: false, scanning: false };
    if (!fresh() && !inflight) refresh();
    return snapshot(Boolean(inflight));
  }

  function warm() {
    if (!enabled || fresh() || inflight) return;
    refresh();
  }

  return { get, refresh, warm, enabled };
}
