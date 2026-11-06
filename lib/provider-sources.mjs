// Pure normalization and merging of provider sources.
//
// The provider list is derived at page load from magpie's `providers:list`
// read and then merged with this plugin's static local registry. Everything
// here is a pure function: no network, no storage, no magpie runtime. It is
// safe to unit-test in isolation.
//
// UNVERIFIED: magpie's binary declares exactly two reads
// (`usage:summary`, `providers:list`) and `providers:list` is documented there
// as "your providers' names". The real payload shape has NOT been verified on
// this machine, because no magpie runtime is mounted for the tests. The
// normalizer is therefore deliberately tolerant and accepts several plausible
// shapes. Anything it cannot recognize is reported as "not available", so the
// UI falls back to the local registry rather than inventing providers.
//
// UNVERIFIED (by design): `providers:list` carries names only. It cannot tell
// us how a provider signs in. The local registry is the curated first source
// for that, and the installed provider plugins (see lib/magpie-plugins.mjs)
// are a second, derived source. A provider that magpie lists but this plugin
// does not know gets a card with no add entry and an honest reason.

export const MAGPIE_PROVIDERS_READ = "providers:list";

import { projectPrompts, requiresFormInput, requiresSecretInput } from "./magpie-plugins.mjs";

// Five presences. The first four only compare the local registry with
// magpie's own list. The fifth exists because an installed plugin can expose a
// provider that NEITHER source knows about:
//   both          in the local registry and in magpie's list
//   local-only    in the local registry, magpie's list was read and omits it
//   magpie-only   magpie's list was read and has it, the local registry does
//                 not
//   local-unknown magpie's list could not be read; only the local registry is
//                 known
//   plugin-only   NEITHER list has it, but an installed provider plugin
//                 exposes it. Unlike the other four it has no registry or list
//                 entry at all; its sign-in methods are derived from the
//                 installed plugin, and its card must say so.
export const PROVIDER_PRESENCES = Object.freeze([
  "both",
  "local-only",
  "magpie-only",
  "local-unknown",
  "plugin-only",
]);

// Localized, honest notes. The `magpie-only` reason doubles as the card's
// capability reason: the card exists but offers no way to add an account.
const PRESENCE_NOTES = Object.freeze({
  "local-only": Object.freeze({
    en: "magpie does not list this provider.",
    "zh-Hans": "magpie 里没有这个供应商。",
    "zh-Hant": "magpie 裡沒有這個供應商。",
    ja: "magpie にはこのプロバイダーがありません。",
  }),
});

const MAGPIE_ONLY = Object.freeze({
  description: Object.freeze({
    en: "Listed by magpie. This plugin has no verified sign-in flow for it yet.",
    "zh-Hans": "magpie 列出了这个供应商，但本插件还没有验证过它的登录流程。",
    "zh-Hant": "magpie 列出了這個供應商，但本外掛還沒有驗證過它的登入流程。",
    ja: "magpie に登録されていますが、このプラグインにはまだ検証済みのログインフローがありません。",
  }),
  notice: Object.freeze({
    en: "This card comes from magpie's provider list. It carries no add entry until this plugin has verified a browser sign-in flow.",
    "zh-Hans": "此卡片来自 magpie 的供应商名单。在本插件验证浏览器登录流程之前，它没有添加入口。",
    "zh-Hant": "此卡片來自 magpie 的供應商名單。在本外掛驗證瀏覽器登入流程之前，它沒有新增入口。",
    ja: "このカードは magpie のプロバイダー一覧に由来します。ブラウザーでのログインフローが検証されるまで、ここに追加の入口はありません。",
  }),
  reason: Object.freeze({
    en: "magpie lists this provider, but Login has not verified its browser sign-in method yet.",
    "zh-Hans": "magpie 列出了这个供应商，但 Login 还没有验证过它的浏览器登录方式。",
    "zh-Hant": "magpie 列出了這個供應商，但 Login 還沒有驗證過它的瀏覽器登入方式。",
    ja: "magpie に登録されていますが、Loginではブラウザーでのログイン方法がまだ検証されていません。",
  }),
});

