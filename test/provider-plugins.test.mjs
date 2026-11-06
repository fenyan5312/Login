// Three-source merge tests: local registry + magpie's list + the installed
// plugin scan. The plugin scan is always injected here; no provider plugin is
// imported and no child process is spawned.

import { expect, test } from "bun:test";
import { listProviders } from "../lib/provider-registry.mjs";
import { PROVIDER_PRESENCES, mergeProviderSources } from "../lib/provider-sources.mjs";
import { providerCanSignIn } from "../ui/provider-state.js";

const LOCAL = listProviders();
const LANGS = ["en", "zh-Hans", "zh-Hant", "ja"];

const PLUGINS = {
  available: true,
  providers: [
    {
      id: "codex",
      package: "@magpie-community/opencode-codex-auth",
      methods: [
        { type: "oauth", label: "Codex (browser)", browser: true, category: "browser", runnable: true },
        { type: "oauth", label: "codex's sign-in", browser: false, category: "local", runnable: true },
        { type: "api", label: "Codex API key", browser: false, category: "key", runnable: false },
      ],
    },
    {
      id: "cursor",
      package: "@magpie-community/opencode-cursor-auth",
      methods: [
        { type: "oauth", label: "Cursor (browser)", browser: true, category: "browser", runnable: true },
        { type: "oauth", label: "cursor-agent's sign-in", browser: false, category: "local", runnable: true },
      ],
    },
    {
      // No browser method at all: local session / key only.
      id: "antigravity",
      package: null,
      methods: [{ type: "api", label: "Antigravity key", browser: false, category: "key", runnable: false }],
    },
  ],
};

function byId(view) {
  return Object.fromEntries(view.providers.map((provider) => [provider.id, provider]));
}

test("the four presences and their counts survive a third source", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "cursor", "mystery-ai"], plugins: PLUGINS });
  expect(view.source).toBe("magpie");
  expect(view.magpie).toEqual({ available: true, count: 3 });
  expect(view.counts).toEqual({ total: 5, both: 1, localOnly: 2, magpieOnly: 2, pluginOnly: 0 });
  const map = byId(view);
  expect(map.antigravity.presence).toBe("local-only");
  expect(map.codex.presence).toBe("both");
  expect(map.claude.presence).toBe("local-only");
  expect(map.cursor.presence).toBe("magpie-only");
  expect(map["mystery-ai"].presence).toBe("magpie-only");
  for (const provider of view.providers) {
    expect(PROVIDER_PRESENCES).toContain(provider.presence);
    // The original `sources` shape is unchanged: the plugin layer is a
    // separate annotation, not a fourth presence.
    expect(provider.sources).toEqual({ local: Boolean(provider.sources.local), magpie: Boolean(provider.sources.magpie) });
  }
  expect(view.plugins).toEqual({ available: true, count: 3, browserMethods: 2, matched: 3 });
});

test("each card carries the derived methods and the browserMethod flag", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "cursor", "mystery-ai"], plugins: PLUGINS });
  const map = byId(view);
  expect(map.codex.browserMethod).toBe(true);
  expect(map.codex.authMethods).toEqual([
    { type: "oauth", label: "Codex (browser)", browser: true, category: "browser", prompts: [], runnable: true },
    { type: "oauth", label: "codex's sign-in", browser: false, category: "local", prompts: [], runnable: true },
    { type: "api", label: "Codex API key", browser: false, category: "key", prompts: [], runnable: false },
  ]);
  expect(map.codex.pluginPackage).toBe("@magpie-community/opencode-codex-auth");
  expect(map.antigravity.browserMethod).toBe(false);
  expect(map.antigravity.authMethods).toHaveLength(1);
  expect(map.cursor.browserMethod).toBe(true);
  // A provider with no plugin entry still gets an empty, typed annotation.
  expect(map.claude.authMethods).toEqual([]);
  expect(map.claude.browserMethod).toBe(false);
  expect(map.claude.pluginPackage).toBeNull();
  expect(map["mystery-ai"].authMethods).toEqual([]);
  expect(map["mystery-ai"].browserMethod).toBe(false);
});

