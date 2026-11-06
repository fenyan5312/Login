import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, publicProvider } from "../lib/provider-registry.mjs";
import { mergeProviderSources } from "../lib/provider-sources.mjs";
import {
  PLUGIN_SCAN_POLL_INTERVAL_MS,
  PLUGIN_SCAN_POLL_MAX_ATTEMPTS,
  localizedText,
  providerCanSignIn,
  providerStatusView,
  shouldPollPluginScan,
} from "../ui/provider-state.js";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "ui", "app.js"), "utf8");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");

test("the Provider tab renders cards from the Host bootstrap registry", () => {
  expect(app).toContain("renderProviders(providers)");
  expect(app).toContain("function providerCard(provider)");
  expect(app).toContain("providerStatusView(provider, text)");
  expect(app).toContain("localizedText(provider.description, langKey)");
  expect(app).toContain("localizedText(provider.capability?.reason, langKey)");
  expect(html).toContain('id="providers-list"');
  expect(html).toContain('class="provider-grid"');
  expect(html).not.toMatch(/mock|preview-badge|data-add/i);
});

test("pending providers show an honest status and reason", () => {
  for (const provider of PROVIDERS) {
    const view = providerStatusView(provider, {
      providerPending: "Pending verification",
      providerReady: "Ready",
      providerBlocked: "Blocked",
    });
    expect(view.state).toBe("pending");
    expect(view.label).toBe("Pending verification");
    expect(localizedText(provider.capability.reason, "en")).toContain("not been verified");
    for (const lang of ["zh-Hans", "zh-Hant", "ja"]) {
      expect(localizedText(provider.capability.reason, lang)).toBeTruthy();
    }
  }
});

test("the add entry gate is a browser method plus a plugin entry id, never readiness", () => {
  expect(providerCanSignIn({
    id: "codex",
    capability: { state: "pending" },
    browserMethod: true,
    signInProvider: "codex",
  })).toBe(true);
  // A browser method without the entry id cannot be loaded by the service.
  expect(providerCanSignIn({ browserMethod: true, signInProvider: null })).toBe(false);
  // A key/local method has no browser flow to drive.
  expect(providerCanSignIn({ browserMethod: false, signInProvider: "codex" })).toBe(false);
  // Readiness is deliberately not the gate; a ready card without a browser
  // method must still not grow an entry.
  expect(providerCanSignIn({ ...PROVIDERS[0], capability: { ...PROVIDERS[0].capability, state: "ready" } })).toBe(false);
});

test("a runnable method of any kind is offered, and a non-runnable one is not", () => {
  // The scan cannot tell a browser page from a device code, so a runnable
  // method is offered whatever kind it turns out to be.
  expect(providerCanSignIn({
    signableMethod: true,
    browserMethod: false,
    signInProvider: "zcode",
  })).toBe(true);
  // A method the scan saw without an authorize function cannot be run.
  expect(providerCanSignIn({
    signableMethod: false,
    browserMethod: false,
    signInProvider: "zcode",
  })).toBe(false);
  // A runnable method without the plugin entry id still cannot be loaded.
  expect(providerCanSignIn({
    signableMethod: true,
    browserMethod: false,
    signInProvider: null,
  })).toBe(false);
});

