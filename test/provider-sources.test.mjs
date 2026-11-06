// Pure normalization and merge tests. No network and no magpie runtime: the
// real payload shape of `providers:list` has NOT been verified on this machine,
// so these tests pin down the tolerant behavior the code claims instead.

import { expect, test } from "bun:test";
import { listProviders, publicProvider } from "../lib/provider-registry.mjs";
import {
  MAGPIE_PROVIDERS_READ,
  PROVIDER_PRESENCES,
  mergeProviderSources,
  normalizeMagpieProviders,
} from "../lib/provider-sources.mjs";

const LOCAL = listProviders();

function ids(items) {
  return items.map((item) => item.id);
}

test("the read name is the one magpie declares", () => {
  expect(MAGPIE_PROVIDERS_READ).toBe("providers:list");
});

// Regression test for a real defect: the local registry used to call Google
// Antigravity `google-antigravity` while magpie's own id is `antigravity`, so
// the merge reported a provider magpie really has as "not in magpie". Feeding
// magpie's actual id list now has to land every local provider in `both`.
// The list below is magpie's own `providers.json` id set at the time of
// writing; a future rename upstream will fail this test on purpose.
test("every local provider id lines up with magpie's own ids", () => {
  const magpieIds = [
    "workbuddy",
    "cursor",
    "antigravity",
    "codex",
    "zcode",
    "grok",
    "mimo-app",
    "llama-local",
    "devin",
    "yeta",
    "minimax-code",
    "workbuddy-ai",
    "qoder",
    "qoder-cn",
    "loomy",
  ];
  const view = mergeProviderSources({ local: LOCAL, magpie: magpieIds });
  const byId = Object.fromEntries(view.providers.map((provider) => [provider.id, provider]));
  expect(byId.antigravity.presence).toBe("both");
  expect(byId.codex.presence).toBe("both");
  // Claude is not one of magpie's provider ids (magpie signs in to Claude by
  // importing a token through POST /api/signin/claude-token), so it stays
  // local-only and the card says so.
  expect(byId.claude.presence).toBe("local-only");
});

test("normalization accepts a bare string array", () => {
  const read = normalizeMagpieProviders(["antigravity", "codex"]);
  expect(read.available).toBe(true);
  expect(ids(read.items)).toEqual(["antigravity", "codex"]);
});

test("normalization accepts an array of { id, name } objects", () => {
  const read = normalizeMagpieProviders([
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude" },
  ]);
  expect(read.available).toBe(true);
  expect(read.items).toEqual([
    { id: "codex", name: "Codex" },
    { id: "claude", name: "Claude" },
  ]);
});

test("normalization accepts a { providers: [...] } wrapper", () => {
  const read = normalizeMagpieProviders({ providers: [{ name: "Google Antigravity" }] });
  expect(read.available).toBe(true);
  // An entry carrying only a display name keys on the slug of that name, which
  // is NOT our registry id. That is why mergeProviderSources matches on both
  // the id and the name slug instead of comparing ids alone.
  expect(read.items).toEqual([{ id: "google-antigravity", name: "Google Antigravity" }]);
});

test("a name-only magpie entry still lines up with our registry id", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: [{ name: "Google Antigravity" }] });
  const byId = Object.fromEntries(view.providers.map((provider) => [provider.id, provider]));
  expect(byId.antigravity.presence).toBe("both");
  // It matched, so it must not also appear a second time as a magpie-only card.
  expect(view.counts.both).toBe(1);
  expect(view.counts.magpieOnly).toBe(0);
  expect(view.counts.total).toBe(LOCAL.length);
});

test("normalization accepts a single string or object", () => {
  expect(normalizeMagpieProviders("codex")).toEqual({
    available: true,
    items: [{ id: "codex", name: "codex" }],
  });
  expect(normalizeMagpieProviders({ id: "codex", name: "Codex" })).toEqual({
    available: true,
    items: [{ id: "codex", name: "Codex" }],
  });
});

test("normalization deduplicates by id", () => {
  const read = normalizeMagpieProviders(["codex", { id: "codex", name: "Codex again" }]);
  expect(read.items).toEqual([{ id: "codex", name: "codex" }]);
});

test("normalization treats null, undefined and junk as unavailable", () => {
  for (const value of [null, undefined, 42, true, {}, { nope: [] }]) {
    expect(normalizeMagpieProviders(value).available).toBe(false);
    expect(normalizeMagpieProviders(value).items).toEqual([]);
  }
});

test("normalization understands the boot envelope", () => {
  expect(normalizeMagpieProviders({ v: 1, ok: false }).available).toBe(false);
  expect(normalizeMagpieProviders({ v: 1, ok: true, value: [] }).available).toBe(true);
  expect(normalizeMagpieProviders({ v: 1, ok: true, value: null }).available).toBe(false);
  expect(normalizeMagpieProviders({ v: 1, ok: true, value: ["codex"] }).items).toEqual([
    { id: "codex", name: "codex" },
  ]);
});

test("an empty magpie list still counts as derived from magpie", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: [] });
  expect(view.source).toBe("magpie");
  expect(view.magpie).toEqual({ available: true, count: 0 });
  expect(view.counts.total).toBe(LOCAL.length);
  expect(view.counts.both).toBe(0);
  expect(view.counts.localOnly).toBe(LOCAL.length);
  expect(view.counts.magpieOnly).toBe(0);
});

