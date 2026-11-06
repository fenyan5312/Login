// Pure helpers for provider cards. The Host owns the capability registry; the
// page only decides how to present its public fields.

export function localizedText(value, lang = "en") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value[lang] === "string" && value[lang]) return value[lang];
  if (typeof value.en === "string" && value.en) return value.en;
  for (const candidate of Object.values(value)) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

export function providerStatusView(provider = {}, labels = {}) {
  const state = provider?.capability?.state;
  if (state === "ready") {
    return { state: "ready", label: labels.providerReady || "Ready" };
  }
  if (state === "blocked") {
    return { state: "blocked", label: labels.providerBlocked || "Blocked" };
  }
  return { state: "pending", label: labels.providerPending || "Pending verification" };
}

// A card offers the add-account entry when the installed plugin scan exposed a
// signable sign-in method AND the merge carried the installed plugin entry id
// the service loads the provider by (`signInProvider`). Capability readiness is
// deliberately NOT a gate: an unverified flow is exactly the one users should
// be able to try so they can report what happens. Pure, so the rule is testable
// without a DOM.
//
// "Signable" is broader than "browser": the scan cannot call authorize(), so it
// cannot tell a browser page from a device code. A method whose kind is only
// knowable at sign-in time (ZCode's per-site flows) is still offered; the page
// shown at sign-in is the source of truth.
export function providerCanSignIn(provider) {
  // The new flag decides when the card carries it: a method is offered when it
  // is runnable, whatever kind it turns out to be. Older cards only carry the
  // boolean `browser`.
  if (typeof provider?.signableMethod === "boolean") {
    return provider.signableMethod && Boolean(provider?.signInProvider);
  }
  return Boolean(provider?.browserMethod && provider?.signInProvider);
}

// --- the main list and the one collapsed catalog -------------------------
//
// The page shows what a user can sign in to right now in the main list and
// keeps every other subscription provider in a single collapsed region. The
// split is drawn from card fields only: a later account read may reorder the
// main list, but it never moves a card from one region to the other.
//
// "Usable now" needs two things, and neither of them is capability readiness:
// magpie has the provider enabled (its list carried the id, so the merge says
// `both` or `magpie-only`) and the installed-plugin scan exposed a runnable
// sign-in method. A provider magpie does not know about cannot receive the
// account the plugin writes, so a signable card for one waits in the collapsed
// region until magpie has it.
export function providerIsPrimary(provider = {}) {
  const presence = provider?.presence;
  const knownToMagpie = presence === "both" || presence === "magpie-only";
  return knownToMagpie && providerCanSignIn(provider);
}

// The collapsed region is the page's completeness promise: every subscription
// service the local data knows about appears there, including the magpie-native
// ones this plugin has no sign-in flow for. A local model runner is a chat
// endpoint on this computer, not a subscription to sign in to, and magpie's
// `providers:list` carries names only (no kind), so the handful of
// non-subscription ids are named here instead of guessed from a name.
export const NON_SUBSCRIPTION_PROVIDER_IDS = Object.freeze(["llama-local"]);

export function providerIsSubscription(provider = {}) {
  const id = String(provider?.id || "").trim().toLowerCase();
  if (!id) return false;
  return !NON_SUBSCRIPTION_PROVIDER_IDS.includes(id);
}

function accountCountOf(accountCounts, id) {
  if (!accountCounts) return 0;
  const raw = typeof accountCounts.get === "function" ? accountCounts.get(id) : accountCounts[id];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Pure split, so the rule is testable without a DOM. `accountCounts` only
// orders the main list (the exits with the most accounts first); it never
// decides which region a card lands in. When magpie's list could not be read
// nothing can be called "usable now", and hiding every card behind a closed
// fold would be worse than the old single grid, so the split then degrades to
// "everything in the main list".
export function partitionProviders(items = [], accountCounts = {}) {
  const cards = (Array.isArray(items) ? items : []).filter((item) => item && item.id);
  const magpieKnown = cards.some(
    (item) => item.presence === "both" || item.presence === "magpie-only",
  );
  const primary = [];
  const other = [];
  for (const provider of cards) {
    if (!providerIsSubscription(provider)) continue;
    if (!magpieKnown || providerIsPrimary(provider)) primary.push(provider);
    else other.push(provider);
  }
  primary.sort(
    (left, right) =>
      accountCountOf(accountCounts, right.id) - accountCountOf(accountCounts, left.id) ||
      String(left.name || left.id).localeCompare(String(right.name || right.id)),
  );
  return { primary, other };
}

// A provider card's add entry comes from the installed-plugin scan, and that
// scan starts on the first /api/provider-sources read. The first answer
// therefore says `scanning: true` and carries no sign-in methods, so without a
// follow-up read every card would sit on "waiting for verification" with no
// entry until the user reloads the page by hand. The page follows the scan
// with a bounded number of extra reads; these are the bounds, and they are
// exported so the bound itself is testable.
export const PLUGIN_SCAN_POLL_INTERVAL_MS = 1200;
export const PLUGIN_SCAN_POLL_MAX_ATTEMPTS = 24;

// Pure decision: is there still a scan in flight whose result the cards need?
// A settled scan (`scanning: false`), including one that failed with an error,
// must not keep the loop alive.
export function shouldPollPluginScan(pluginScan) {
  return pluginScan?.scanning === true;
}

// The kinds a card marker can name. "pending" does not mean "nothing was
// found": it means the method is runnable but its kind is only confirmed when
// authorize() runs, so the card says "way to confirm" instead of "unknown".
// "device" is a real, confirmed kind (a device code the user confirms in the
// browser) and gets its own wording rather than falling back to "unknown".
export const METHOD_CATEGORY_TAGS = Object.freeze([
  "browser",
  "device",
  "form",
  "key",
  "local",
  "pending",
  "secret",
  "unknown",
]);

// The category of one scanned method. Prefer the scan's typed category; older
// shapes only carry the boolean `browser` and the type, so derive it from those.
export function methodCategory(method = {}) {
  const category = typeof method?.category === "string" ? method.category : "";
  if (METHOD_CATEGORY_TAGS.includes(category)) return category;
  if (method?.browser === true) return "browser";
  if (method?.type === "api" || method?.type === "key") return "key";
  return "unknown";
}

// The marker text for one category, in the page's language. Kept next to
// methodCategory() so the kind -> wording mapping is testable without a DOM.
export function methodCategoryText(category, text = {}) {
  if (category === "browser") return text.providerMethodBrowserTag || "browser";
  if (category === "device") return text.providerMethodDeviceTag || "device code";
  if (category === "form") return text.providerMethodFormTag || "needs details";
  if (category === "key") return text.providerMethodKeyTag || "key";
  if (category === "local") return text.providerMethodLocalTag || "local session";
  if (category === "secret") return text.providerMethodSecretTag || "paste a token";
  if (category === "pending") return text.providerMethodPendingTag || "way to confirm";
  return text.providerMethodUnknownTag || "way to confirm";
}