// A scan that BROKE is not a flow that was never implemented. When the
// installed-plugin scan fails with an error (the child process crashed, timed
// out, or printed junk), every card that depends on it must name the failure
// and carry its raw diagnostic. Reusing the "has not verified" wording here
// would dress a broken scan up as missing work.
const PLUGIN_SCAN_FAILED = Object.freeze({
  en: "The installed-plugin scan failed ({error}). Because the scan itself broke, Login cannot tell which sign-in way this provider offers, so this card has no add entry.",
  "zh-Hans": "已安装插件扫描失败（{error}）。由于扫描本身出错，Login 无法判断这个供应商有哪些登录方式，因此这里没有添加入口。",
  "zh-Hant": "已安裝外掛掃描失敗（{error}）。由於掃描本身出錯，Login 無法判斷這個供應商有哪些登入方式，因此這裡沒有新增入口。",
  ja: "インストール済みプラグインのスキャンに失敗しました（{error}）。スキャン自体が失敗したため、このプロバイダーのログイン方法を判別できず、ここに追加の入口はありません。",
});

// The diagnostic travels into a public API response, so keep it a bounded
// single line: no stack trace, no enormous plugin output.
const MAX_SCAN_ERROR_LENGTH = 200;

// Derived from the second layer: the provider plugins magpie has actually
// installed (see lib/magpie-plugins.mjs). A method marked `browser` opens a
// browser sign-in; the clean-login flow for it has NOT been implemented yet,
// so recognizing it still must not create an add action.
const BROWSER_METHOD_FOUND = Object.freeze({
  en: "An installed magpie plugin exposes a browser sign-in method for this provider. Login has not verified this flow yet: you can try it directly, and any failure is reported honestly. Feedback is welcome.",
  "zh-Hans": "已安装的 magpie 插件为这个供应商提供了浏览器登录方式。Login 尚未验证该流程：你可以直接尝试，失败会如实报错，也欢迎反馈问题。",
  "zh-Hant": "已安裝的 magpie 外掛為這個供應商提供了瀏覽器登入方式。Login 尚未驗證該流程：你可以直接嘗試，失敗會如實回報，也歡迎回報問題。",
  ja: "インストール済みの magpie プラグインはこのプロバイダーのブラウザーログイン方法を公開しています。Loginではこのフローをまだ検証していません。そのまま試せますし、失敗はそのまま表示されますので、問題の報告も歓迎します。",
});

// The honest alternative: the installed plugins were scanned and none of this
// provider's methods is a browser flow.
const NO_BROWSER_METHOD = Object.freeze({
  en: "No browser sign-in method was found among the installed magpie plugins for this provider, so there is no add entry here.",
  "zh-Hans": "在已安装的 magpie 插件中没有找到这个供应商的浏览器登录方式，因此这里没有添加入口。",
  "zh-Hant": "在已安裝的 magpie 外掛中沒有找到這個供應商的瀏覽器登入方式，因此這裡沒有新增入口。",
  ja: "インストール済みの magpie プラグインには、このプロバイダーのブラウザーログイン方法が見つからなかったため、ここに追加の入口はありません。",
});

