// The Proxy IPs table's region column used to render the exit IP inside a
// `white-space: nowrap; text-overflow: ellipsis; overflow: hidden` block while
// the column itself could shrink to 78px, so the row showed `出口 IP 111.24…`
// and two different exits looked identical. These tests pin the fix: the
// address is never truncated, the line may only wrap between the label and the
// IP, and the column is wide enough for a full IPv4 address.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const css = readFileSync(join(root, "ui", "style.css"), "utf8");

// One CSS rule block, matched by its selector, up to the closing brace.
function rule(selector) {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

// The `proxyRow` region cell, so assertions cannot be satisfied by some other
// part of the page that happens to mention an exit IP.
function regionCell() {
  const start = app.indexOf("region.textContent = proxy.region");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = app.indexOf("const statusCell", start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
}

test("the exit IP is written in full into its own span, never sliced", () => {
  const cell = regionCell();
  expect(cell).toContain("ip.textContent = proxy.exitIp;");
  expect(cell).toContain('ip.className = "proxy-region-exit-ip";');
  // No truncation of the address anywhere in the cell.
  expect(cell).not.toMatch(/proxy\.exitIp\.(slice|substring|substr)\(/);
  // The label is a separate element so wrapping happens between them.
  expect(cell).toContain("label.textContent = text.exitIp;");
  expect(cell).toContain('label.className = "proxy-region-exit-label";');
});

test("the full exit IP is also available as a tooltip", () => {
  const cell = regionCell();
  expect(cell).toContain("exit.title = `${text.exitIp} ${proxy.exitIp}`;");
});

test("the region exit line no longer ellipsizes or clips its content", () => {
  const block = rule(".proxy-region small {");
  expect(block).not.toContain("text-overflow: ellipsis");
  expect(block).not.toContain("white-space: nowrap");
  expect(block).not.toContain("overflow: hidden");
  // Wrapping is allowed, and a too-long token breaks instead of overflowing.
  expect(block).toContain("white-space: normal");
  expect(block).toContain("overflow-wrap: anywhere");
});

test("the exit label stays on one line so only the IP wraps", () => {
  expect(rule(".proxy-region-exit-label {")).toContain("white-space: nowrap");
});

test("the region column is at least as wide as a full IPv4 address", () => {
  const head = rule(".proxy-table-head,\n.proxy-row {");
  // Third track is the region column: name, address, region, …
  const tracks = head.split("grid-template-columns:")[1].split(";")[0];
  const region = tracks.trim().split("\n").map((line) => line.trim())[2];
  const min = Number(/minmax\((\d+)px/.exec(region)?.[1]);
  // 15 characters of 11px monospace plus breathing room.
  expect(min).toBeGreaterThanOrEqual(99);
});
