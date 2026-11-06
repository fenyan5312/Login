// The page's credential-import dialog. It lives in its own module so the
// 210 KB view module stays untouched: this only talks to POST /api/import,
// shows the service's verdict, and asks the accounts view to reload.
//
// The credential never leaves this document except as the request body; it is
// cleared when the dialog closes.

import { formatAddress } from "./proxy-state.js";

const token = document.querySelector('meta[name="clean-login-token"]')?.content || "";

const messages = {
  en: {
    open: "Import credential",
    title: "Import a credential",
    copy: "Paste a credential for {name}. 私密登录 reads it locally, writes it into magpie, and the Accounts tab shows it.",
    label: "Credential",
    hint: "An API key, an access token, JSON, a Cookie or request headers, or key=value pairs all work. The kind is detected automatically; field names are read in camelCase and snake_case.",
    kind: "Sign-in / API key",
    note: "私密登录 reads the paste for this request only and writes the fields magpie accepts into magpie's own account store. It never logs or forwards them. WorkBuddy is checked against WorkBuddy once; other providers are not contacted. A duplicate is refused.",
    cancel: "Cancel",
    submit: "Validate and import",
    checking: "Reading the credential…",
    writing: "Writing into magpie…",
    done: "Imported",
    empty: "The box is empty.",
    failed: "Import failed",
    groupLabel: "IP group",
    groupCap: "{n}/IP",
    groupHint: "Pick a group so the imported account exits through its IP pool. Child groups count too.",
    groupAuto: "Automatic (no group)",
    proxyLabel: "Proxy IP",
    proxyHint: "Leave it on automatic to let the group allocate its least-loaded IP.",
    proxyAuto: "Auto: least-loaded IP in this group",
    proxyDirect: "Auto: no fixed exit",
    exitLabel: "Exit",
    groupUsedLabel: "Group",
    fingerprintCreated: "Fingerprint pinned.",
    fingerprintPending: "Fingerprint will be pinned on first browser use.",
    groupFull: "Every IP in this group is at its cap. Add an IP or raise the limit.",
    groupProxyMismatch: "That IP is not in the chosen group.",
    groupNotFound: "The group or IP no longer exists.",
  },
  "zh-Hans": {
    open: "导入凭据",
    title: "导入凭据",
    copy: "粘贴 {name} 的凭据。私密登录 在本地解析后写入 magpie，账号列表里就能看到。",
    label: "凭据",
    hint: "支持 API key、access token、JSON、Cookie / 请求头、key=value。类型会自动识别，字段大小写与驼峰 / 下划线都认。",
    kind: "登录凭据 / API key",
    note: "凭据只用于这一次请求：私密登录 解析出 magpie 认的字段后写入 magpie 自己的账号库，不记日志、不外发。只有 WorkBuddy 会向 WorkBuddy 校验一次，其他供应商不联网。重复账号会被拒绝。",
    cancel: "取消",
    submit: "校验并导入",
    checking: "正在读取凭据…",
    writing: "正在写入 magpie…",
    done: "已导入",
    empty: "框是空的。",
    failed: "导入失败",
    groupLabel: "IP 组",
    groupCap: "{n} 个/IP",
    groupHint: "选择分组后，导入的账号会从这个组的 IP 池出网；子分组也计入。",
    groupAuto: "自动（不指定分组）",
    proxyLabel: "代理 IP",
    proxyHint: "保持自动，就会分配组内负载最低的 IP。",
    proxyAuto: "自动：组内负载最低的 IP",
    proxyDirect: "自动：不固定出口",
    exitLabel: "出口",
    groupUsedLabel: "分组",
    fingerprintCreated: "指纹已固定。",
    fingerprintPending: "指纹会在首次打开浏览器时固定。",
    groupFull: "这个分组的 IP 已到上限，请先加 IP 或调整每个 IP 的账号数。",
    groupProxyMismatch: "这个 IP 不在所选分组里。",
    groupNotFound: "分组或 IP 已经不存在了。",
  },
  "zh-Hant": {
    open: "匯入憑據",
    title: "匯入憑據",
    copy: "貼上 {name} 的憑據。私密登录 在本機解析後寫入 magpie，帳號列表裡就能看到。",
    label: "憑據",
    hint: "支援 API key、access token、JSON、Cookie / 請求標頭、key=value。類型會自動辨識，欄位大小寫與駝峰 / 底線都認。",
    kind: "登入憑據 / API key",
    note: "憑據只用於這一次請求：私密登录 解析出 magpie 認得的欄位後寫入 magpie 自己的帳號庫，不記日誌、不外傳。只有 WorkBuddy 會向 WorkBuddy 驗證一次，其他供應商不連網。重複帳號會被拒絕。",
    cancel: "取消",
    submit: "驗證並匯入",
    checking: "正在讀取憑據…",
    writing: "正在寫入 magpie…",
    done: "已匯入",
    empty: "框是空的。",
    failed: "匯入失敗",
    groupLabel: "IP 組",
    groupCap: "{n} 個/IP",
    groupHint: "選擇分組後，匯入的帳號會從這個組的 IP 池出網；子分組也計入。",
    groupAuto: "自動（不指定分組）",
    proxyLabel: "代理 IP",
    proxyHint: "保持自動，就會分配組內負載最低的 IP。",
    proxyAuto: "自動：組內負載最低的 IP",
    proxyDirect: "自動：不固定出口",
    exitLabel: "出口",
    groupUsedLabel: "分組",
    fingerprintCreated: "指紋已固定。",
    fingerprintPending: "指紋會在首次開啟瀏覽器時固定。",
    groupFull: "此分組的 IP 已達上限，請先新增 IP 或調整每個 IP 的帳號數。",
    groupProxyMismatch: "此 IP 不在所選分組裡。",
    groupNotFound: "分組或 IP 已不存在。",
  },
  ja: {
    open: "認証情報をインポート",
    title: "認証情報をインポート",
    copy: "{name} の認証情報を貼り付けます。私密登录 がローカルで読み取り、magpie に書き込むとアカウント一覧に表示されます。",
    label: "認証情報",
    hint: "API key、access token、JSON、Cookie / リクエストヘッダー、key=value に対応。種類は自動判別し、camelCase と snake_case の両方を読みます。",
    kind: "ログイン / API key",
    note: "認証情報はこのリクエストの間だけ読み取り、magpie が受け付ける項目だけを magpie 自身のアカウント保存先へ書き込みます。ログにも外部にも出しません。WorkBuddy だけは WorkBuddy へ一度確認し、それ以外のプロバイダーには通信しません。重複アカウントは拒否されます。",
    cancel: "キャンセル",
    submit: "検証してインポート",
    checking: "認証情報を読み取り中…",
    writing: "magpie に書き込み中…",
    done: "インポートしました",
    empty: "入力欄が空です。",
    failed: "インポートに失敗しました",
    groupLabel: "IP グループ",
    groupCap: "{n} 件/IP",
    groupHint: "グループを選ぶと、インポートしたアカウントはその IP プールから出ます。子グループも対象です。",
    groupAuto: "自動（グループなし）",
    proxyLabel: "プロキシ IP",
    proxyHint: "自動のままにすると、グループ内で最も空いている IP が割り当てられます。",
    proxyAuto: "自動：グループ内で最も空いている IP",
    proxyDirect: "自動：固定の出口なし",
    exitLabel: "出口",
    groupUsedLabel: "グループ",
    fingerprintCreated: "指紋を固定しました。",
    fingerprintPending: "指紋は初回のブラウザー利用時に固定されます。",
    groupFull: "このグループの IP はすべて上限です。IP を追加するか上限を上げてください。",
    groupProxyMismatch: "その IP は選択したグループにありません。",
    groupNotFound: "グループまたは IP はもう存在しません。",
  },
};