test("a provider is matched by id or by the slug of its display name", () => {
  const plugins = {
    available: true,
    providers: [
      {
        id: "google-antigravity",
        package: "@magpie-community/opencode-antigravity-auth",
        methods: [{ type: "oauth", label: "Google Antigravity (browser)", browser: true }],
      },
    ],
  };
  const view = mergeProviderSources({ local: LOCAL, magpie: [], plugins });
  const card = byId(view).antigravity;
  expect(card.browserMethod).toBe(true);
  expect(card.pluginPackage).toBe("@magpie-community/opencode-antigravity-auth");
  // The card id is `antigravity`; the id the service loads the plugin by is the
  // installed entry's id, carried separately as `signInProvider`.
  expect(card.signInProvider).toBe("google-antigravity");
});

// The whole point of this step: a recognized browser method plus the installed
// plugin entry id is the sign-in gate, and capability readiness is not.
test("a recognized browser method creates the sign-in gate regardless of readiness", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "cursor"], plugins: PLUGINS });
  const map = byId(view);
  expect(providerCanSignIn(map.codex)).toBe(true);
  expect(providerCanSignIn(map.cursor)).toBe(true);
  // A key/local-session provider has no browser flow to drive.
  expect(providerCanSignIn(map.antigravity)).toBe(false);
  // A provider with no matched plugin entry has no id to load.
  expect(providerCanSignIn(map.claude)).toBe(false);
  // Readiness is not the gate: forcing one ready changes nothing.
  const forcedReady = { ...map.antigravity, capability: { ...map.antigravity.capability, state: "ready" } };
  expect(providerCanSignIn(forcedReady)).toBe(false);
  expect(JSON.stringify(view)).not.toMatch(/Add Account/);
});

test("the two states are worded apart in all four languages", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "cursor", "mystery-ai"], plugins: PLUGINS });
  const map = byId(view);

  // (a) a browser method was found, but the flow is not verified here.
  for (const provider of [map.codex, map.cursor]) {
    expect(provider.browserMethod).toBe(true);
    expect(provider.capability.state).toBe("pending");
    expect(provider.capability.reason.en).toContain("browser sign-in method");
    expect(provider.capability.reason.en).toContain("has not verified");
    for (const lang of LANGS) expect(provider.capability.reason[lang]).toBeTruthy();
  }

  // (b) the plugins were scanned and none of this provider's methods is a
  // browser flow.
  expect(map["mystery-ai"].browserMethod).toBe(false);
  expect(map["mystery-ai"].capability.reason.en).toContain("No browser sign-in method was found");
  for (const lang of LANGS) expect(map["mystery-ai"].capability.reason[lang]).toBeTruthy();

  // The local registry's curated reason is preserved when the plugin layer
  // finds no browser method for it.
  const claude = map.claude;
  expect(claude.browserMethod).toBe(false);
  expect(claude.capability.reason.en).toContain("Claude");
});

test("an unavailable plugin scan degrades to the first layer with no false claims", () => {
  for (const plugins of [undefined, null, { available: false, providers: [] }, 42]) {
    const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "mystery-ai"], plugins });
    expect(view.plugins.available).toBe(false);
    expect(view.plugins.count).toBe(0);
    const map = byId(view);
    for (const provider of view.providers) {
      expect(provider.browserMethod).toBe(false);
      expect(provider.authMethods).toEqual([]);
      expect(provider.pluginPackage).toBeNull();
    }
    // A magpie-only card keeps its original "not verified" wording, which does
    // not claim that no browser method exists.
    expect(map["mystery-ai"].capability.reason.en).toContain("has not verified its browser sign-in method");
    expect(view.counts).toEqual({ total: 4, both: 1, localOnly: 2, magpieOnly: 1, pluginOnly: 0 });
  }
});