test("case a: a provider in both sources is normal and carries the local sign-in mode", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["antigravity", "codex", "claude"] });
  expect(view.source).toBe("magpie");
  expect(view.counts).toEqual({ total: 3, both: 3, localOnly: 0, magpieOnly: 0, pluginOnly: 0 });
  for (const provider of view.providers) {
    expect(provider.presence).toBe("both");
    expect(provider.presenceNote).toBeNull();
    expect(provider.sources).toEqual({ local: true, magpie: true });
    // The sign-in mechanism is always the local declaration.
    const local = LOCAL.find((item) => item.id === provider.id);
    expect(provider.signInMode).toBe(local.signInMode);
  }
});

test("case b: a magpie-only provider has a card, no local fields and an honest reason", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "mystery-ai"] });
  const card = view.providers.find((provider) => provider.id === "mystery-ai");
  expect(card).toBeTruthy();
  expect(card.presence).toBe("magpie-only");
  expect(card.sources).toEqual({ local: false, magpie: true });
  expect(card.capability.state).toBe("pending");
  expect(card.capability.reason.en).toContain("has not verified its browser sign-in method");
  expect(card.presenceNote.en).toContain("has not verified its browser sign-in method");
  for (const lang of ["zh-Hans", "zh-Hant", "ja"]) {
    expect(card.capability.reason[lang]).toBeTruthy();
    expect(card.presenceNote[lang]).toBeTruthy();
  }
  // It carries none of the local capabilities, so nothing can be promoted.
  expect(card.agentId).toBe("mystery-ai");
  expect(card.authHosts).toEqual([]);
  expect(card.callbackPort).toBeNull();
  expect(view.counts).toEqual({ total: 4, both: 1, localOnly: 2, magpieOnly: 1, pluginOnly: 0 });
});

test("case c: a local provider magpie omits is annotated, not removed", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex"] });
  const card = view.providers.find((provider) => provider.id === "claude");
  expect(card.presence).toBe("local-only");
  expect(card.sources).toEqual({ local: true, magpie: false });
  expect(card.presenceNote.en).toContain("does not list this provider");
  for (const lang of ["zh-Hans", "zh-Hant", "ja"]) {
    expect(card.presenceNote[lang]).toBeTruthy();
  }
  expect(view.counts).toEqual({ total: 3, both: 1, localOnly: 2, magpieOnly: 0, pluginOnly: 0 });
});

test("an unavailable magpie list degrades to the local registry without false claims", () => {
  for (const magpie of [undefined, null, { v: 1, ok: false }, 42]) {
    const view = mergeProviderSources({ local: LOCAL, magpie });
    expect(view.source).toBe("local");
    expect(view.magpie.available).toBe(false);
    expect(view.counts).toEqual({ total: LOCAL.length, both: 0, localOnly: 0, magpieOnly: 0, pluginOnly: 0 });
    for (const provider of view.providers) {
      expect(provider.presence).toBe("local-unknown");
      // We must not claim magpie lacks a provider when we never read the list.
      expect(provider.presenceNote).toBeNull();
    }
  }
});

test("signInProvider carries the installed plugin entry id the service loads", () => {
  const plugins = {
    available: true,
    providers: [
      { id: "workbuddy", package: "@x/workbuddy", methods: [{ type: "oauth", label: "WorkBuddy (browser)", category: "browser" }] },
      { id: "google-antigravity", package: "@x/antigravity", methods: [{ type: "oauth", label: "Antigravity (browser)", category: "browser" }] },
      { id: "kiro", package: "@x/kiro", methods: [{ type: "oauth", label: "Kiro (browser)", category: "browser" }] },
    ],
  };
  const view = mergeProviderSources({
    local: LOCAL,
    magpie: ["workbuddy", { name: "Google Antigravity" }],
    plugins,
  });
  const byId = Object.fromEntries(view.providers.map((provider) => [provider.id, provider]));

  // magpie-only: the card id and the installed plugin entry id line up.
  expect(byId.workbuddy.presence).toBe("magpie-only");
  expect(byId.workbuddy.signInProvider).toBe("workbuddy");

  // Matched by the slug of the display name: the local card id is
  // `antigravity` while the installed plugin entry (and therefore the id the
  // service passes to defaultLoadProvider) is `google-antigravity`.
  expect(byId.antigravity.presence).toBe("both");
  expect(byId.antigravity.signInProvider).toBe("google-antigravity");

  // plugin-only: the card is the plugin entry itself.
  expect(byId.kiro.presence).toBe("plugin-only");
  expect(byId.kiro.signInProvider).toBe("kiro");

  // No matched plugin entry: nothing is fabricated.
  expect(byId.claude.pluginPackage).toBeNull();
  expect(byId.claude.signInProvider).toBeNull();
});

test("the merged projection stays public and leak-free", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "mystery-ai"] });
  expect(JSON.stringify(view)).not.toMatch(
    /client[_-]?secret|client[_-]?id|access[_-]?token|refresh[_-]?token|api[_-]?key|password/i,
  );
  for (const provider of view.providers) {
    expect(PROVIDER_PRESENCES).toContain(provider.presence);
  }
  // The local projection used here is exactly the public one.
  expect(LOCAL).toEqual(listProviders());
  expect(LOCAL[0]).toEqual(publicProvider(LOCAL[0]));
});
