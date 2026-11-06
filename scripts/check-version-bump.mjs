// Release gate: magpie decides whether a plugin has a new version by comparing
// the `version` string in package.json. A shipped-code change that keeps the
// old version is invisible to users, so this gate fails when this branch
// touches lib/, ui/, page/ or index.mjs without changing that string.
//
//   node scripts/check-version-bump.mjs [--base <git-ref>]
//
// The base ref comes from --base, then BASE_REF, then GITHUB_BASE_SHA, then
// origin/$GITHUB_BASE_REF, then origin/main. If the checkout is shallow and the
// base is missing, the script fetches that one ref; if it still cannot be
// resolved (for example the first push to a new repository), the gate says so
// and skips instead of inventing a failure.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_PATTERNS = [/^lib\//, /^ui\//, /^page\//, /^index\.mjs$/];
const ZERO_SHA = /^0+$/;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    const detail = String(error?.stderr ?? error?.message ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`[version-check] ${name} needs a value.`);
    process.exit(2);
  }
  return value;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: node scripts/check-version-bump.mjs [--base <git-ref>]");
  process.exit(0);
}

const baseRef =
  option("--base") ||
  process.env.BASE_REF ||
  process.env.GITHUB_BASE_SHA ||
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");

function resolveCommit(ref) {
  if (!ref || ZERO_SHA.test(ref)) return null;
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) || null;
}

// Fetch only the one base ref: a shallow CI checkout is the normal case this
// has to survive. A branch name is tried first, then the ref as given, which
// covers a pull request's base SHA.
function fetchBase(ref) {
  if (!ref || ZERO_SHA.test(ref)) return null;
  const branch = ref.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  const candidates = [];
  if (branch && !/^[0-9a-f]{7,40}$/i.test(branch)) candidates.push(branch);
  candidates.push(ref);
  for (const candidate of candidates) {
    if (git(["fetch", "--no-tags", "--depth=1", "origin", candidate], { allowFail: true }) === null) {
      continue;
    }
    const commit = resolveCommit("FETCH_HEAD");
    if (commit) return commit;
  }
  return null;
}

let baseCommit = resolveCommit(baseRef);
if (!baseCommit) {
  console.log(`[version-check] base "${baseRef}" is not in this checkout; fetching it from origin...`);
  baseCommit = fetchBase(baseRef);
}
if (!baseCommit) {
  console.warn(
    `[version-check] cannot resolve base "${baseRef}"; skipping the version gate ` +
      "(there is nothing to compare against).",
  );
  process.exit(0);
}

// Compare against the common ancestor, not the base tip: changes main gained
// after this branch diverged are not part of this change and must not make a
// missing bump look acceptable.
function commonAncestor(base) {
  return git(["merge-base", base, "HEAD"], { allowFail: true }) || null;
}

let compare = commonAncestor(baseCommit);
if (!compare) {
  // A depth-1 checkout has the base commit but not the ancestor it shares with
  // HEAD. Deepen once and retry; if that is impossible, compare from the base
  // commit itself rather than skipping the gate.
  git(["fetch", "--no-tags", "--unshallow", "origin"], { allowFail: true });
  compare = commonAncestor(baseCommit) || baseCommit;
}

const changed = new Set(
  git(["diff", "--no-renames", "--name-only", compare, "--"])
    .split("\n")
    .filter(Boolean),
);
// `git diff` does not list untracked files; a new lib/ file must count too.
const untracked = git(["ls-files", "--others", "--exclude-standard"], { allowFail: true }) || "";
for (const file of untracked.split("\n").filter(Boolean)) changed.add(file);

const files = [...changed].map((file) => file.replaceAll("\\", "/"));
const relevant = files
  .filter((file) => RELEASE_PATTERNS.some((pattern) => pattern.test(file)))
  .sort();

let manifest;
try {
  manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
} catch (error) {
  console.error(`[version-check] cannot read package.json: ${error?.message ?? error}`);
  process.exit(2);
}
const current = typeof manifest?.version === "string" ? manifest.version : "";

function versionAt(commit) {
  const raw = git(["show", `${commit}:package.json`], { allowFail: true });
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

const baseVersion = versionAt(compare);

if (!current) {
  console.error("[version-check] package.json has no version string; cannot release this change.");
  process.exit(2);
}

if (!baseVersion) {
  console.log(
    `[version-check] base commit ${compare.slice(0, 12)} has no package.json version; ` +
      "treating this as a first release and passing.",
  );
  process.exit(0);
}

if (relevant.length === 0) {
  console.log(
    "[version-check] no release-relevant files changed (lib/, ui/, page/, index.mjs); " +
      "a version bump is not required.",
  );
  process.exit(0);
}

if (current !== baseVersion) {
  console.log(
    `[version-check] OK: ${relevant.length} release-relevant file(s) changed; ` +
      `package.json version ${baseVersion} -> ${current}.`,
  );
  process.exit(0);
}

console.error(
  `[version-check] FAIL: release-relevant files changed but package.json version is still ${current} ` +
    `(base ${compare.slice(0, 12)} has ${baseVersion}).`,
);
for (const file of relevant) console.error(`  changed: ${file}`);
console.error("");
console.error('magpie decides whether a plugin has an update by comparing the package.json "version"');
console.error("string. Users will not see this update until the version is bumped.");
console.error("Bump it with `node scripts/release.mjs --patch` (or --minor / an explicit version).");
process.exit(1);