// A distinct outcome: the installed plugin exposes an oauth method that asks
// the user to type details in (a Start URL, a region, a phone number). That is
// a fill-in form, not a bare browser hand-off, and it is named honestly rather
// than as "unknown".
const FORM_METHOD_FOUND = Object.freeze({
  en: "An installed magpie plugin exposes a sign-in method for this provider that needs details typed in (for example a Start URL, a region or a phone number). Login has not verified this flow yet: you can try it directly, and any failure is reported honestly.",
  "zh-Hans": "已安装的 magpie 插件为这个供应商提供了需要填写信息的登录方式（例如 Start URL、区域或手机号）。Login 尚未验证该流程：你可以直接尝试，失败会如实报错。",
  "zh-Hant": "已安裝的 magpie 外掛為這個供應商提供了需要填寫資訊的登入方式（例如 Start URL、區域或手機號）。Login 尚未驗證該流程：你可以直接嘗試，失敗會如實回報。",
  ja: "インストール済みの magpie プラグインはこのプロバイダーの入力が必要なログイン方法（Start URL、リージョン、電話番号など）を公開しています。Loginではこのフローをまだ検証していません。そのまま試せますし、失敗はそのまま表示されます。",
});

// A distinct outcome: the installed plugin exposes an oauth method that asks
// the user to paste a secret (a Personal Access Token or a token). That is a
// paste-a-key flow, not a bare browser hand-off, and it is named honestly
// rather than as "unknown".
const SECRET_METHOD_FOUND = Object.freeze({
  en: "An installed magpie plugin exposes a sign-in method for this provider that asks for a secret you paste in (a Personal Access Token or a token). Login has not verified this flow yet: you can try it directly, and any failure is reported honestly.",
  "zh-Hans": "已安装的 magpie 插件为这个供应商提供了需要粘贴密钥的登录方式（个人访问令牌或 token）。Login 尚未验证该流程：你可以直接尝试，失败会如实报错。",
  "zh-Hant": "已安裝的 magpie 外掛為這個供應商提供了需要貼上密鑰的登入方式（個人存取權杖或 token）。Login 尚未驗證該流程：你可以直接嘗試，失敗會如實回報。",
  ja: "インストール済みの magpie プラグインはこのプロバイダーの、秘密の値を貼り付ける必要があるログイン方法（個人アクセストークンやトークン）を公開しています。Loginではこのフローをまだ検証していません。そのまま試せますし、失敗はそのまま表示されます。",
});

// A distinct outcome: the installed plugin exposes an oauth method with a real
// authorize() function, but nothing in the scan says what kind of flow it is
// (ZCode's per-site flows, Qoder's device code, MiniMax Code's device code).
// The scan cannot call authorize(), so the honest wording says the flow
// decides that at sign-in time. This is NOT a claim that a browser sign-in was
// identified, and it is NOT "nothing was found": a real, runnable method
// exists and is offered.
const PENDING_METHOD_FOUND = Object.freeze({
  en: "An installed magpie plugin exposes a sign-in method for this provider. Whether it opens a browser page is only known when the sign-in actually starts, so the page shown at sign-in is the source of truth. Login has not verified this flow yet.",
  "zh-Hans": "已安装的 magpie 插件为这个供应商提供了登录方式。它究竟是不是浏览器页面，只有真正开始登录时才知道，以登录时实际打开的页面为准。Login 尚未验证该流程。",
  "zh-Hant": "已安裝的 magpie 外掛為這個供應商提供了登入方式。它究竟是不是瀏覽器頁面，只有真正開始登入時才知道，以登入時實際開啟的頁面為準。Login 尚未驗證該流程。",
  ja: "インストール済みの magpie プラグインはこのプロバイダーのログイン方法を公開しています。ブラウザーのページを開くかどうかは実際にログインを始めたときにだけ分かるため、ログイン時に開くページが基準になります。Loginではこのフローをまだ検証していません。",
});

