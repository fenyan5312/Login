// The release script must refuse to bump a branch whose remote main has moved
// on: the old behaviour bumped, committed and tagged first and only then had the
// push rejected as non-fast-forward, leaving a local release nobody wanted and a
// tag that blocked the retry.
//
// These tests build real git repositories in a temp directory and run the real
// script against a real (bare) origin. Nothing is mocked, so an assertion like
// "package.json is still 0.1.0" really means the file on disk did not change.

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const scriptSource = join(repoRoot, "scripts", "release.mjs");

const TEST_NAME = "Release Preflight Test";
const TEST_EMAIL = "release-preflight@example.test";

// CI (ubuntu) and a fresh WSL checkout have no git identity configured, and a
// commit made here must never borrow the host's. Our own git calls get the
// identity through -c; the script the tests spawn gets it through the
// GIT_AUTHOR_*/GIT_COMMITTER_* environment variables instead.
const GIT_CONFIG = [
  "-c",
  `user.name=${TEST_NAME}`,
  "-c",
  `user.email=${TEST_EMAIL}`,
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: TEST_NAME,
  GIT_AUTHOR_EMAIL: TEST_EMAIL,
  GIT_COMMITTER_NAME: TEST_NAME,
  GIT_COMMITTER_EMAIL: TEST_EMAIL,
  GIT_TERMINAL_PROMPT: "0",
};

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function git(cwd, args) {
  return execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A checkout of this repository's release script, one commit deep, pushing to a
// bare origin. The script infers the repository root from its own location, so
// it has to live inside the temp repository.
function makeRepository() {
  const base = makeTempDir("clean-login-release-preflight-");
  const remote = join(base, "origin.git");
  const work = join(base, "work");
  mkdirSync(work);

  git(base, ["init", "--bare", remote]);
  git(work, ["init"]);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "x", version: "0.1.0" }, null, 2)}\n`);
  mkdirSync(join(work, "scripts"));
  copyFileSync(scriptSource, join(work, "scripts", "release.mjs"));
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "initial"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "HEAD:refs/heads/main"]);
  // Point the bare origin's HEAD at main so a later clone checks out a branch.
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(work, ["fetch", "origin"]);
  git(work, ["branch", "--set-upstream-to=origin/main"]);

  return { base, remote, work };
}

// A second, independent clone moves the remote ahead -- another release landing
// on main while this branch sat idle.
function pushFromAnotherClone(base, remote, file, text) {
  const other = join(base, "other");
  git(base, ["clone", remote, other]);
  writeFileSync(join(other, file), text);
  git(other, ["add", "."]);
  git(other, ["commit", "-m", "someone else released"]);
  git(other, ["push", "origin", "HEAD:refs/heads/main"]);
  return other;
}

function runRelease(work, args) {
  const result = Bun.spawnSync([process.execPath, "scripts/release.mjs", ...args], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_IDENTITY_ENV },
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.replaceAll("\r\n", "\n");
  return { code: result.exitCode, output };
}

function localVersion(work) {
  return JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version;
}

test("refuses a stale branch and writes nothing when origin/main is ahead", () => {
  const { base, remote, work } = makeRepository();
  pushFromAnotherClone(base, remote, "notes.txt", "remote moved on\n");

  const headBefore = git(work, ["rev-parse", "HEAD"]);
  const remoteMainBefore = git(remote, ["rev-parse", "refs/heads/main"]);

  const { code, output } = runRelease(work, ["--patch"]);

  expect(code).toBe(1);
  // The message has to say what went wrong, that nothing was written, and how
  // to recover -- not just "failed".
  expect(output).toContain("[release] FAIL:");
  expect(output).toContain("has commits that are not in main");
  expect(output).toContain("Nothing has been written yet");
  expect(output).toContain("package.json version is still 0.1.0");
  expect(output).toContain("no release commit was created and no tag was created");
  expect(output).toContain("git pull --rebase origin main");

  // Zero side effects: no version bump, no commit, no tag, clean tree.
  expect(localVersion(work)).toBe("0.1.0");
  expect(readFileSync(join(work, "package.json"), "utf8")).toContain('"version": "0.1.0"');
  expect(git(work, ["tag", "--list"])).toBe("");
  expect(git(work, ["rev-parse", "HEAD"])).toBe(headBefore);
  expect(git(work, ["status", "--porcelain"])).toBe("");

  // And nothing landed on the remote either.
  expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(remoteMainBefore);
  expect(git(remote, ["tag", "--list"])).toBe("");
});

test("releases normally when origin/main is already in the branch history", () => {
  const { work } = makeRepository();

  const { code, output } = runRelease(work, ["--patch", "--dry-run"]);

  expect(code).toBe(0);
  expect(output).toContain("version: 0.1.0 -> 0.1.1");
  expect(output).toContain("is in HEAD's history");
  expect(output).toContain("dry run: nothing was written");
  expect(output).not.toContain("cannot resolve origin/main");

  // --dry-run stays a zero-write preview.
  expect(localVersion(work)).toBe("0.1.0");
  expect(git(work, ["tag", "--list"])).toBe("");
});

test("warns but keeps going when there is no origin to compare against", () => {
  const { work } = makeRepository();
  git(work, ["remote", "remove", "origin"]);

  const { code, output } = runRelease(work, ["--patch", "--dry-run"]);

  expect(code).toBe(0);
  expect(output).toContain("warning: cannot resolve origin/main");
  expect(output).toContain("skipping the remote preflight");
  expect(output).toContain("version: 0.1.0 -> 0.1.1");
  expect(localVersion(work)).toBe("0.1.0");
});

test("a rejected push reports the recovery commands and pollutes no remote", () => {
  const { remote, work } = makeRepository();
  // A passing preflight, then a push the server refuses: the race the preflight
  // cannot see (someone pushes between fetch and push).
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'remote is locked' >&2\nexit 1\n");
  chmodSync(hook, 0o755);

  const remoteMainBefore = git(remote, ["rev-parse", "refs/heads/main"]);
  const headBefore = git(work, ["rev-parse", "HEAD"]);

  const { code, output } = runRelease(work, ["--patch", "--push"]);

  expect(code).toBe(1);
  expect(output).toContain("the local commit and tag exist but the push did not finish");
  expect(output).toContain("Recover with:");
  expect(output).toContain("git pull --rebase");
  expect(output).toContain("git push origin main");
  expect(output).toContain("git push origin v0.1.1");

  // The remote is untouched: same main, no tag.
  expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(remoteMainBefore);
  expect(git(remote, ["tag", "--list"])).toBe("");

  // Locally the release commit and tag exist -- that is exactly why the message
  // has to explain how to finish the job.
  expect(localVersion(work)).toBe("0.1.1");
  expect(git(work, ["rev-parse", "HEAD"])).not.toBe(headBefore);
  expect(git(work, ["tag", "--list"])).toBe("v0.1.1");
});
