// One-time, plugin-owned Camoufox browser preparation.
//
// The plugin installs a self-hosted "slim" Camoufox archive (~176 MB) rather
// than the full upstream build, from a pinned release asset whose sha256 is
// verified before unpacking. camoufox@0.5.9, left alone, would download the
// larger build into a user-shared cache (%LOCALAPPDATA%\camoufox on Windows);
// this module keeps the browser in a plugin-owned directory, reports honest
// status, and runs the install as a single cancellable background job. Provider
// sign-in (a later step) launches this browser; this step only prepares it.
//
// camoufox and playwright-core are imported lazily inside defaultInstaller so
// the tests and the repository check never need node_modules.

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Measured from the self-hosted slim Windows archive: 176,170,139 bytes on the
// wire, 432,909,728 bytes unpacked (728 files), verified in the step-5
// compatibility spike (documents/2026-11-03-camoufox-bun-compatibility.md).
export const BROWSER_VERSION = "158.0.1-beta.41";
export const DOWNLOAD_BYTES = 176_170_139;
export const EXTRACTED_BYTES = 432_909_728;

// The fpgen fingerprint model, installed into the plugin's own directory beside
// the browser. MODEL_DIR_NAME is the model subdirectory under the environment
// root; MODEL_STAMP_FILE is the stamp fpgen-js writes last, after every pinned
// member has passed its sha256.
export const MODEL_DIR_NAME = "fpgen";
export const MODEL_STAMP_FILE = ".pinned-model";

// The model download is fpgen-js@1.3.0's pinned asset (pin.js MODEL_PIN.size,
// tag model-2/2026). It is a literal, not an import, because fpgen-js is loaded
// lazily (see defaultModelInstaller) and this module must evaluate with no
// node_modules; the environment test cross-checks the literal against the
// installed MODEL_PIN.size.
export const MODEL_DOWNLOAD_BYTES = 1_564_571;

// The model directory after install, measured 2026-11-03 in this machine's
// shared camoufox cache (203.2 MiB, "~204 MB"): values.dat 211,540,141 bytes +
// values.dat.zst 1,286,988 + values.json.zst 60,675 +
// fingerprint-network.json.zst 216,954 + stamp 65 = 213,104,823 bytes.
// values.dat is the decompressed bulk; the compressed members are kept beside
// it, which is why the installed size is the download plus values.dat.
export const MODEL_EXTRACTED_BYTES = 213_104_823;

export const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
export const REQUIRED_DISK_BYTES =
  DOWNLOAD_BYTES + EXTRACTED_BYTES + MODEL_DOWNLOAD_BYTES + MODEL_EXTRACTED_BYTES + DISK_MARGIN_BYTES;

// The default download is pinned to one immutable release asset and its
// published digest. defaultInstaller forces sha256 verification of the archive
// before unpacking, so a corrupted or swapped asset is refused, not installed.
export const DEFAULT_ASSET_URL =
  "https://github.com/Gruu6y/clean-login-browser/releases/download/browser-v158.0.1-beta.41-slim.1/camoufox-slim-win-x86_64-158.0.1-beta.41.zip";
export const DEFAULT_ASSET_SHA256 =
  "07bfbe8148b7b2b6a520074b6766b4aac493c6f2364e4d6af21c31b453026dd1";

export const INSTALL_RECORD_NAME = "install.json";
export const BROWSER_DIR_ENV = "MAGPIE_CLEAN_LOGIN_BROWSER_DIR";
export const BROWSER_URL_ENV = "MAGPIE_CLEAN_LOGIN_BROWSER_URL";
export const BROWSER_SHA256_ENV = "MAGPIE_CLEAN_LOGIN_BROWSER_SHA256";
export const EXECUTABLE_ENV = "CAMOUFOX_EXECUTABLE_PATH";

export const ENVIRONMENT_STATES = Object.freeze([
  "missing",
  "preparing",
  "ready",
  "error",
  "cancelled",
]);