function languageOf(lang) {
  const parts = String(lang || "zh-Hans").toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] === "zh") {
    return parts.includes("hant") ||
      (!parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part)))
      ? "zh-Hant"
      : "zh-Hans";
  }
  return messages[parts[0]] ? parts[0] : "ja" === parts[0] ? "ja" : "en";
}

const lang = languageOf(document.documentElement.lang || new URLSearchParams(location.search).get("lang"));
const text = messages[lang] || messages["zh-Hans"];

const byId = (id) => document.getElementById(id);
const dialog = byId("import-dialog");
const textarea = byId("import-text");
const submit = byId("import-submit");
const status = byId("import-status");
const statusText = byId("import-status-text");
const errorNode = byId("import-error");
const successNode = byId("import-success");
const groupSelect = byId("import-group");
const proxySelect = byId("import-proxy");
let busy = false;
let closeTimer = 0;
let activeProvider = "workbuddy";
let activeName = "WorkBuddy";
// The pickers read /api/bootstrap once per dialog open: the tag/group tree and
// the public proxy list are the service's, never a local guess.
let bootstrap = { groups: [], proxies: [] };
let bootstrapLoading = null;

function applyText() {
  document.documentElement.lang = lang;
  for (const [id, value] of [
    ["import-credential", text.open],
    ["import-title", text.title],
    ["import-copy", text.copy.replaceAll("{name}", activeName)],
    ["import-provider-mark", activeName.slice(0, 2)],
    ["import-provider-name", activeName],
    ["import-provider-sub", activeProvider === "workbuddy" ? "CodeBuddy · copilot.tencent.com" : activeProvider],
    ["import-text-label", text.label],
    ["import-text-hint", text.hint],
    ["import-group-label", text.groupLabel],
    ["import-group-hint", text.groupHint],
    ["import-proxy-label", text.proxyLabel],
    ["import-proxy-hint", text.proxyHint],
    ["import-kind", text.kind],
    ["import-note", text.note],
    ["import-cancel", text.cancel],
    ["import-submit", text.submit],
  ]) {
    const node = byId(id);
    if (node) node.textContent = value;
  }
  textarea.placeholder = messages[lang] === messages["zh-Hans"]
    ? `{"access_token":"…","refresh_token":"…"}\n或：access_token=…; refresh_token=…\n或：Cookie: access_token=…\n或：直接粘贴一整串 API key`
    : `{"access_token":"…","refresh_token":"…"}\nor: access_token=…; refresh_token=…\nor: Cookie: access_token=…\nor: a bare API key`;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clean-login-token": token,
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    error.code = payload?.error || "";
    throw error;
  }
  return payload;
}

