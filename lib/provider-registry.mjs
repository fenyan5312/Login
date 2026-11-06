// Static, auditable provider capability registry.
//
// This file describes what a provider would need before this plugin may add an
// account. It performs no sign-in, stores no credentials and contains no
// client ids, secrets or guessed endpoints. Auth hosts are hostnames only; the
// callback ports are reserved for the future isolated-browser flow and remain
// provisional until that flow is verified.
//
// A provider must never be marked "ready" here until its real sign-in flow has
// been implemented and verified in a later step. Until then every card stays
// pending or blocked, with a human-readable reason.

export const PROVIDER_CAPABILITY_STATES = Object.freeze(["pending", "ready", "blocked"]);

const notVerifiedNotice = {
  en: "No sign-in is implemented yet. The auth host and callback port are provisional and unverified.",
  "zh-Hans": "尚未实现登录。认证主机与回调端口是暂定且未经验证的。",
  "zh-Hant": "尚未實作登入。驗證主機與回呼連接埠是暫定且未經驗證的。",
  ja: "ログインはまだ実装されていません。認証ホストとコールバックポートは暫定値で、未検証です。",
};

const definitions = [
  {
    // magpie's own provider id is `antigravity`; matching it is what lets the
    // runtime-derived list line up with this registry instead of reporting a
    // provider magpie has as "not in magpie".
    id: "antigravity",
    name: "Google Antigravity",
    mark: { kind: "letter", text: "A", tone: "blue" },
    description: {
      en: "Google's agent-first coding IDE. Sign-in will use Google's own account page in an isolated browser.",
      "zh-Hans": "Google 的智能体编程 IDE。登录将在隔离浏览器中使用 Google 自己的账号页面。",
      "zh-Hant": "Google 的代理式程式設計 IDE。登入將在隔離瀏覽器中使用 Google 自己的帳號頁面。",
      ja: "Google のエージェント型コーディング IDE。ログインは隔離されたブラウザーで Google のアカウントページを使用します。",
    },
    agentId: "antigravity",
    signInMode: "browser-oauth",
    linkOnly: true,
    authHosts: ["accounts.google.com"],
    callbackPort: 45171,
    notice: notVerifiedNotice,
    capability: {
      state: "pending",
      reason: {
        en: "The Antigravity sign-in flow has not been verified in this plugin yet.",
        "zh-Hans": "本插件尚未验证 Antigravity 的登录流程。",
        "zh-Hant": "本外掛尚未驗證 Antigravity 的登入流程。",
        ja: "このプラグインでは Antigravity のログインフローがまだ検証されていません。",
      },
    },
  },
  {
    id: "codex",
    name: "Codex",
    mark: { kind: "letter", text: "Cx", tone: "green" },
    description: {
      en: "OpenAI's Codex coding agent. Sign-in will use OpenAI's account flow in an isolated browser.",
      "zh-Hans": "OpenAI 的 Codex 编程智能体。登录将在隔离浏览器中使用 OpenAI 的账号流程。",
      "zh-Hant": "OpenAI 的 Codex 程式設計代理。登入將在隔離瀏覽器中使用 OpenAI 的帳號流程。",
      ja: "OpenAI の Codex コーディングエージェント。ログインは隔離されたブラウザーで OpenAI のアカウントフローを使用します。",
    },
    agentId: "codex",
    signInMode: "browser-oauth",
    linkOnly: true,
    authHosts: ["auth.openai.com"],
    callbackPort: 45172,
    notice: notVerifiedNotice,
    capability: {
      state: "pending",
      reason: {
        en: "The Codex browser sign-in and callback handling have not been verified in this plugin yet.",
        "zh-Hans": "本插件尚未验证 Codex 的浏览器登录与回调处理。",
        "zh-Hant": "本外掛尚未驗證 Codex 的瀏覽器登入與回呼處理。",
        ja: "このプラグインでは Codex のブラウザーログインとコールバック処理がまだ検証されていません。",
      },
    },
  },
  {
    id: "claude",
    name: "Claude",
    mark: { kind: "letter", text: "Cl", tone: "clay" },
    description: {
      en: "Anthropic's Claude. magpie links it by importing a token; this plugin has not implemented token import yet.",
      "zh-Hans": "Anthropic 的 Claude。magpie 通过导入 token 来关联；本插件尚未实现 token 导入。",
      "zh-Hant": "Anthropic 的 Claude。magpie 透過匯入 token 來關聯；本外掛尚未實作 token 匯入。",
      ja: "Anthropic の Claude。magpie は token のインポートで連携します。このプラグインでは token インポートをまだ実装していません。",
    },
    agentId: "claude",
    // magpie signs in to Claude with `POST /api/signin/claude-token`, which
    // imports a token. It is not a browser OAuth flow, so there is no web auth
    // host and no callback port to claim. The URL in this description was read
    // from the magpie binary; the import itself is not implemented here yet.
    signInMode: "token-import",
    linkOnly: true,
    authHosts: [],
    callbackPort: null,
    notice: {
      en: "magpie signs in to Claude by importing a token (POST /api/signin/claude-token), not through a web account page. This plugin has not implemented that import yet.",
      "zh-Hans": "magpie 通过导入 token（POST /api/signin/claude-token）来登录 Claude，而不是通过网页账号页面。本插件尚未实现该导入。",
      "zh-Hant": "magpie 透過匯入 token（POST /api/signin/claude-token）來登入 Claude，而不是透過網頁帳號頁面。本外掛尚未實作該匯入。",
      ja: "magpie は Web のアカウントページではなく、token のインポート（POST /api/signin/claude-token）で Claude にサインインします。このプラグインではまだ実装していません。",
    },
    capability: {
      state: "pending",
      reason: {
        en: "The Claude token import used by magpie has not been verified in this plugin yet.",
        "zh-Hans": "magpie 中的 Claude 使用 token 导入，本插件尚未验证。",
        "zh-Hant": "magpie 中的 Claude 使用 token 匯入，本外掛尚未驗證。",
        ja: "magpie の Claude は token インポートを使用しており、このプラグインではまだ検証されていません。",
      },
    },
  },
];

export const PROVIDERS = Object.freeze(definitions);

// The API deliberately projects a fixed allowlist. Adding a field here is the
// only way for it to become public, so credentials and future private
// implementation details cannot leak by accident.
export const PROVIDER_PUBLIC_FIELDS = Object.freeze([
  "id",
  "name",
  "mark",
  "description",
  "agentId",
  "signInMode",
  "linkOnly",
  "authHosts",
  "callbackPort",
  "notice",
  "capability",
]);

export function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    mark: { ...provider.mark },
    description: { ...provider.description },
    agentId: provider.agentId,
    signInMode: provider.signInMode,
    linkOnly: Boolean(provider.linkOnly),
    authHosts: [...provider.authHosts],
    callbackPort: provider.callbackPort,
    notice: { ...provider.notice },
    capability: {
      state: provider.capability.state,
      reason: { ...provider.capability.reason },
    },
  };
}

export function listProviders() {
  return PROVIDERS.map(publicProvider);
}