const SAFE_ERROR_MESSAGES = Object.freeze({
  insufficient_disk: "Not enough free disk space to install the login browser.",
  installer_unavailable: "The browser runtime is not available in this installation.",
  download_failed: "The browser download failed.",
  asset_not_found: "The browser archive was not found at its download address.",
  rate_limited: "The browser host rate-limited the download.",
  extract_failed: "The browser archive could not be unpacked.",
  checksum_mismatch: "The browser archive did not match its checksum.",
  install_failed: "The browser was installed but its executable could not be located.",
  model_download_failed: "The fingerprint model download failed.",
  model_checksum_mismatch: "The fingerprint model did not match its checksum.",
  model_install_failed: "The fingerprint model could not be installed.",
  unknown: "The browser setup failed.",
});

export class EnvironmentError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "EnvironmentError";
    this.code = code;
    this.status = status;
  }
}

function cancelledError() {
  return new EnvironmentError("cancelled", "The preparation was cancelled.", 409);
}

function safeError(error) {
  if (error instanceof EnvironmentError) {
    return { code: error.code, message: error.message };
  }
  const code =
    typeof error?.code === "string" &&
    error.code in SAFE_ERROR_MESSAGES &&
    error.code !== "unknown"
      ? error.code
      : "unknown";
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

// The plugin owns its browser cache. On Windows that is under the user's local
// app data; elsewhere the XDG cache or the home cache. Tests and operators can
// point MAGPIE_CLEAN_LOGIN_BROWSER_DIR anywhere.
export function browserEnvironmentRoot(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const override = env[BROWSER_DIR_ENV];
  if (override) return resolve(override);
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || join(home, "AppData", "Local")
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : env.XDG_CACHE_HOME || join(home, ".cache");
  return join(base, "magpie-clean-login", "camoufox");
}

// The plugin-owned fpgen model directory: beside the browser, never in the
// user-shared camoufox cache.
export function fingerprintModelDir(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  return join(browserEnvironmentRoot(env, platform, home), MODEL_DIR_NAME);
}

function executableNames(platform = process.platform) {
  return platform === "win32" ? ["camoufox.exe"] : ["camoufox", "camoufox-bin"];
}

// A shallow-first search for the launcher's executable. The exact nested
// layout is camoufox's business; the plugin only needs a real file it can stat.
export async function findExecutable(dir, platform = process.platform) {
  const names = new Set(executableNames(platform));
  let frontier = [dir];
  for (let depth = 0; depth < 12 && frontier.length; depth += 1) {
    const next = [];
    for (const current of frontier) {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const directories = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directories.push(join(current, entry.name));
        } else if (entry.isFile() && names.has(entry.name)) {
          return join(current, entry.name);
        }
      }
      directories.sort();
      next.push(...directories);
    }
    frontier = next;
  }
  return null;
}

export async function directoryBytes(dir, { maxEntries = 500_000 } = {}) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen <= maxEntries) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break;
      seen += 1;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          // A vanishing file should not fail the whole status read.
        }
      }
    }
  }
  return total;
}

