// A read-only verification against the REAL installed magpie plugins.
//
// It imports nothing from the plugin: it runs the same child scan the service
// runs, then applies the service's own normalization and merge, and prints the
// category of every method of every installed provider.
//
// Nothing is written anywhere: the scan only reads the plugin directory, and
// the scan's authorize() is never called.
//
// Run it with:
//   bun test/evidence/scan-real-plugins.mjs
// The config directory can be overridden with MAGPIE_CONFIG_DIR.

import { scanMagpiePlugins } from "../../lib/magpie-plugins.mjs";
import { mergeProviderSources } from "../../lib/provider-sources.mjs";
import { listProviders } from "../../lib/provider-registry.mjs";
import { methodCategory } from "../../ui/provider-state.js";

const scan = await scanMagpiePlugins({
  timeoutMs: 30000,
  env: {
    ...process.env,
    MAGPIE_CONFIG_DIR:
      process.env.MAGPIE_CONFIG_DIR || "/mnt/c/Users/Administrator/.config/magpie",
  },
});
console.log("scan available:", scan.available, "providers:", scan.providers.length);

const view = mergeProviderSources({
  local: listProviders(),
  magpie: scan.providers.map((provider) => provider.id),
  plugins: scan,
});

const rows = [];
for (const provider of view.providers) {
  for (const method of provider.authMethods) {
    rows.push({
      provider: provider.id,
      label: method.label,
      type: method.type,
      category: methodCategory(method),
      scanCategory: method.category,
      runnable: method.runnable,
      prompts:
        (method.prompts || []).map((prompt) => `${prompt.type}:${prompt.key}`).join(",") || "-",
      primaryCategory: provider.primaryCategory,
      signInMethods: (provider.signInMethods || []).length,
    });
  }
}
console.log(JSON.stringify(rows, null, 1));
