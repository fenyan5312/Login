// Pure client-side filtering for the Proxy IPs table: the distinct-region
// counts, the multi-select plus latency range, and the read-file wiring of the
// filter bar. No DOM is needed.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  distinctRegions,
  filterProxies,
  latencyBound,
  regionKey,
} from "../ui/proxy-filter.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

const proxies = [
  { id: "a", region: "中国/香港", latency: 120 },
  { id: "b", region: "日本/东京", latency: 45 },
  { id: "c", region: "中国/香港", latency: 260 },
  { id: "d", region: "", latency: null },
  { id: "e", region: "  ", latency: 90 },
  { id: "f", region: "日本/东京", latency: 45 },
];

test("distinctRegions counts each region and keeps untested apart and last", () => {
  expect(distinctRegions(proxies)).toEqual([
    { region: "中国/香港", count: 2 },
    { region: "日本/东京", count: 2 },
    { region: "", count: 2 },
  ]);
  // An absent or malformed list degrades to no regions instead of throwing.
  expect(distinctRegions()).toEqual([]);
  expect(distinctRegions([null, undefined, {}])).toEqual([{ region: "", count: 1 }]);
});

test("regionKey trims and tolerates missing regions", () => {
  expect(regionKey({ region: "  Japan  " })).toBe("Japan");
  expect(regionKey({ region: "" })).toBe("");
  expect(regionKey({})).toBe("");
  expect(regionKey()).toBe("");
});

test("filterProxies with no filter returns every proxy", () => {
  expect(filterProxies(proxies)).toEqual(proxies);
  expect(filterProxies(proxies, { regions: [], minLatency: "", maxLatency: "" })).toEqual(proxies);
});

test("regions are a multi-select and the untested region can stand alone", () => {
  const hongKong = filterProxies(proxies, { regions: ["中国/香港"] }).map((p) => p.id);
  expect(hongKong).toEqual(["a", "c"]);
  const both = filterProxies(proxies, { regions: ["中国/香港", "日本/东京"] }).map((p) => p.id);
  expect(both).toEqual(["a", "b", "c", "f"]);
  // Empty string selects only rows that have never been tested (region "").
  expect(filterProxies(proxies, { regions: [""] }).map((p) => p.id)).toEqual(["d", "e"]);
});

test("latency bounds apply only to numeric latencies and exclude null rows", () => {
  expect(filterProxies(proxies, { minLatency: 100 }).map((p) => p.id)).toEqual(["a", "c"]);
  expect(filterProxies(proxies, { maxLatency: 100 }).map((p) => p.id)).toEqual(["b", "e", "f"]);
  expect(filterProxies(proxies, { minLatency: 45, maxLatency: 120 }).map((p) => p.id)).toEqual(["a", "b", "e", "f"]);
  // A single bound still excludes the unknown-latency row.
  expect(filterProxies(proxies, { minLatency: 0 }).map((p) => p.id)).toEqual(["a", "b", "c", "e", "f"]);
});

test("region and latency filters combine", () => {
  const result = filterProxies(proxies, {
    regions: ["日本/东京"],
    minLatency: 50,
    maxLatency: 200,
  });
  expect(result.map((p) => p.id)).toEqual([]);
});

test("latencyBound ignores empty and nonsense input", () => {
  expect(latencyBound("")).toBeNull();
  expect(latencyBound("   ")).toBeNull();
  expect(latencyBound(null)).toBeNull();
  expect(latencyBound(undefined)).toBeNull();
  expect(latencyBound("abc")).toBeNull();
  expect(latencyBound(0)).toBe(0);
  expect(latencyBound("120")).toBe(120);
  expect(latencyBound(45.5)).toBe(45.5);
});

// The filter bar is asserted against the real markup, not against indentation.
// `htmlDivById` returns the outer HTML of the first <div> carrying the id, with
// nested divs balanced. `jsFunctionBody` returns a top-level function's body
// (string literals and comments skipped) so the chip wiring is asserted where
// it actually lives.
function htmlDivById(source, id) {
  const open = new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(source);
  if (!open) return "";
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = open.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return source.slice(open.index, tags.lastIndex);
  }
  return "";
}

function jsFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) return "";
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const character = source[i];
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (character === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i + 2);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  return "";
}

test("the filter bar is wired to the pure helpers and every chip is a button", () => {
  const renderList = jsFunctionBody(app, "renderProxies");
  const renderChips = jsFunctionBody(app, "renderFilterChips");
  const reset = jsFunctionBody(app, "resetProxyFilters");
  expect(renderList).not.toBe("");
  expect(renderChips).not.toBe("");
  expect(reset).not.toBe("");

  // The list uses the pure filter; the chips come from the pure region helper.
  expect(renderList).toContain("filterProxies(proxies, proxyFilter)");
  expect(renderList).toContain("renderFilterChips()");
  expect(renderChips).toContain("distinctRegions(proxies)");
  expect(renderChips).toContain('byId("filter-regions")');

  // Exactly two button factories: the "All" chip and one region chip. Both are
  // <button type="button"> and both are appended to the #filter-regions wrap.
  expect(renderChips.match(/document\.createElement\("button"\)/g) ?? []).toHaveLength(2);
  expect(renderChips).toContain('all.type = "button"');
  expect(renderChips).toContain('chip.type = "button"');
  expect(renderChips).toContain("wrap.append(all)");
  expect(renderChips).toContain("wrap.append(chip)");
  expect(renderChips).not.toContain('createElement("a")');
  expect(renderChips).not.toContain('createElement("input")');
  expect(renderChips).not.toContain('type = "submit"');

  expect(reset).toContain("proxyFilter.regions.clear()");
  expect(reset).toContain('byId("filter-latency-min").value = ""');
  expect(reset).toContain('byId("filter-latency-max").value = ""');
  expect(reset).toContain("renderProxies()");

  const filterBar = htmlDivById(html, "proxy-filters");
  expect(filterBar).not.toBe("");
  // The chip container is empty markup: every chip is built as a button in JS.
  expect(filterBar).toMatch(/<div class="filter-chips" id="filter-regions"><\/div>/);
  expect(filterBar).toContain('id="filter-latency-min"');
  expect(filterBar).toContain('id="filter-latency-max"');
  expect(filterBar).toContain('id="filter-count"');
  expect(filterBar).not.toContain('type="submit"');
  expect(filterBar).not.toContain("<form");

  const resetTag = /<button\b[^>]*\bid="filter-reset"[^>]*>/.exec(filterBar)?.[0] ?? "";
  expect(resetTag).toContain('type="button"');
  expect(html.indexOf('id="proxy-filters"')).toBeLessThan(html.indexOf('id="proxy-score-bar"'));
});

test("the table shows a filtered count and an explicit no-match note", () => {
  expect(app).toContain("text.filterCount");
  expect(app).toContain("text.filterNoMatch");
  expect(app).toContain('byId("filter-count").textContent');
});

test("filter state is in memory, never localStorage", () => {
  expect(app).not.toContain("localStorage");
  expect(app).not.toContain("sessionStorage");
  expect(app).toContain('regions: new Set()');
});