// fpgen-js@1.3.0's `exports` map exposes only its package root, and the root
// does not re-export `isModelInstalled` even though `dist/model.js` declares
// it. This rebuilds that test from the public MODEL_PIN contract: fpgen writes
// the stamp last, after every pinned member passed its sha256, so a matching
// stamp plus every pinned member present means an installed model.
export async function isFingerprintModelInstalled(dir, pin) {
  if (!dir || !pin || !Array.isArray(pin.files)) return false;
  let stamp;
  try {
    stamp = (await readFile(join(dir, MODEL_STAMP_FILE), "utf8")).trim();
  } catch {
    return false;
  }
  if (stamp !== pin.sha256) return false;
  for (const name of pin.files) {
    try {
      if (!(await stat(join(dir, name))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function freeSpace(dir) {
  let target = dir;
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const info = await statfs(target);
      return Number(info.bavail ?? info.bfree ?? 0) * Number(info.bsize ?? 1);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = dirname(target);
      if (!parent || parent === target) return null;
      target = parent;
    }
  }
  return null;
}

// --- the lazy real installer ------------------------------------------------

let camoufoxLoader = null;

function loadCamoufox() {
  camoufoxLoader ??= import("camoufox");
  return camoufoxLoader;
}

let fpgenLoader = null;

function loadFpgen() {
  fpgenLoader ??= import("fpgen-js");
  return fpgenLoader;
}

// Point the launcher's own install root at the plugin directory before it is
// imported: its paths are fixed at module-evaluation time. The change is
// process-local and restored once the install finishes, so the user's shared
// Camoufox cache is never written.
function redirectCamoufoxCache(dir, env, platform) {
  const previous = new Map();
  const set = (key, value) => {
    if (!previous.has(key)) previous.set(key, env[key]);
    env[key] = value;
  };
  if (platform === "win32") set("LOCALAPPDATA", dir);
  else if (platform === "darwin") set("HOME", dir);
  else set("XDG_CACHE_HOME", dir);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

// Resolve the archive the plugin will install. The default is the self-hosted
// slim build with its published digest. An operator may override the URL with
// MAGPIE_CLEAN_LOGIN_BROWSER_URL and, because a different asset's digest cannot
// be known in advance, must also supply MAGPIE_CLEAN_LOGIN_BROWSER_SHA256 to
// get verification; an override without a digest is installed unverified and
// reported as such, never as verified.
export function resolveBrowserAsset(env = process.env) {
  const override = env[BROWSER_URL_ENV];
  if (override) {
    const sha256 =
      typeof env[BROWSER_SHA256_ENV] === "string"
        ? env[BROWSER_SHA256_ENV].trim().toLowerCase()
        : "";
    return { url: override, sha256: sha256 || null, source: "override" };
  }
  return { url: DEFAULT_ASSET_URL, sha256: DEFAULT_ASSET_SHA256, source: "default" };
}

function downloadError(status) {
  if (status === 404) {
    return new EnvironmentError("asset_not_found", SAFE_ERROR_MESSAGES.asset_not_found, 404);
  }
  if (status === 429 || status === 403) {
    return new EnvironmentError("rate_limited", SAFE_ERROR_MESSAGES.rate_limited, 429);
  }
  return new EnvironmentError("download_failed", SAFE_ERROR_MESSAGES.download_failed, 502);
}

// The selected version handed to camoufox's own installer. camoufox only reads
// the fields it needs (version/build/fullString, url, sha256, sha8, interface,
// assetCreatedAt, toMetadata), so a plain object is enough and the plugin never
// has to discover releases through the rate-limited GitHub API. A truthy sha256
// makes camoufox run verifySha256() before unpacking; an absent one makes it
// skip verification, which defaultInstaller reports honestly.
function makeSelectedVersion(asset) {
  const dash = BROWSER_VERSION.indexOf("-");
  const version = {
    version: dash === -1 ? BROWSER_VERSION : BROWSER_VERSION.slice(0, dash),
    build: dash === -1 ? "release" : BROWSER_VERSION.slice(dash + 1),
    fullString: BROWSER_VERSION,
  };
  const assetCreatedAt = new Date().toISOString();
  return {
    version,
    url: asset.url,
    isPrerelease: true,
    sha256: asset.sha256 ?? undefined,
    interface: 1,
    assetCreatedAt,
    sha8: asset.sha256 ? asset.sha256.slice(0, 8) : "",
    toMetadata() {
      return {
        version: version.version,
        build: version.build,
        prerelease: true,
        asset_id: null,
        asset_size: null,
        asset_updated_at: null,
        sha256: asset.sha256 ?? null,
        created_at: assetCreatedAt,
        interface: 1,
      };
    },
  };
}

// camoufox@0.5.9 stores the digest of the asset it installed in version.json; a
// reused install is only reported as verified when that recorded digest matches
// the pinned one. Missing metadata means unverified, never assumed.
async function readRecordedSha256(executablePath) {
  let dir = dirname(executablePath);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, "version.json"), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sha256 === "string") {
        return parsed.sha256.toLowerCase();
      }
    } catch {
      // Keep walking up; the metadata may sit at the install root.
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

async function runCamoufoxInstall(camoufox, { env, onProgress, signal }) {
  const Fetcher = camoufox.CamoufoxFetcher;
  const RepoConfig = camoufox.RepoConfig;
  if (typeof Fetcher !== "function" || typeof RepoConfig !== "function") {
    throw new EnvironmentError(
      "installer_unavailable",
      "This Camoufox build does not expose its installer.",
      503,
    );
  }

  const asset = resolveBrowserAsset(env);
  // The repo config only fixes the install directory name now; release
  // discovery is bypassed because selectedVersion pins the exact asset.
  const repoConfig = new RepoConfig({
    repos: ["Gruu6y/clean-login-browser"],
    name: "msg",
    pattern: "{name}-{version}-{build}-{os}-{arch}",
    stableMin: null,
    stableMax: null,
    prereleaseMin: null,
    prereleaseMax: null,
  });

  // camoufox drives the download through the static hook
  // fetcher.constructor.downloadFile(fileStream, url), which cannot see
  // instance state. Park the job's progress callback and AbortSignal on the
  // subclass itself. Only one install job runs at a time (the manager
  // serialises them) and `this` inside the hook is always this subclass, so no
  // other job can see or clobber this handoff.
  class PluginCamoufoxFetcher extends Fetcher {
    static downloadHook = null;

    static async downloadFile(file, url) {
      const hook = this.downloadHook ?? {};
      const requestSignal = hook.signal;
      const report = hook.onProgress;
      // No credentials: the release assets are public, and sending a token to
      // the redirect target would leak it.
      const response = await fetch(
        url,
        requestSignal ? { signal: requestSignal, redirect: "follow" } : { redirect: "follow" },
      );
      if (!response.ok) throw downloadError(response.status);
      const header = Number(response.headers.get("content-length"));
      const totalBytes = Number.isFinite(header) && header > 0 ? header : undefined;
      let receivedBytes = 0;
      report?.({ receivedBytes, totalBytes });
      if (response.body) {
        for await (const chunk of response.body) {
          if (requestSignal?.aborted) throw cancelledError();
          // A sink that already failed (disk full) never drains; surface its
          // error instead of waiting on it.
          if (file.errored) throw file.errored;
          if (!file.write(chunk)) await once(file, "drain");
          receivedBytes += chunk.length;
          report?.({ receivedBytes, totalBytes });
        }
      }
      return receivedBytes;
    }
  }
  PluginCamoufoxFetcher.downloadHook = { onProgress, signal };

  try {
    const fetcher = new PluginCamoufoxFetcher(repoConfig, makeSelectedVersion(asset));
    const installed = await fetcher.install(false);
    // install() returns false when the build was already present; that path
    // never reached verifySha256, so it must not claim verification.
    return { checksumVerified: installed === true && Boolean(asset.sha256) };
  } catch (error) {
    if (error?.name === "CorruptedDownload") {
      throw new EnvironmentError(
        "checksum_mismatch",
        SAFE_ERROR_MESSAGES.checksum_mismatch,
        502,
      );
    }
    throw error;
  } finally {
    PluginCamoufoxFetcher.downloadHook = null;
  }
}

// The browser's own on-disk bytes, excluding the model directory: the model is
// reported and counted separately, and on a re-prepare it already sits under
// the same root.
async function browserDirBytes(dir) {
  const total = await directoryBytes(dir);
  const model = await directoryBytes(join(dir, MODEL_DIR_NAME));
  return Math.max(0, total - model);
}

// The default installer is the only place that imports camoufox. Tests inject a
// fake installer into the manager instead, so nothing here runs in CI.
export async function defaultInstaller({
  dir,
  env = process.env,
  platform = process.platform,
  onProgress,
  signal,
  log = () => {},
} = {}) {
  if (signal?.aborted) throw cancelledError();
  const restore = redirectCamoufoxCache(dir, env, platform);
  env.CAMOUFOX_INSTALL_DIR = dir;
  try {
    let camoufox;
    try {
      camoufox = await loadCamoufox();
    } catch {
      throw new EnvironmentError(
        "installer_unavailable",
        "The Camoufox runtime is not installed. Install the plugin's dependencies and try again.",
        503,
      );
    }
    if (signal?.aborted) throw cancelledError();

    const asset = resolveBrowserAsset(env);
    const existing = await findExecutable(dir, platform);
    if (existing) {
      // Reuse is honest about provenance: report verification only when the
      // on-disk install records the digest of a pinned asset. An override
      // without a digest records none and stays unverified.
      const recorded = await readRecordedSha256(existing);
      const checksumVerified =
        Boolean(asset.sha256) && recorded !== null && recorded === asset.sha256.toLowerCase();
      return {
        version: BROWSER_VERSION,
        executablePath: existing,
        bytes: await browserDirBytes(dir),
        checksumVerified,
      };
    }

    const result = await runCamoufoxInstall(camoufox, { env, onProgress, signal });
    if (signal?.aborted) throw cancelledError();
    const executablePath = await findExecutable(dir, platform);
    if (!executablePath) {
      throw new EnvironmentError(
        "install_failed",
        SAFE_ERROR_MESSAGES.install_failed,
        500,
      );
    }
    return {
      version: BROWSER_VERSION,
      executablePath,
      bytes: await browserDirBytes(dir),
      checksumVerified: result.checksumVerified,
    };
  } finally {
    restore();
  }
}

// Wrap fetch so the manager can report the model download's bytes. fpgen's
// ensureModel passes its own 120 s timeout; combine it with the job's signal so
// a cancel still stops the download.
function modelProgressFetch(onProgress, signal) {
  return async (url, init = {}) => {
    const timeout = init.signal ?? AbortSignal.timeout(120_000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const response = await fetch(url, { ...init, signal: combined });
    if (!response.ok || !response.body) return response;
    const header = Number(response.headers.get("content-length"));
    const totalBytes =
      Number.isFinite(header) && header > 0 ? header : MODEL_DOWNLOAD_BYTES;
    let receivedBytes = 0;
    onProgress?.({ phase: "model", receivedBytes, totalBytes });
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        receivedBytes += value.byteLength;
        onProgress?.({ phase: "model", receivedBytes, totalBytes });
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function loadFpgenOrFail() {
  try {
    return await loadFpgen();
  } catch {
    throw new EnvironmentError(
      "model_install_failed",
      SAFE_ERROR_MESSAGES.model_install_failed,
      503,
    );
  }
}

// Install the pinned fpgen model into the plugin's own directory. `fpgen` is
// injectable so tests exercise the missing/present/failed paths without a
// network.
//
// Why setModelDir explicitly: fpgen-js resolves its model directory as
// `configuredDir || FPGEN_DATA_DIR || userCacheDir("fpgen")`, and there is one
// module-level `configuredDir`. camoufox's paths.js calls setModelDir(...) while
// it is being evaluated, pointing it at its own shared cache (or at a
// camoufox-specific override when one is present), and <INSTALL_DIR> is computed
// from the real LOCALAPPDATA (or the XDG/home cache) at that same moment. So an
// environment variable alone is not enough: whatever camoufox sets at import
// wins over FPGEN_DATA_DIR, and importing camoufox inside the install's
// LOCALAPPDATA redirect and importing it outside it would resolve to two
// different directories. Setting it explicitly, immediately before
// ensureModel(), makes the install target deterministic. FPGEN_DATA_DIR is also
// set here, under its real name, as a fallback for code that reads modelDir()
// before setModelDir runs; on its own it would not beat camoufox. The forked
// browser host is handled separately: it is handed the directory as launch input
// and calls setModelDir after importing camoufox (see openSignInBrowser), so
// nothing depends on this variable surviving to the fork.
export async function defaultModelInstaller({
  dir,
  env = process.env,
  onProgress,
  signal,
  fpgen,
} = {}) {
  if (signal?.aborted) throw cancelledError();
  const model = fpgen ?? (await loadFpgenOrFail());
  const modelDir = join(dir, MODEL_DIR_NAME);
  model.setModelDir(modelDir);
  env.FPGEN_DATA_DIR = modelDir;
  const pin = model.MODEL_PIN;

  if (await isFingerprintModelInstalled(modelDir, pin)) {
    onProgress?.({
      phase: "model",
      receivedBytes: MODEL_DOWNLOAD_BYTES,
      totalBytes: MODEL_DOWNLOAD_BYTES,
    });
    return {
      modelDir,
      modelBytes: await directoryBytes(modelDir),
      modelVerified: true,
      downloaded: false,
    };
  }

  if (signal?.aborted) throw cancelledError();
  onProgress?.({ phase: "model", receivedBytes: 0, totalBytes: MODEL_DOWNLOAD_BYTES });
  try {
    await model.ensureModel({ dir: modelDir, fetchImpl: modelProgressFetch(onProgress, signal) });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw cancelledError();
    if (error?.name === "ModelVerificationError") {
      throw new EnvironmentError(
        "model_checksum_mismatch",
        SAFE_ERROR_MESSAGES.model_checksum_mismatch,
        502,
      );
    }
    throw new EnvironmentError(
      "model_download_failed",
      SAFE_ERROR_MESSAGES.model_download_failed,
      502,
    );
  }
  if (signal?.aborted) throw cancelledError();
  if (!(await isFingerprintModelInstalled(modelDir, pin))) {
    throw new EnvironmentError(
      "model_install_failed",
      SAFE_ERROR_MESSAGES.model_install_failed,
      500,
    );
  }
  onProgress?.({
    phase: "model",
    receivedBytes: MODEL_DOWNLOAD_BYTES,
    totalBytes: MODEL_DOWNLOAD_BYTES,
  });
  return {
    modelDir,
    modelBytes: await directoryBytes(modelDir),
    modelVerified: true,
    downloaded: true,
  };
}

// --- the manager ------------------------------------------------------------

export function createEnvironmentManager({
  env = process.env,
  platform = process.platform,
  root,
  installer = defaultInstaller,
  modelInstaller = defaultModelInstaller,
  freeBytes,
  now = () => new Date().toISOString(),
  idFactory = () => randomUUID(),
} = {}) {
  const dir = root ? resolve(root) : browserEnvironmentRoot(env, platform);
  const modelDir = join(dir, MODEL_DIR_NAME);
  const recordFile = join(dir, INSTALL_RECORD_NAME);

  let job = null;
  let active = null;
  let lastRun = Promise.resolve();

  async function readRecord() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(recordFile, "utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const executablePath =
      typeof parsed.executablePath === "string" && isAbsolute(parsed.executablePath)
        ? parsed.executablePath
        : null;
    if (!executablePath) return null;
    let info;
    try {
      info = await stat(executablePath);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    return {
      version: typeof parsed.version === "string" ? parsed.version : null,
      executablePath,
      bytes:
        Number.isFinite(parsed.bytes) && parsed.bytes >= 0 ? Math.round(parsed.bytes) : null,
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : null,
      checksumVerified: parsed.checksumVerified === true,
      modelDir:
        typeof parsed.modelDir === "string" && isAbsolute(parsed.modelDir)
          ? parsed.modelDir
          : null,
      modelBytes:
        Number.isFinite(parsed.modelBytes) && parsed.modelBytes >= 0
          ? Math.round(parsed.modelBytes)
          : null,
      modelVerified: parsed.modelVerified === true,
    };
  }

  async function writeRecord(result) {
    const payload = {
      version: result?.version || BROWSER_VERSION,
      executablePath: result.executablePath,
      bytes:
        Number.isFinite(result?.bytes) && result.bytes >= 0 ? Math.round(result.bytes) : null,
      installedAt: now(),
      checksumVerified: result?.checksumVerified === true,
      modelDir: result?.modelDir || null,
      modelBytes:
        Number.isFinite(result?.modelBytes) && result.modelBytes >= 0
          ? Math.round(result.modelBytes)
          : null,
      modelVerified: result?.modelVerified === true,
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${INSTALL_RECORD_NAME}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, recordFile);
  }

  function removeRecord() {
    return rm(recordFile, { force: true }).catch(() => {});
  }

  function stateOf(installed, modelInstalled) {
    if (active) return "preparing";
    if (installed && modelInstalled) return "ready";
    if (job?.state === "error") return "error";
    if (job?.state === "cancelled") return "cancelled";
    return "missing";
  }

  function publicJob() {
    if (!job) return null;
    return {
      id: job.id,
      state: job.state,
      attempt: job.attempt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: { ...job.progress },
      error: job.error ? { ...job.error } : null,
    };
  }

  async function status() {
    const record = await readRecord();
    const installed = Boolean(record);
    let installedBytes = record?.bytes ?? null;
    if (installed && installedBytes === null) installedBytes = await directoryBytes(dir);
    // The record only exists while the executable does; the model directory is
    // checked on disk too, so a deleted model reads as not-ready. The full
    // pinned sha256 check happens at install time and in the identity path.
    let modelInstalled = false;
    let modelBytes = 0;
    if (record?.modelDir) {
      try {
        modelInstalled = (await stat(record.modelDir)).isDirectory();
      } catch {
        modelInstalled = false;
      }
      if (modelInstalled) modelBytes = await directoryBytes(record.modelDir);
    }
    const free = freeBytes !== undefined ? freeBytes : await freeSpace(dir);
    return {
      state: stateOf(installed, modelInstalled),
      ready: installed && modelInstalled,
      installed,
      modelInstalled,
      target: BROWSER_VERSION,
      version: record?.version || null,
      executablePath: record?.executablePath || null,
      installDir: dir,
      modelDir: record?.modelDir || modelDir,
      downloadBytes: DOWNLOAD_BYTES + MODEL_DOWNLOAD_BYTES,
      extractedBytes: EXTRACTED_BYTES + MODEL_EXTRACTED_BYTES,
      modelDownloadBytes: MODEL_DOWNLOAD_BYTES,
      modelExtractedBytes: MODEL_EXTRACTED_BYTES,
      requiredDiskBytes: REQUIRED_DISK_BYTES,
      installedBytes: (installedBytes ?? 0) + modelBytes,
      modelBytes,
      freeBytes: free === undefined ? null : free,
      checksumVerified: installed ? Boolean(record.checksumVerified) : false,
      checksumStatus: installed && record.checksumVerified ? "verified" : "unavailable",
      modelVerified: installed && modelInstalled ? Boolean(record.modelVerified) : false,
      assetOverride: Boolean(env[BROWSER_URL_ENV]),
      githubToken: Boolean(env.GITHUB_TOKEN),
      platform,
    };
  }

  async function prepare() {
    if (active) return { started: false, job: publicJob() };

    const controller = new AbortController();
    active = { controller, job: null, starting: true };
    try {
      const free = freeBytes !== undefined ? freeBytes : await freeSpace(dir);
      if (free !== null && Number.isFinite(free) && free < REQUIRED_DISK_BYTES) {
        throw new EnvironmentError(
          "insufficient_disk",
          SAFE_ERROR_MESSAGES.insufficient_disk,
          507,
        );
      }
    } catch (error) {
      active = null;
      throw error;
    }

    const thisJob = {
      id: idFactory(),
      state: "preparing",
      attempt: (job?.attempt || 0) + 1,
      startedAt: now(),
      finishedAt: null,
      progress: { phase: "browser", receivedBytes: 0, totalBytes: DOWNLOAD_BYTES, percent: 0 },
      error: null,
    };
    job = thisJob;
    active = { controller, job: thisJob, starting: false };

    const onProgress = (progress) => {
      if (job !== thisJob || controller.signal.aborted) return;
      const phase = progress?.phase === "model" ? "model" : "browser";
      const fallbackTotal = phase === "model" ? MODEL_DOWNLOAD_BYTES : DOWNLOAD_BYTES;
      const received = Number(progress?.receivedBytes) || 0;
      const total = Number(progress?.totalBytes) || fallbackTotal;
      thisJob.progress = {
        phase,
        receivedBytes: received,
        totalBytes: total,
        percent: total ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : 0,
      };
    };

    const run = (async () => {
      // Set once the browser's executable has been validated. A model failure
      // after that must not discard a working browser install record; a
      // browser failure before it leaves no half-written record behind.
      let browserValidated = false;
      try {
        const result = await installer({
          dir,
          env,
          platform,
          onProgress,
          signal: controller.signal,
          log: () => {},
        });
        if (controller.signal.aborted) throw cancelledError();
        if (!result?.executablePath) {
          throw new EnvironmentError("install_failed", SAFE_ERROR_MESSAGES.install_failed, 500);
        }
        let info;
        try {
          info = await stat(result.executablePath);
        } catch {
          info = null;
        }
        if (!info?.isFile()) {
          throw new EnvironmentError("install_failed", SAFE_ERROR_MESSAGES.install_failed, 500);
        }
        browserValidated = true;

        // The model is a second stage of the same one-time preparation. Its
        // failure is classified under its own codes, never as a browser
        // download failure.
        const model = await modelInstaller({
          dir,
          env,
          platform,
          onProgress,
          signal: controller.signal,
          log: () => {},
        });
        if (controller.signal.aborted) throw cancelledError();
        if (!model?.modelDir) {
          throw new EnvironmentError(
            "model_install_failed",
            SAFE_ERROR_MESSAGES.model_install_failed,
            500,
          );
        }
        let modelInfo;
        try {
          modelInfo = await stat(model.modelDir);
        } catch {
          modelInfo = null;
        }
        if (!modelInfo?.isDirectory()) {
          throw new EnvironmentError(
            "model_install_failed",
            SAFE_ERROR_MESSAGES.model_install_failed,
            500,
          );
        }

        if (job !== thisJob) return;
        await writeRecord({
          ...result,
          modelDir: model.modelDir,
          modelBytes: model.modelBytes,
          modelVerified: model.modelVerified === true,
        });
        thisJob.state = "ready";
        thisJob.error = null;
        env[EXECUTABLE_ENV] = result.executablePath;
      } catch (error) {
        const cancelled =
          controller.signal.aborted ||
          error?.code === "cancelled" ||
          error?.name === "AbortError";
        if (job === thisJob) {
          if (!browserValidated) await removeRecord();
          thisJob.state = cancelled ? "cancelled" : "error";
          thisJob.error = cancelled ? null : safeError(error);
        }
      } finally {
        if (job === thisJob) thisJob.finishedAt = now();
        if (active?.controller === controller) active = null;
      }
    })();
    lastRun = run;
    active.promise = run;
    return { started: true, job: publicJob() };
  }

  function cancel() {
    if (!active || active.starting) return { cancelled: false, job: publicJob() };
    const { controller, job: running } = active;
    controller.abort();
    if (running) {
      running.state = "cancelled";
      running.finishedAt = now();
      running.error = null;
    }
    active = null;
    return { cancelled: true, job: publicJob() };
  }

  return {
    dir,
    status,
    job: publicJob,
    prepare,
    cancel,
    // Waits for the most recent prepare run. Used by tests; harmless in prod.
    whenSettled: () => lastRun,
  };
}