// Root cause 3 regression: a scan that failed WITH an error used to be worded
// exactly like "this plugin has not verified the flow yet", which dresses a
// broken scan up as an unimplemented feature. The reason must name the failure
// and carry the raw diagnostic, on magpie-only cards and on local cards whose
// verdict still depends on the scan.
test("a failed plugin scan is worded as a failure, not as an unverified flow", () => {
  const failure = { available: false, providers: [], error: "dirent is not defined", scanned: true };
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "mystery-ai"], plugins: failure });
  const map = byId(view);
  for (const provider of [map.codex, map["mystery-ai"]]) {
    expect(provider.capability.reason.en).toContain("The installed-plugin scan failed");
    expect(provider.capability.reason.en).toContain("dirent is not defined");
    expect(provider.capability.reason.en).not.toContain("has not verified");
    for (const lang of LANGS) {
      expect(provider.capability.reason[lang]).toBeTruthy();
      expect(provider.capability.reason[lang]).toContain("dirent is not defined");
    }
  }
  // The old presence note repeated the same "not verified" claim; it now names
  // the failure too.
  expect(map["mystery-ai"].presenceNote.en).toContain("The installed-plugin scan failed");
  // The reason stays bounded even when the child reports a huge error.
  const huge = byId(mergeProviderSources({
    local: LOCAL,
    magpie: ["codex"],
    plugins: { available: false, providers: [], error: "x".repeat(5000), scanned: true },
  })).codex;
  expect(huge.capability.reason.en.length).toBeLessThan(600);
  // A scan that never ran has no failure to report, so it must NOT claim one.
  const never = byId(mergeProviderSources({
    local: LOCAL,
    magpie: ["mystery-ai"],
    plugins: { available: false, providers: [] },
  }));
  expect(never["mystery-ai"].capability.reason.en).toContain("has not verified its browser sign-in method");
});

test("a plugin-only provider gets a fifth-presence card with its derived methods", () => {
  const plugins = {
    available: true,
    providers: [
      { id: "kiro", package: "@magpie-community/opencode-kiro-auth", methods: [
        { type: "oauth", label: "Kiro (Google, GitHub, AWS Builder ID)", browser: false, category: "pending", runnable: true },
        { type: "api", label: "Kiro API key", browser: false, category: "key", runnable: false },
      ] },
    ],
  };
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex"], plugins });
  // A provider that is in neither the local registry nor magpie's recognized
  // list still gets a card, tagged with the fifth presence.
  expect(view.counts).toEqual({ total: 4, both: 1, localOnly: 2, magpieOnly: 0, pluginOnly: 1 });
  expect(view.plugins).toEqual({ available: true, count: 1, browserMethods: 0, matched: 1 });
  const kiro = byId(view).kiro;
  expect(kiro).toBeTruthy();
  expect(kiro.presence).toBe("plugin-only");
  expect(kiro.sources).toEqual({ local: false, magpie: false });
  expect(kiro.pluginPackage).toBe("@magpie-community/opencode-kiro-auth");
  expect(kiro.authMethods).toEqual([
    { type: "oauth", label: "Kiro (Google, GitHub, AWS Builder ID)", browser: false, category: "pending", prompts: [], runnable: true },
    { type: "api", label: "Kiro API key", browser: false, category: "key", prompts: [], runnable: false },
  ]);  expect(kiro.browserMethod).toBe(false);
  expect(kiro.unconfirmedMethod).toBe(true);
  expect(kiro.capability.state).toBe("pending");
  // The unknown method is not dressed up as a browser sign-in, but it is not
  // called "unknown" either: the scan says the kind is decided at sign-in time.
  expect(kiro.capability.reason.en).toContain("only known when the sign-in actually starts");
  expect(kiro.capability.reason.en).not.toContain("exposes a browser sign-in method");
  for (const lang of LANGS) {
    expect(kiro.description[lang]).toBeTruthy();
    expect(kiro.notice[lang]).toBeTruthy();
    expect(kiro.presenceNote[lang]).toBeTruthy();
    expect(kiro.capability.reason[lang]).toBeTruthy();
  }
  // The scan cannot tell what this flow does, but it IS a runnable method, so
  // the card offers the add entry: the page shown at sign-in is the truth.
  expect(providerCanSignIn(kiro)).toBe(true);
  expect(providerCanSignIn({ ...kiro, capability: { ...kiro.capability, state: "ready" } })).toBe(true);
  expect(PROVIDER_PRESENCES).toContain("plugin-only");
});

// A plugin-only provider with a browser-labelled method keeps the same honest
// wording as everywhere else and becomes signable through its own entry id.
test("a plugin-only provider with a browser method says the flow is not verified", () => {
  const plugins = {
    available: true,
    providers: [
      { id: "loomy", package: "@roadkid/opencode-loomy-auth", methods: [
        { type: "oauth", label: "Sign in with Loomy (browser)", browser: true, category: "browser", runnable: true },
      ] },
    ],
  };
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex"], plugins });
  const loomy = byId(view).loomy;
  expect(loomy.presence).toBe("plugin-only");
  expect(loomy.browserMethod).toBe(true);
  expect(loomy.signInProvider).toBe("loomy");
  expect(providerCanSignIn(loomy)).toBe(true);
  expect(loomy.capability.reason.en).toContain("browser sign-in method");
  expect(loomy.capability.reason.en).toContain("has not verified");
  for (const lang of LANGS) expect(loomy.capability.reason[lang]).toBeTruthy();
});