// Root cause 2 regression: the first /api/provider-sources read is answered
// while the installed-plugin scan child is still running, so its cards carry
// no sign-in methods. The page has to keep asking until the scan settles;
// otherwise every card stays on "waiting for verification" with no entry until
// the user reloads by hand.
test("a still-running plugin scan is polled, a settled or failed one is not", () => {
  expect(shouldPollPluginScan({ scanning: true, available: false, scanned: false })).toBe(true);
  // A stale cache is being refreshed in the background: its new entries are
  // worth waiting for too.
  expect(shouldPollPluginScan({ scanning: true, available: true, scanned: true, stale: true })).toBe(true);
  for (const settled of [
    { scanning: false, available: true, scanned: true },
    { scanning: false, available: false, error: "dirent is not defined" },
    { available: false, scanned: false },
    {},
    null,
    undefined,
  ]) {
    expect(shouldPollPluginScan(settled)).toBe(false);
  }
  // The poll is bounded, so a scan that never settles cannot leave an endless
  // loop (or an endless run of requests) behind.
  expect(PLUGIN_SCAN_POLL_MAX_ATTEMPTS).toBeGreaterThanOrEqual(20);
  expect(PLUGIN_SCAN_POLL_MAX_ATTEMPTS).toBeLessThanOrEqual(30);
  expect(PLUGIN_SCAN_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  expect(PLUGIN_SCAN_POLL_INTERVAL_MS).toBeLessThanOrEqual(2000);
});

test("the provider card wires a type=button add entry, never a submit control", () => {
  const card = /function providerCard\(provider\) \{[\s\S]*?\n\}/.exec(app)?.[0] || "";
  expect(card).toContain("providerCanSignIn(provider)");
  expect(card).toContain('add.type = "button"');
  expect(card).toContain("openSignInDialog(provider)");
  expect(card).toContain("text.addAccount");
  expect(card).not.toMatch(/type\s*=\s*"submit"/);
  expect(card).not.toMatch(/onclick=/);
});

test("a key-only or local-session provider renders no add entry", () => {
  const view = mergeProviderSources({
    local: PROVIDERS.map(publicProvider),
    magpie: ["codex"],
    plugins: {
      available: true,
      providers: [
        {
          id: "codex",
          package: "@x/codex",
          methods: [{ type: "api", label: "Codex API key", browser: false, category: "key" }],
        },
      ],
    },
  });
  const codex = view.providers.find((provider) => provider.id === "codex");
  expect(codex.browserMethod).toBe(false);
  for (const provider of view.providers) {
    expect(providerCanSignIn(provider)).toBe(false);
  }
});

test("no card copy stays prohibitive in any of the four languages", () => {
  const view = mergeProviderSources({
    local: PROVIDERS.map(publicProvider),
    magpie: ["codex", "mystery-ai"],
    plugins: {
      available: true,
      providers: [
        { id: "codex", package: "@x/codex", methods: [{ type: "oauth", label: "Codex (browser)", browser: true, category: "browser" }] },
        { id: "mystery-ai", package: "@x/mystery", methods: [{ type: "oauth", label: "Mystery (browser)", browser: true, category: "browser" }] },
      ],
    },
  });
  const banned = [
    /cannot be added/i,
    /can not be added/i,
    /can't be added/i,
    /不能添加/,
    /无法添加/,
    /無法新增/,
    /不能新增/,
    /追加できません/,
  ];
  for (const provider of view.providers) {
    for (const lang of ["en", "zh-Hans", "zh-Hant", "ja"]) {
      for (const value of [
        localizedText(provider.capability?.reason, lang),
        localizedText(provider.notice, lang),
        localizedText(provider.description, lang),
        localizedText(provider.presenceNote, lang),
      ]) {
        for (const pattern of banned) expect(value).not.toMatch(pattern);
      }
    }
  }
});

test("the proxy Save button survives magpie's allow-scripts-only sandbox", () => {
  // magpie mounts page plugins in <iframe sandbox="allow-scripts">, which has no
  // allow-forms token. The browser then blocks form submission before the
  // submit event fires, so any submit-type control is silently dead in magpie.
  // A submit event that never fires means saveProxy() never runs at all.
  // Therefore no control in this UI may rely on form submission; Save must be a
  // plain button with an explicit click handler.
  expect(html).not.toContain('type="submit"');

  const saveButton = /<button[^>]*id="save-proxy"[^>]*>/.exec(html)?.[0] || "";
  expect(saveButton).toContain('type="button"');

  const saveClick = /byId\("save-proxy"\)\.addEventListener\("click",[\s\S]*?\n\}\);/.exec(app)?.[0] || "";
  expect(saveClick).toContain("saveProxy()");
  // The submit listener stays for a normal (non-sandboxed) browser where Enter
  // still submits the form; the button is no longer a submit control, so a
  // click cannot double-trigger it.
  expect(app).toContain('byId("proxy-form").addEventListener("submit"');
});