// The fifth presence: a provider that is in neither the local registry nor
// magpie's list, found only in an installed provider plugin. Its card says so
// in all four languages and carries the plugin-derived methods.
const PLUGIN_ONLY = Object.freeze({
  description: Object.freeze({
    en: "Not in Login's registry or in magpie's list. This provider was found in an installed magpie plugin.",
    "zh-Hans": "不在 Login 的注册表中，也不在 magpie 名单里。这个供应商来自已安装的 magpie 插件。",
    "zh-Hant": "不在 Login 的登錄檔中，也不在 magpie 名單裡。這個供應商來自已安裝的 magpie 外掛。",
    ja: "Loginの登録にも magpie の一覧にもありません。このプロバイダーはインストール済みの magpie プラグインから見つかりました。",
  }),
  note: Object.freeze({
    en: "This card comes only from an installed provider plugin. magpie's provider list does not include it, and the sign-in methods below are derived from that plugin.",
    "zh-Hans": "此卡片仅来自已安装的供应商插件。magpie 的供应商名单里没有它，下面的登录方式派生自该插件。",
    "zh-Hant": "此卡片僅來自已安裝的供應商外掛。magpie 的供應商名單裡沒有它，下面的登入方式衍生自該外掛。",
    ja: "このカードはインストール済みのプロバイダープラグインだけに由来します。magpie のプロバイダー一覧には含まれておらず、以下のログイン方法はそのプラグインから導出したものです。",
  }),
  reason: Object.freeze({
    en: "This provider and its sign-in methods come from an installed magpie plugin. Login has not verified that flow yet.",
    "zh-Hans": "这个供应商及其登录方式来自已安装的 magpie 插件。Login 尚未验证该流程。",
    "zh-Hant": "這個供應商及其登入方式來自已安裝的 magpie 外掛。Login 尚未驗證該流程。",
    ja: "このプロバイダーとログイン方法はインストール済みの magpie プラグインに由来します。Loginではそのフローをまだ検証していません。",
  }),
});

// The methods come from the scan with a typed `category`. Older fixtures only
// carry the boolean `browser`; treat that as the browser category so both
// shapes classify the same way.
function isBrowserMethod(method) {
  return method?.browser === true || method?.category === "browser";
}

function isFormMethod(method) {
  return method?.category === "form";
}

function isSecretMethod(method) {
  return method?.category === "secret";
}

// A method the user can actually run: an interactive oauth method that is not a
// local-session reuse and really carries an authorize function. The scan cannot
// tell a browser page from a device code or another hand-off, so all of those
// are signable and the real kind is reported at sign-in time.
function isSignableMethod(method) {
  if (method?.type !== "oauth") return false;
  if (methodCategoryOf(method) === "local") return false;
  // A method the scan saw without an authorize function cannot be run.
  return method?.runnable === true;
}

// The categories a card leads with. The scan can name a browser sign-in, a
// fill-in form, a pasted key and a local session outright. A runnable oauth
// method whose kind is not named by its label is `pending`: it IS offered, and
// its real kind is reported at sign-in time. The most specific kind found wins,
// so a provider that offers both a browser sign-in and a local session leads
// with the browser one.
const CATEGORY_PRIORITY = Object.freeze([
  "browser",
  "secret",
  "form",
  "pending",
  "local",
  "key",
]);

// The honest capability reason for a plugin-derived card, chosen by what the
// scan actually saw, most specific first. Returns null when no plugin method was
// found, so the caller keeps its own curated wording.
function pluginMethodReason({ primaryCategory }) {
  if (primaryCategory === "browser") return { ...BROWSER_METHOD_FOUND };
  if (primaryCategory === "secret") return { ...SECRET_METHOD_FOUND };
  if (primaryCategory === "form") return { ...FORM_METHOD_FOUND };
  if (primaryCategory === "pending") return { ...PENDING_METHOD_FOUND };
  return null;
}

// The localized reason for a scan that reported an error, with the raw
// diagnostic substituted into every language. Returns null when there is no
// error to report, so a scan that merely never ran keeps the "not verified"
// wording instead of claiming a failure it cannot prove.
function scanFailureReason(error) {
  if (typeof error !== "string" || !error.trim()) return null;
  const detail = error.replace(/\s+/g, " ").trim().slice(0, MAX_SCAN_ERROR_LENGTH);
  const reason = {};
  for (const [lang, message] of Object.entries(PLUGIN_SCAN_FAILED)) {
    reason[lang] = message.replace("{error}", detail);
  }
  return reason;
}

