import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("uses the community page package shape", () => {
  expect(pkg.name).toBe("login");
  expect(pkg.license).toBe("MIT");
  expect(pkg.type).toBe("module");
  // A page plugin that runs a host service MUST name an entry file.
  // magpie assigns `magpie.page.service` only while `main` (or `exports`) is
  // present — internal/plugin/page.go: "a plugin that is only a page has none,
  // so its sandboxed page can't be handed a way to some other program's port".
  // Without it the page renders but nothing listens, so the frame shows
  // "127.0.0.1 refused to connect".
  //
  // The cost of naming it: github.go only reads a plugin's kind as "page" when
  // main and exports are BOTH absent, so Discover files this one under
  // providers rather than pages. A working service wins over the right shelf.
  expect(pkg.main).toBe("./index.mjs");
  expect(pkg.magpie.icon).toMatch(/^https:\/\//);
  expect(pkg.magpie.page.file).toBe("page/index.html");
  expect(pkg.magpie.page.service).toEqual({ port: 3492, option: "port" });
  expect(pkg.magpie.options.port).toBe(3492);
});

test("declares only the providers:list read it actually uses", () => {
  expect(pkg.magpie.permissions).toEqual(["providers:list"]);
});

test("ships every file the manifest names", () => {
  for (const file of [
    pkg.main,
    pkg.magpie.page.file,
    pkg.magpie.page.icon,
    "ui/index.html",
    "ui/style.css",
    "ui/app.js",
    "ui/account-view.js",
    "README.md",
    "LICENSE",
  ]) {
    expect(existsSync(join(root, file))).toBe(true);
  }
});

// A standalone repository has no community registry.json above it. The topic
// install channel instead requires the manifest to carry its own identity:
// an MIT license and a repository/bugs URL that point at this repository.
test("declares a standalone repository the topic channel can find", () => {
  expect(pkg.license).toBe("MIT");
  expect(pkg.repository.type).toBe("git");
  expect(pkg.repository.url).toBe("git+https://github.com/fenyan5312/Login.git");
  expect(pkg.bugs.url).toBe("https://github.com/fenyan5312/Login/issues");
  expect(pkg.keywords).toContain("magpie-plugin");
});

test("ships the glass dropdown enhancement and loads it in the page", () => {
  const html = readFileSync(join(root, "ui", "index.html"), "utf8");
  expect(html).toContain('src="glass-select.js"');
  const js = readFileSync(join(root, "ui", "glass-select.js"), "utf8");
  // The native select stays the value holder; the visible control is a
  // combobox and the menu is a top-layer popover (so it can float over a
  // modal dialog without being inert).
  expect(js).toContain('"combobox"');
  expect(js).toContain("showPopover");
  expect(js).toContain('closest("dialog")');
});

test("never hand the model directory to the host through the inert name", () => {
  // fpgen-js reads FPGEN_DATA_DIR. The old code wrote CAMOUFOX_FPGEN_DATA and
  // claimed the forked host read it back; that handoff is not the fix anymore.
  for (const name of readdirSync(join(root, "lib"))) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(root, "lib", name), "utf8");
    expect(text.includes("CAMOUFOX_FPGEN_DATA")).toBe(false);
  }
});
