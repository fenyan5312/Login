// The provider page has exactly two regions: the main list of what a user can
// sign in to right now, and one collapsed catalog that must keep every other
// subscription provider visible. These tests pin the split rule itself (pure,
// no DOM), the completeness promise, and the markup that carries it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NON_SUBSCRIPTION_PROVIDER_IDS,
  partitionProviders,
  providerIsPrimary,
  providerIsSubscription,
} from "../ui/provider-state.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");
const css = readFileSync(join(root, "ui", "style.css"), "utf8");

function card(overrides = {}) {
  return {
    id: "sample",
    name: "Sample",
    presence: "magpie-only",
    signableMethod: true,
    browserMethod: true,
    signInProvider: "sample",
    ...overrides,
  };
}

test("a card is in the main list only when magpie has it and a method runs", () => {
  expect(providerIsPrimary(card())).toBe(true);
  // magpie has it, but the scan exposed no runnable method.
  expect(providerIsPrimary(card({ signableMethod: false, browserMethod: false }))).toBe(false);
  // A runnable method with no plugin entry id cannot be loaded by the service.
  expect(providerIsPrimary(card({ signInProvider: null }))).toBe(false);
  // The plugin is installed but magpie does not know the provider, so the
  // account it writes has nowhere to land.
  expect(providerIsPrimary(card({ presence: "plugin-only" }))).toBe(false);
  // magpie's list was unreadable, so nothing can be called usable now.
  expect(providerIsPrimary(card({ presence: "local-unknown" }))).toBe(false);
  // Readiness is deliberately not the gate: an unverified flow is exactly the
  // one a user should be able to try.
  expect(providerIsPrimary(card({ capability: { state: "pending" } }))).toBe(true);
});

test("a local model runner is not a subscription to sign in to", () => {
  expect(NON_SUBSCRIPTION_PROVIDER_IDS).toContain("llama-local");
  expect(providerIsSubscription(card({ id: "llama-local" }))).toBe(false);
  expect(providerIsSubscription(card({ id: "LLAMA-LOCAL" }))).toBe(false);
  expect(providerIsSubscription(card({ id: "cursor" }))).toBe(true);
  expect(providerIsSubscription(card({ id: "antigravity", presence: "both" }))).toBe(true);
  expect(providerIsSubscription({})).toBe(false);
});

test("the two regions together hold every subscription provider", () => {
  const items = [
    card({ id: "workbuddy", name: "WorkBuddy" }),
    card({ id: "zcode", name: "ZCode", signableMethod: false, browserMethod: false, signInProvider: null }),
    card({ id: "antigravity", name: "Google Antigravity", presence: "both", signableMethod: false, browserMethod: false, signInProvider: null }),
    card({ id: "qwenwork", name: "qwenwork", presence: "plugin-only" }),
    card({ id: "llama-local", name: "Qwen3-4B local", signableMethod: false, browserMethod: false, signInProvider: null }),
    card({ id: "claude", name: "Claude", presence: "local-only", signableMethod: false, browserMethod: false, signInProvider: null }),
  ];
  const { primary, other } = partitionProviders(items);
  expect(primary.map((item) => item.id)).toEqual(["workbuddy"]);
  // Every other subscription provider is in the collapsed catalog, including
  // the magpie-native ones this plugin has no flow for and the plugin-only one.
  expect(other.map((item) => item.id)).toEqual(["zcode", "antigravity", "qwenwork", "claude"]);
  // The local model runner is the only card that appears in neither region.
  const shown = [...primary, ...other].map((item) => item.id);
  expect(shown).not.toContain("llama-local");
  expect(shown.length).toBe(items.length - 1);
});

test("account counts order the main list and never move a card", () => {
  const items = [
    card({ id: "alpha", name: "Alpha" }),
    card({ id: "beta", name: "Beta" }),
    card({ id: "gamma", name: "Gamma" }),
    card({ id: "delta", name: "Delta", presence: "plugin-only" }),
  ];
  const counts = { alpha: 1, beta: 6, gamma: 0, delta: 9 };
  const { primary, other } = partitionProviders(items, counts);
  expect(primary.map((item) => item.id)).toEqual(["beta", "alpha", "gamma"]);
  // A big account count does not promote a card magpie does not have.
  expect(other.map((item) => item.id)).toEqual(["delta"]);
  // Equal counts fall back to the name, so the order is stable between reads.
  const tied = partitionProviders([card({ id: "b", name: "Bravo" }), card({ id: "a", name: "Alpha" })]);
  expect(tied.primary.map((item) => item.id)).toEqual(["a", "b"]);
  // A Map works as well as a plain object.
  expect(partitionProviders(items, new Map([["alpha", 3]])).primary[0].id).toBe("alpha");
});

test("an unreadable magpie list never hides every card behind the fold", () => {
  const items = [
    card({ id: "antigravity", presence: "local-unknown", signableMethod: false, browserMethod: false, signInProvider: null }),
    card({ id: "codex", presence: "local-unknown", signableMethod: false, browserMethod: false, signInProvider: null }),
  ];
  const { primary, other } = partitionProviders(items);
  expect(primary.map((item) => item.id)).toEqual(["antigravity", "codex"]);
  expect(other).toEqual([]);
});

test("the split tolerates junk input", () => {
  expect(partitionProviders()).toEqual({ primary: [], other: [] });
  expect(partitionProviders(null)).toEqual({ primary: [], other: [] });
  expect(partitionProviders([null, {}, card({ id: "" })])).toEqual({ primary: [], other: [] });
});

test("the page renders the main list and one collapsed catalog", () => {
  expect(app).toContain("partitionProviders(providerCatalog");
  expect(app).toContain('byId("providers-more-list")');
  expect(app).toContain('byId("providers-more-count")');
  expect(app).toContain("renderProviders(providerCatalog)");
  expect(html).toContain('id="providers-more"');
  expect(html).toContain("<details");
  expect(html).toContain('id="providers-more-list"');
  // The catalog is a <details> element, not a control: the page must still ship
  // no unwired button, and the count is on the summary so a closed fold never
  // reads as an empty page.
  const catalog = /<details class="providers-more"[\s\S]*?<\/details>/.exec(html)?.[0] || "";
  expect(catalog).not.toContain("<button");
  expect(catalog).toContain('id="providers-more-count"');
  // The source diagnostics now live inside the one collapsed region.
  expect(catalog).toContain('id="provider-sources"');
  expect((html.match(/<details\b/g) || []).length).toBe(1);
  expect(css).toContain(".providers-more-summary");
  expect(css).toContain(".providers-more[open]");
});

test("the region is named in all four languages", () => {
  for (const key of ["providersMoreTitle", "providersMoreHint"]) {
    expect((app.match(new RegExp(`${key}:`, "g")) || []).length).toBe(4);
  }
  expect(app).toContain('byId("providers-more-title").textContent = text.providersMoreTitle');
  expect(app).toContain('byId("providers-more-hint").textContent = text.providersMoreHint');
});
