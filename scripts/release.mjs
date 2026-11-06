// One-command release for a plugin magpie can see.
//
//   node scripts/release.mjs --patch             bump patch, commit, tag
//   node scripts/release.mjs --minor             bump minor, commit, tag
//   node scripts/release.mjs 0.2.0               use an explicit version
//   node scripts/release.mjs --patch --dry-run   preview only
//   node scripts/release.mjs --patch --push      also push the commit and tag
//
// It changes only package.json's `version`, commits it as `x.y.z: <message>`
// and creates the tag `vx.y.z`. It never writes a CHANGELOG, never pushes
// unless --push is given, and never sweeps unrelated working-tree changes into
// the release commit. Before touching package.json it fetches origin main and
// refuses to release when the branch is missing commits from it: that would only
// surface later as a rejected push, after the commit and tag already exist.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function gitText(args, { allowFail = false } = {}) {
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

function gitRun(args) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "inherit", windowsHide: true });
  } catch {
    throw new Error(`git ${args.join(" ")} failed`);
  }
}

function fail(message, code = 1) {
  console.error(`[release] ${message}`);
  process.exit(code);
}

function usage() {
  console.error("usage: node scripts/release.mjs (--patch | --minor | <x.y.z>) [options]");
  console.error("  --dry-run          print the plan; write nothing, commit nothing, tag nothing");
  console.error("  --push             push the release commit and tag to origin (default: no push)");
  console.error("  -m, --message <s>  commit subject after the version (default: release)");
}

const argv = process.argv.slice(2);
let bump = null;
let explicit = null;
let message = "release";
let dryRun = false;
let push = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--patch" || arg === "--minor") {
    if (bump || explicit) fail("choose exactly one of --patch, --minor or an explicit version");
    bump = arg.slice(2);
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--push") {
    push = true;
  } else if (arg === "--message" || arg === "-m") {
    const value = argv[index + 1];
    if (!value) fail(`${arg} needs a value`);
    message = value;
    index += 1;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    usage();
    fail(`unknown option ${arg}`, 2);
  } else {
    if (bump || explicit) fail("choose exactly one of --patch, --minor or an explicit version");
    explicit = arg;
  }
}

if (!bump && !explicit) {
  usage();
  fail("choose --patch, --minor or an explicit version", 2);
}
if (explicit && !SEMVER.test(explicit)) fail(`"${explicit}" is not a valid x.y.z version`, 2);

let top;
try {
  top = gitText(["rev-parse", "--show-toplevel"]);
} catch {
  fail("not inside a git repository");
}
if (resolve(top) !== root) fail(`script repository ${root} is not the git repository ${top}`);

const branch = gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch === "HEAD") fail("detached HEAD: check out the release branch first");

const pkgPath = resolve(root, "package.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (error) {
  fail(`cannot read package.json: ${error?.message ?? error}`, 2);
}
const current = typeof manifest?.version === "string" ? manifest.version : "";
const currentParts = SEMVER.exec(current);
if (!currentParts) fail(`current package.json version "${current}" is not a valid x.y.z version`, 2);

if (gitText(["status", "--porcelain", "--", "package.json"])) {
  fail("package.json has uncommitted changes; commit or stash them before releasing");
}

// A release is only safe when the remote main is already in this branch's
// history. Checking that here means a stale branch fails before package.json is
// touched, instead of after the commit and tag exist and the push is rejected as
// non-fast-forward -- which leaves a local release nobody wants and a tag that
// blocks the retry. This never pulls or rebases: a conflict is impossible to
// predict, so that decision stays with whoever runs the release.
function remoteMainTip() {
  // Best effort only. Offline, a missing origin or a remote without main must
  // not stop a release that may be perfectly fine.
  const fetched = gitText(["fetch", "--no-tags", "origin", "main"], { allowFail: true });
  if (fetched !== null) {
    // FETCH_HEAD is what this fetch actually returned, so it cannot be stale the
    // way a cached origin/main ref can be after a failed fetch.
    const tip = gitText(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], {
      allowFail: true,
    });
    if (tip) return { commit: tip, label: "origin main (fetched)" };
  }
  const cached = gitText(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"], {
    allowFail: true,
  });
  if (cached) return { commit: cached, label: "origin/main (cached)" };
  return null;
}