// The derived flags every plugin-derived card carries. `primaryCategory` is the
// kind the card leads with; `unconfirmedMethod` marks an oauth method whose
// kind the scan cannot know (ZCode's per-site flows). It is deliberately
// separate from `unknownMethod`, which is now reserved for a method type the
// scan does recognize but cannot classify.
function methodFlags(methods) {
  const categories = methods
    .filter(isPlainObject)
    .map((method) => methodCategoryOf(method))
    .filter((category) => CATEGORY_PRIORITY.includes(category));
  let primaryCategory = null;
  for (const category of CATEGORY_PRIORITY) {
    if (categories.includes(category)) {
      primaryCategory = category;
      break;
    }
  }
  return {
    primaryCategory,
    browserMethod: methods.some(isBrowserMethod),
    formMethod: methods.some(isFormMethod),
    secretMethod: methods.some(isSecretMethod),
    signableMethod: methods.some(isSignableMethod),
    unconfirmedMethod: methods.some(
      (method) => method?.type === "oauth" && methodCategoryOf(method) === "pending",
    ),
    unknownMethod: methods.some(
      (method) => method?.type === "oauth" && methodCategoryOf(method) === "unknown",
    ),
    // The runnable methods the user may choose between, in the plugin's own
    // order. ZCode exposes several (one per site), and signing in to the
    // wrong site yields the wrong token, so the dialog offers a choice
    // instead of silently taking the first one. Only the label travels: it is
    // the exact key the service looks the method up by.
    signInMethods: methods
      .filter(isSignableMethod)
      .map((method) => (typeof method.label === "string" ? method.label : ""))
      .filter((label) => label.length > 0),
  };
}