// Defect 3 regression: an ambiguous oauth provider (here ZCode's GLM Coding
// Plan) on a magpie-only card must not claim a browser method was identified,
// and must not be called "unknown" in the sense of "nothing was found": the
// flow's real kind is only knowable when authorize() runs.
test("an ambiguous oauth method on a magpie-only card is worded as to be confirmed, not browser", () => {
  const plugins = {
    available: true,
    providers: [
      { id: "zcode", package: "@magpie-community/opencode-zcode-auth", methods: [
        { type: "oauth", label: "ZCode: Z.ai GLM Coding Plan", browser: false, category: "pending", runnable: true },
      ] },
    ],
  };
  const view = mergeProviderSources({ local: LOCAL, magpie: ["zcode"], plugins });
  const zcode = byId(view).zcode;
  expect(zcode.presence).toBe("magpie-only");
  expect(zcode.browserMethod).toBe(false);
  expect(zcode.unconfirmedMethod).toBe(true);
  expect(zcode.signableMethod).toBe(true);
  expect(zcode.capability.reason.en).toContain("only known when the sign-in actually starts");
  expect(zcode.capability.reason.en).not.toContain("exposes a browser sign-in method");
  for (const lang of LANGS) expect(zcode.capability.reason[lang]).toBeTruthy();
});

test("the third-source merge stays public and leak-free", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["codex", "cursor", "mystery-ai"], plugins: PLUGINS });
  expect(JSON.stringify(view)).not.toMatch(
    /client[_-]?secret|client[_-]?id|access[_-]?token|refresh[_-]?token|api[_-]?key|password|authorize/i,
  );
});

test("vendor ids from community auth plugins line up with the local cards", () => {
  const view = mergeProviderSources({
    local: LOCAL,
    magpie: ["anthropic", "openai", "google"],
    plugins: {
      available: true,
      providers: [
        {
          id: "anthropic",
          package: "opencode-anthropic-auth",
          methods: [{ type: "oauth", label: "Claude Pro/Max", category: "pending", runnable: true }],
        },
        {
          id: "openai",
          package: "opencode-openai-codex-auth",
          methods: [
            { type: "oauth", label: "ChatGPT Plus/Pro (Codex Subscription)", category: "pending", runnable: true },
          ],
        },
        {
          id: "google",
          package: "opencode-antigravity-auth",
          methods: [{ type: "oauth", label: "OAuth with Google (Antigravity)", category: "pending", runnable: true }],
        },
      ],
    },
  });

  const claude = view.providers.find((provider) => provider.id === "claude");
  expect(claude.presence).toBe("both");
  expect(claude.signInProvider).toBe("anthropic");
  expect(claude.signableMethod).toBe(true);

  const codex = view.providers.find((provider) => provider.id === "codex");
  expect(codex.signInProvider).toBe("openai");
  expect(codex.signInMethods).toContain("ChatGPT Plus/Pro (Codex Subscription)");

  const antigravity = view.providers.find((provider) => provider.id === "antigravity");
  expect(antigravity.signInProvider).toBe("google");

  // No duplicate plugin-only card is invented for a provider an alias matched.
  expect(view.providers.some((provider) => provider.id === "openai")).toBe(false);
  expect(view.counts.pluginOnly).toBe(0);
});

// Regression: alias lookup used to read `PROVIDER_ALIASES[id]` directly, so a
// provider id that names an Object.prototype member ("constructor") returned a
// function and the page request failed. A prototype key is just an unknown id.
test("a provider id that collides with Object.prototype is handled as an id", () => {
  const view = mergeProviderSources({ local: LOCAL, magpie: ["constructor"], plugins: { available: true, providers: [] } });
  expect(view.providers.some((provider) => provider.id === "constructor")).toBe(true);
  // Other prototype members are normalized by the slug, but must never throw.
  for (const id of ["toString", "hasOwnProperty", "__proto__"]) {
    expect(() =>
      mergeProviderSources({ local: LOCAL, magpie: [id], plugins: { available: true, providers: [] } }),
    ).not.toThrow();
  }
});
