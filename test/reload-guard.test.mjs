import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createReloadGuard,
  RELOAD_MARKER,
  RELOAD_MARKER_VALUE,
} from "../ui/reload-guard.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");

function fakeEnv(href, { history = true } = {}) {
  const location = {
    href,
    search: new URL(href).search,
    replaced: [],
    replace(url) {
      this.href = url;
      this.search = new URL(url).search;
      this.replaced.push(url);
    },
  };
  const fakeHistory = {
    state: null,
    replaced: [],
    replaceState(state, title, url) {
      this.state = state;
      this.replaced.push(url);
      // A real replaceState updates the visible location; mirror that so the
      // guard observes the marker as cleared.
      location.href = url;
      location.search = new URL(url).search;
    },
  };
  return { location, history: history ? fakeHistory : undefined };
}

// ---------- the wiring in app.js ----------

test("the UI wires the cross-document reload guard into the api error branch", () => {
  expect(app).toContain("createReloadGuard");
  expect(app).toContain("reloadGuard.reloadOnce()");
  expect(app).toContain("reloadGuard.clearMarker()");
  // The old unconditional reload is gone. Exactly one location.reload() call
  // remains: the manual retry button.
  expect((app.match(/location\.reload\(\)/g) || []).length).toBe(1);
  expect(app).toContain('byId("retry").addEventListener("click", () => location.reload())');
});

test("a suppressed reload falls through to the normal error path", () => {
  const apiBody = /async function api\([\s\S]*?\n\}/.exec(app)?.[0] || "";
  // Only an actually-started reload returns the never-resolving promise.
  expect(apiBody).toMatch(
    /if \(data\?\.reload && reloadGuard\.reloadOnce\(\)\) \{\s*return new Promise\(\(\) => \{\}\);/,
  );
  // When the guard refuses, execution continues to the throw that drives the
  // form error / service-failed display.
  expect(apiBody).toContain("throw error;");
});

// ---------- the guard's behaviour ----------

test("the first unauthorized reload navigates once and keeps theme/lang/hash", () => {
  const env = fakeEnv("http://127.0.0.1:3492/?theme=dark&lang=ja#providers=x");
  const guard = createReloadGuard(env);
  expect(guard.reloadOnce()).toBe(true);
  expect(env.location.replaced.length).toBe(1);
  const url = new URL(env.location.replaced[0]);
  expect(url.searchParams.get(RELOAD_MARKER)).toBe(RELOAD_MARKER_VALUE);
  // boot.js's theme and lang survive, and the provider hash is not clobbered.
  expect(url.searchParams.get("theme")).toBe("dark");
  expect(url.searchParams.get("lang")).toBe("ja");
  expect(url.hash).toBe("#providers=x");
});

test("a second unauthorized response in the same document does not navigate again", () => {
  const env = fakeEnv("http://127.0.0.1:3492/");
  const guard = createReloadGuard(env);
  expect(guard.reloadOnce()).toBe(true);
  expect(guard.reloadOnce()).toBe(false);
  expect(env.location.replaced.length).toBe(1);
});

test("a document already carrying the marker never auto-reloads (no storm)", () => {
  const env = fakeEnv(
    `http://127.0.0.1:3492/?theme=dark&${RELOAD_MARKER}=${RELOAD_MARKER_VALUE}`,
  );
  const guard = createReloadGuard(env);
  expect(guard.hasMarker()).toBe(true);
  // This is the second reload:true in the cross-document count. It must refuse
  // to navigate so app.js shows the error instead of reloading forever.
  expect(guard.reloadOnce()).toBe(false);
  expect(env.location.replaced.length).toBe(0);
});

test("a successful load clears the marker without touching theme/lang/hash", () => {
  const env = fakeEnv(
    `http://127.0.0.1:3492/?theme=dark&lang=ja&${RELOAD_MARKER}=${RELOAD_MARKER_VALUE}#providers=x`,
  );
  const guard = createReloadGuard(env);
  guard.clearMarker();
  expect(env.history.replaced.length).toBe(1);
  const url = new URL(env.history.replaced[0]);
  expect(url.searchParams.has(RELOAD_MARKER)).toBe(false);
  expect(url.searchParams.get("theme")).toBe("dark");
  expect(url.searchParams.get("lang")).toBe("ja");
  expect(url.hash).toBe("#providers=x");
  // After a successful load the next genuine expiry may reload once.
  expect(guard.reloadOnce()).toBe(true);
});

test("without history the marker survives but still suppresses the reload", () => {
  const env = fakeEnv(
    `http://127.0.0.1:3492/?${RELOAD_MARKER}=${RELOAD_MARKER_VALUE}`,
    { history: false },
  );
  const guard = createReloadGuard(env);
  expect(() => guard.clearMarker()).not.toThrow();
  expect(guard.reloadOnce()).toBe(false);
});