// The category of one scanned method, tolerating the older shapes: the typed
// `category` first, then the boolean `browser`, then the method type.
function methodCategoryOf(method) {
  const category = typeof method?.category === "string" ? method.category : "";
  if (CATEGORY_PRIORITY.includes(category) || category === "unknown") return category;
  if (method?.browser === true) return "browser";
  if (method?.type === "api" || method?.type === "key") return "key";
  return "unknown";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function itemFromEntry(entry) {
  if (typeof entry === "string") {
    const id = slug(entry);
    return id ? { id, name: entry.trim() } : null;
  }
  if (!isPlainObject(entry)) return null;
  const rawId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
  const rawName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "";
  const id = slug(rawId || rawName);
  if (!id) return null;
  return { id, name: rawName || rawId || id };
}

function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

function unavailable() {
  return { available: false, items: [] };
}

function recognized(items) {
  return { available: true, items: dedupe(items) };
}

function normalizeList(payload) {
  if (payload === null || payload === undefined) return unavailable();
  if (typeof payload === "string") {
    const item = itemFromEntry(payload);
    return item ? recognized([item]) : unavailable();
  }
  if (Array.isArray(payload)) {
    return recognized(payload.map(itemFromEntry).filter(Boolean));
  }
  if (isPlainObject(payload)) {
    if (Array.isArray(payload.providers)) return normalizeList(payload.providers);
    if (Array.isArray(payload.names)) return normalizeList(payload.names);
    if (Array.isArray(payload.items)) return normalizeList(payload.items);
    const item = itemFromEntry(payload);
    if (item) return recognized([item]);
  }
  return unavailable();
}

// Accepts the raw magpie value, the { ok, value } envelope written by
// page/boot.js, or a plain { ok, providers } style object. Returns
// { available, items } where `available` means "we recognized an actual list".
export function normalizeMagpieProviders(payload) {
  if (isPlainObject(payload) && typeof payload.ok === "boolean") {
    if (!payload.ok) return unavailable();
    if ("value" in payload) return normalizeList(payload.value);
    // A payload such as { ok: true, providers: [...] } is treated as raw.
  }
  return normalizeList(payload);
}

function magpieOnlyProvider(item, pluginItem, pluginAvailable, scanFailure) {
  const methods = pluginItem ? pluginItem.methods : [];
  const flags = methodFlags(methods);
  const reason = pluginAvailable
    ? pluginMethodReason(flags) ?? { ...NO_BROWSER_METHOD }
    : scanFailure ?? { ...MAGPIE_ONLY.reason };
  // When the plugin layer was scanned, the capability reason is the honest
  // statement of whether a browser method exists, so the generic presence note
  // is dropped rather than repeating a "not verified" claim beside it. A failed
  // scan repeats its own reason here, because the card has no second line that
  // could carry the diagnostic.
  const presenceNote = pluginAvailable ? null : { ...reason };
  return {
    id: item.id,
    name: item.name,
    mark: { kind: "letter", text: item.name.slice(0, 1).toUpperCase(), tone: "neutral" },
    description: { ...MAGPIE_ONLY.description },
    agentId: item.id,
    signInMode: "unknown",
    linkOnly: true,
    authHosts: [],
    callbackPort: null,
    notice: { ...MAGPIE_ONLY.notice },
    capability: { state: "pending", reason },
    presence: "magpie-only",
    presenceNote,
    sources: { local: false, magpie: true },
    // Second-layer derivation. `browserMethod` only reports what was found;
    // the page decides whether to offer the add entry from the signable flags
    // plus `signInProvider` (see ui/provider-state.js). The plugin entry id is
    // carried explicitly because the card id may come from magpie's list or a
    // display-name slug and need not equal the installed plugin entry's id,
    // while the service loads the plugin by `scan.providers[].id`.
    authMethods: methods,
    ...flags,
    signInProvider: pluginItem ? pluginItem.id : null,
    pluginPackage: pluginItem ? pluginItem.package : null,
  };
}

// A card for a provider that exists only in the installed-plugin scan. It has
// no registry or magpie-list entry, so it borrows no local capability fields;
// its honest description says where it came from, and its methods are the
// plugin-derived ones.
function pluginOnlyProvider(item) {
  const methods = item.methods;
  const flags = methodFlags(methods);
  const reason = pluginMethodReason(flags) ?? { ...PLUGIN_ONLY.reason };
  return {
    id: item.id,
    name: item.id,
    mark: { kind: "letter", text: item.id.slice(0, 1).toUpperCase(), tone: "neutral" },
    description: { ...PLUGIN_ONLY.description },
    agentId: item.id,
    signInMode: "unknown",
    linkOnly: true,
    authHosts: [],
    callbackPort: null,
    notice: { ...PLUGIN_ONLY.note },
    capability: { state: "pending", reason },
    presence: "plugin-only",
    presenceNote: { ...PLUGIN_ONLY.note },
    sources: { local: false, magpie: false },
    authMethods: methods,
    ...flags,
    // A plugin-only card is keyed by the plugin entry itself, so its id is
    // already the id the service loads the provider by.
    signInProvider: item.id,
    pluginPackage: item.package,
  };
}

// The read is documented as "your providers' names", so we cannot assume an
// entry carries magpie's id. Match on every key an entry could key on: its id
// and the slug of its display name. `slug("Google Antigravity")` is
// `google-antigravity` while our registry id is `antigravity`, and a name-only
// payload would otherwise be reported as "not in magpie" for a provider magpie
// really has.
function matchKeys(id, name) {
  const keys = new Set();
  if (typeof id === "string" && id.trim()) keys.add(slug(id));
  if (typeof name === "string" && name.trim()) keys.add(slug(name));
  keys.delete("");
  return keys;
}

// Normalize the plugin scan (the second layer) into `{ available, items }`.
// `browser` is trusted only when it is literally `true`; every method is
// projected to public strings, a typed category and the public-safe `prompts`
// shape, so no authorize function and no entered value can leak. An
// absent/unknown scan degrades to unavailable without throwing.
function pluginMethods(entry) {
  if (!Array.isArray(entry.methods)) return [];
  return entry.methods
    .filter((method) => isPlainObject(method))
    .map((method) => {
      const type = typeof method.type === "string" ? method.type : "";
      const browser = method.browser === true;
      const prompts = projectPrompts(method.prompts);
      // Whether the plugin's method really carries an authorize function.
      // The scan never calls it, but it can see that it is there, and that is
      // what makes a method runnable at sign-in time. A legacy fixture without
      // the flag falls back to the browser marker, which only ever became true
      // for an oauth method that had one.
      const runnable = typeof method.runnable === "boolean" ? method.runnable : browser;
      // Production scans arrive categorized; fixtures may only carry the
      // boolean and/or raw prompts. Fall back to those so a form or a key
      // method never reads as unknown, and a runnable method whose kind the
      // label does not name reads as pending (offered, kind unconfirmed).
      const category =
        typeof method.category === "string" && method.category
          ? method.category
          : browser
            ? "browser"
            : requiresSecretInput(prompts)
              ? "secret"
              : requiresFormInput(prompts)
                ? "form"
                : type === "api" || type === "key"
                  ? "key"
                  : runnable
                    ? "pending"
                    : "unknown";
      return {
        type,
        label: typeof method.label === "string" ? method.label : "",
        browser,
        category,
        prompts,
        runnable,
      };
    });
}

function normalizePlugins(payload) {
  if (!isPlainObject(payload) || payload.available !== true || !Array.isArray(payload.providers)) {
    const error = isPlainObject(payload) && typeof payload.error === "string" ? payload.error : "";
    return { available: false, items: [], error: error || null };
  }
  const seen = new Set();
  const items = [];
  for (const entry of payload.providers) {
    if (!isPlainObject(entry)) continue;
    const id = slug(typeof entry.id === "string" ? entry.id : "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      package: typeof entry.package === "string" && entry.package ? entry.package : null,
      methods: pluginMethods(entry),
    });
  }
  return { available: true, items, error: null };
}