function setBusy(value) {
  busy = value;
  submit.disabled = value;
  textarea.disabled = value;
  if (groupSelect) groupSelect.disabled = value;
  if (proxySelect) proxySelect.disabled = value;
  submit.textContent = value ? text.checking : text.submit;
}

function showStatus(message) {
  status.hidden = false;
  statusText.textContent = message;
}

function hideStatus() {
  status.hidden = true;
}

function showError(message) {
  hideStatus();
  errorNode.hidden = false;
  errorNode.textContent = message;
}

function importErrorText(error) {
  const byCode = {
    group_full: text.groupFull,
    group_proxy_mismatch: text.groupProxyMismatch,
    not_found: text.groupNotFound,
  };
  return byCode[error?.code] || error?.message || text.failed;
}

function clearError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
}

function groupIndent(group) {
  // Depth is 1-based in the group view: the first level carries no indent.
  const depth = Number.isFinite(group?.depth) ? Math.max(1, group.depth) : 1;
  return "— ".repeat(depth - 1);
}

function memberIds(group) {
  const members = Array.isArray(group?.members) ? group.members : [];
  return new Set(
    members
      .map((member) => (typeof member === "string" ? member : member?.id))
      .filter(Boolean),
  );
}

// Only groups that accept this provider are offered. An all-provider group
// (empty provider) always qualifies; a tree node keeps its indentation so a
// child is never mistaken for a sibling.
function fillImportGroups() {
  if (!groupSelect) return;
  const previous = groupSelect.value;
  groupSelect.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = text.groupAuto;
  groupSelect.append(auto);
  for (const group of bootstrap.groups) {
    if (group.provider && group.provider !== activeProvider) continue;
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${groupIndent(group)}${group.name} · ${text.groupCap.replace("{n}", String(group.perIp))}`;
    groupSelect.append(option);
  }
  // A choice made while the read was in flight survives the refresh.
  groupSelect.value = [...groupSelect.options].some((option) => option.value === previous)
    ? previous
    : "";
}

function selectedImportGroup() {
  const id = groupSelect?.value || "";
  return bootstrap.groups.find((group) => group.id === id) || null;
}

// A selected group narrows the proxy picker to its subtree members. With no
// group the whole proxy list stays available, and the empty value always means
// "let the service allocate".
function fillImportProxies() {
  if (!proxySelect) return;
  const previous = proxySelect.value;
  const group = selectedImportGroup();
  proxySelect.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = group ? text.proxyAuto : text.proxyDirect;
  proxySelect.append(auto);
  const allowed = group ? memberIds(group) : null;
  for (const proxy of bootstrap.proxies) {
    if (allowed && !allowed.has(proxy.id)) continue;
    const option = document.createElement("option");
    option.value = proxy.id;
    const address = formatAddress(proxy);
    option.textContent = `${proxy.name || proxy.id} · ${address}`;
    proxySelect.append(option);
  }
  proxySelect.value = [...proxySelect.options].some((option) => option.value === previous)
    ? previous
    : "";
}

async function loadImportBootstrap() {
  try {
    const response = await fetch("api/bootstrap", {
      headers: { "x-clean-login-token": token },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    bootstrap = {
      groups: Array.isArray(data?.groups) ? data.groups : [],
      proxies: Array.isArray(data?.proxies) ? data.proxies : [],
    };
  } catch {
    // The pickers stay on automatic; an import without a group still works.
  }
}

async function prepareImportPickers() {
  const provider = activeProvider;
  fillImportGroups();
  fillImportProxies();
  bootstrapLoading = loadImportBootstrap();
  await bootstrapLoading;
  // The dialog may have closed or switched providers while the read was in
  // flight; never repaint one provider's groups into another's dialog.
  if (busy || provider !== activeProvider || !dialog?.open) return;
  fillImportGroups();
  fillImportProxies();
}

// The public shape POST /api/import accepts: no password, no stored record.
function selectedImportProxy() {
  const id = proxySelect?.value || "";
  if (!id) return null;
  const proxy = bootstrap.proxies.find((item) => item.id === id);
  if (!proxy) return null;
  return {
    id: proxy.id,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || "",
  };
}

function openDialog(detail = {}) {
  const provider = typeof detail?.provider === "string" && detail.provider ? detail.provider : "workbuddy";
  activeProvider = provider;
  activeName = typeof detail?.name === "string" && detail.name ? detail.name : provider;
  applyText();
  clearError();
  successNode.hidden = true;
  successNode.textContent = "";
  hideStatus();
  setBusy(false);
  textarea.value = "";
  groupSelect.value = "";
  proxySelect.value = "";
  void prepareImportPickers();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  setTimeout(() => textarea.focus(), 30);
}

function closeDialog() {
  if (busy) return;
  window.clearTimeout(closeTimer);
  // Do not leave a credential sitting in the DOM.
  textarea.value = "";
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function run() {
  const value = textarea.value.trim();
  if (!value) {
    showError(text.empty);
    return;
  }
  clearError();
  successNode.hidden = true;
  setBusy(true);
  showStatus(text.checking);

  try {
    // The call covers parse → duplicate check → (WorkBuddy: one real refresh) →
    // write. Other providers are parsed and whitelisted locally; no endpoint is
    // called in their name. The status line changes once the service answers.
    const payload = { provider: activeProvider, text: value };
    const group = selectedImportGroup();
    if (group) payload.groupId = group.id;
    const proxy = selectedImportProxy();
    if (proxy) payload.proxy = proxy;
    const result = await api("/api/import", payload);
    showStatus(text.writing);
    hideStatus();
    successNode.hidden = false;
    const parts = [text.done];
    const who = result.accountId || result.key || "";
    if (who) parts.push(who);
    if (result.proxy?.name) {
      const region = result.proxy.region ? ` · ${result.proxy.region}` : "";
      parts.push(`${text.exitLabel} ${result.proxy.name}${region}`);
    }
    if (result.proxyGroupName) parts.push(`${text.groupUsedLabel} ${result.proxyGroupName}`);
    // Say what happened to the fingerprint instead of leaving the user to
    // discover it on the first browser use.
    if (result.fingerprintCreated) parts.push(text.fingerprintCreated);
    else if (result.fingerprintPending) parts.push(text.fingerprintPending);
    if (result.notice) parts.push(result.notice);
    successNode.textContent = parts.join(" · ");
    setBusy(false);
    submit.disabled = true;
    submit.textContent = text.done;
    // The accounts view owns the list; ask it to reload.
    byId("accounts-refresh")?.click();
    closeTimer = window.setTimeout(() => {
      busy = false;
      closeDialog();
    }, 1800);
  } catch (error) {
    setBusy(false);
    showError(importErrorText(error));
  }
}

byId("import-credential")?.addEventListener("click", () => openDialog());
// A provider card without a runnable plugin method asks for the same dialog,
// scoped to its own provider id. It carries only the id and the display name.
window.addEventListener("login:import-credential", (event) => {
  const detail = event?.detail;
  openDialog({ provider: detail?.provider, name: detail?.name });
});
byId("import-close")?.addEventListener("click", closeDialog);
byId("import-cancel")?.addEventListener("click", closeDialog);
groupSelect?.addEventListener("change", fillImportProxies);
submit?.addEventListener("click", run);
textarea?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!busy) run();
  }
});
dialog?.addEventListener("close", () => {
  window.clearTimeout(closeTimer);
  textarea.value = "";
  if (groupSelect) groupSelect.value = "";
  if (proxySelect) proxySelect.value = "";
  busy = false;
});

// Mirror the service state into the header chip. The footer owns the real
// state; this only repeats it where the eye lands first.
function mirrorServiceState() {
  const footer = byId("service-state");
  const chip = byId("header-status");
  const label = byId("service-label");
  const out = byId("header-status-label");
  if (!footer || !chip || !label || !out) return;
  const state = footer.dataset.state || "connecting";
  chip.dataset.state = state;
  out.textContent = label.textContent;
}
const footer = byId("service-state");
if (footer) {
  new MutationObserver(mirrorServiceState).observe(footer, {
    attributes: true,
    attributeFilter: ["data-state"],
    childList: true,
    subtree: true,
  });
  mirrorServiceState();
}

applyText();