const remote = remoteMainTip();
if (!remote) {
  console.warn(
    "[release] warning: cannot resolve origin/main (no origin remote, or the fetch failed); " +
      "skipping the remote preflight.",
  );
} else if (
  gitText(["merge-base", "--is-ancestor", remote.commit, "HEAD"], { allowFail: true }) === null
) {
  console.error(
    `[release] FAIL: ${remote.label} ${remote.commit.slice(0, 12)} has commits that are not in ${branch}.`,
  );
  console.error(
    `[release] Nothing has been written yet: package.json version is still ${current},`,
  );
  console.error("[release] no release commit was created and no tag was created.");
  console.error("[release] Pushing now would be rejected as non-fast-forward. Rebase onto the");
  console.error("[release] remote first (this script never pulls or rebases for you):");
  console.error("[release]   git pull --rebase origin main");
  console.error("[release]   node scripts/release.mjs --patch   # or the same arguments again");
  process.exit(1);
} else {
  console.log(
    `[release] remote : ${remote.label} ${remote.commit.slice(0, 12)} is in HEAD's history.`,
  );
}

let next;
if (bump === "minor") {
  next = `${Number(currentParts[1])}.${Number(currentParts[2]) + 1}.0`;
} else if (bump === "patch") {
  next = `${Number(currentParts[1])}.${Number(currentParts[2])}.${Number(currentParts[3]) + 1}`;
} else {
  next = explicit;
}

const currentRank = [Number(currentParts[1]), Number(currentParts[2]), Number(currentParts[3])];
const nextParts = SEMVER.exec(next);
const nextRank = [Number(nextParts[1]), Number(nextParts[2]), Number(nextParts[3])];
const comparison =
  nextRank[0] - currentRank[0] || nextRank[1] - currentRank[1] || nextRank[2] - currentRank[2];
if (comparison <= 0) {
  fail(`next version ${next} must be greater than the current ${current}`);
}

const tag = `v${next}`;
if (gitText(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { allowFail: true })) {
  fail(`tag ${tag} already exists`);
}

const subject = `${next}: ${message}`;
console.log(`[release] branch : ${branch}`);
console.log(`[release] version: ${current} -> ${next}`);
console.log(`[release] commit : ${subject}`);
console.log(`[release] tag    : ${tag}`);
console.log(`[release] push   : ${push ? "yes (origin)" : "no (default; pass --push to push)"}`);

if (dryRun) {
  console.log("[release] dry run: nothing was written, committed, tagged or pushed.");
  process.exit(0);
}

// Replace only the version value, not the whole file: JSON.stringify would
// reformat inline arrays and make the release commit look bigger than it is.
const manifestText = readFileSync(pkgPath, "utf8");
const versionPattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
if (!versionPattern.test(manifestText)) {
  fail("cannot locate the top-level version string in package.json", 2);
}
writeFileSync(pkgPath, manifestText.replace(versionPattern, `$1${next}$2`));
console.log(`[release] wrote ${pkgPath}`);

try {
  gitRun(["add", "--", "package.json"]);
  gitRun(["commit", "-m", subject, "--", "package.json"]);
} catch (error) {
  fail(`${error.message}; package.json is now bumped but not committed`);
}

try {
  gitRun(["tag", "-a", tag, "-m", tag]);
} catch (error) {
  fail(`${error.message}; the release commit exists but the tag does not`);
}
console.log(`[release] created commit and tag ${tag}`);

if (push) {
  try {
    gitRun(["push", "origin", `HEAD:${branch}`]);
    gitRun(["push", "origin", `refs/tags/${tag}`]);
  } catch (error) {
    fail(
      `${error.message}; the local commit and tag exist but the push did not finish. ` +
        "Recover with:\n" +
        "  git pull --rebase\n" +
        `  git push origin ${branch}\n` +
        `  git push origin ${tag}`,
    );
  }
  console.log(`[release] pushed ${branch} and ${tag} to origin`);
} else {
  console.log(`[release] not pushed; run: git push origin ${branch} && git push origin ${tag}`);
}