// Plugin entries key on the provider id magpie's runtime uses, so the same
// tolerant matchKeys() comparison that lines local cards up with magpie's
// list is reused here.
function pluginIndex(items) {
  const map = new Map();
  for (const item of items) {
    for (const key of matchKeys(item.id, null)) {
      if (!map.has(key)) map.set(key, item);
    }
  }
  return map;
}

function pluginFor(provider, index) {
  for (const key of matchKeys(provider.id, provider.name)) {
    const item = index.get(key);
    if (item) return item;
  }
  return null;
}

// Merge the local registry with a (possibly unrecognized) magpie list.
// `local` must already be the public projection of local providers. The
// result is JSON-serializable and carries:
//   source   "magpie" when the magpie list was recognized (even if empty),
//            "local" when it was not available and we degraded to the local
//            registry;
//   magpie   { available, count };
//   plugins  { available, count, browserMethods, matched } for the installed
//            plugin layer;
//   counts   { total, both, localOnly, magpieOnly, pluginOnly };
//   providers  the merged cards, each tagged with `presence`, `presenceNote`,
//            `sources`, and the second-layer `authMethods` / `browserMethod` /
//            `unknownMethod` / `pluginPackage`.
export function mergeProviderSources({ local = [], magpie, plugins } = {}) {
  const read = normalizeMagpieProviders(magpie);
  const available = read.available;
  const pluginRead = normalizePlugins(plugins);
  // A scan that reported an error is a broken scan, not an unimplemented flow;
  // every card that is still waiting on it says so with its raw diagnostic.
  const pluginScanFailure = pluginRead.available ? null : scanFailureReason(pluginRead.error);
  const pluginByKey = pluginIndex(pluginRead.items);
  const magpieKeys = new Set();
  for (const item of read.items) {
    for (const key of matchKeys(item.id, item.name)) magpieKeys.add(key);
  }
  const consumed = new Set();
  // Plugin entries already attached to a local or magpie-only card. Whatever
  // is left and is in neither list becomes a fifth-presence plugin-only card.
  const consumedPlugins = new Set();

  const providers = [];
  let both = 0;
  let localOnly = 0;
  let magpieOnly = 0;
  let pluginOnly = 0;
  let matchedPlugins = 0;
  let browserMethodPlugins = 0;
  for (const item of pluginRead.items) {
    if (item.methods.some(isBrowserMethod)) browserMethodPlugins += 1;
  }

  for (const provider of local) {
    const keys = [...matchKeys(provider.id, provider.name)];
    const inMagpie = available && keys.some((key) => magpieKeys.has(key));
    if (inMagpie) {
      for (const item of read.items) {
        const itemKeys = [...matchKeys(item.id, item.name)];
        if (itemKeys.some((key) => keys.includes(key))) consumed.add(item);
      }
    }
    let presence;
    let presenceNote;
    if (!available) {
      presence = "local-unknown";
      presenceNote = null;
    } else if (inMagpie) {
      presence = "both";
      presenceNote = null;
    } else {
      presence = "local-only";
      presenceNote = { ...PRESENCE_NOTES["local-only"] };
    }
    if (inMagpie) both += 1;
    else if (available) localOnly += 1;

    const pluginItem = pluginFor(provider, pluginByKey);
    const methods = pluginItem ? pluginItem.methods : [];
    const flags = methodFlags(methods);
    if (pluginItem) {
      matchedPlugins += 1;
      consumedPlugins.add(pluginItem);
    }

    // The local registry's own reason is curated per provider; keep it. Only a
    // recognized plugin method (a browser one, a form one, or one whose kind is
    // only knowable at sign-in time) replaces it with the honest plugin-layer
    // wording. A local card with none keeps its existing per-provider reason,
    // UNLESS the plugin scan itself failed: a provider whose verdict is still
    // pending then says the scan broke, because "not verified yet" would hide
    // the failure that actually explains the missing add entry. A card the
    // registry already decided (ready/blocked) keeps its verdict.
    const pluginReason = pluginMethodReason(flags);
    const capability = pluginReason
      ? { state: provider.capability.state, reason: pluginReason }
      : pluginScanFailure && provider.capability.state === "pending"
        ? { state: provider.capability.state, reason: { ...pluginScanFailure } }
        : provider.capability;

    providers.push({
      ...provider,
      capability,
      presence,
      presenceNote,
      sources: { local: true, magpie: inMagpie },
      authMethods: methods,
      ...flags,
      signInProvider: pluginItem ? pluginItem.id : null,
      pluginPackage: pluginItem ? pluginItem.package : null,
    });
  }

  if (available) {
    for (const item of read.items) {
      if (consumed.has(item)) continue;
      const pluginItem = pluginFor(item, pluginByKey);
      if (pluginItem) {
        matchedPlugins += 1;
        consumedPlugins.add(pluginItem);
      }
      providers.push(magpieOnlyProvider(item, pluginItem, pluginRead.available, pluginScanFailure));
      magpieOnly += 1;
    }

    // Fifth presence: a provider in neither the local registry nor magpie's
    // recognized list that an installed plugin exposes. Only added when the
    // magpie list was read, because "plugin-only" claims the list omits it and
    // we must not make that claim about a list we never read.
    for (const pluginItem of pluginRead.items) {
      if (consumedPlugins.has(pluginItem)) continue;
      providers.push(pluginOnlyProvider(pluginItem));
      pluginOnly += 1;
      matchedPlugins += 1;
    }
  }

  return {
    source: available ? "magpie" : "local",
    magpie: { available, count: read.items.length },
    plugins: {
      available: pluginRead.available,
      count: pluginRead.items.length,
      browserMethods: browserMethodPlugins,
      matched: matchedPlugins,
    },
    counts: { total: providers.length, both, localOnly, magpieOnly, pluginOnly },
    providers,
  };
}
