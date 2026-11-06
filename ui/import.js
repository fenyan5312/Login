// The page's credential-import dialog. It lives in its own module so the
// 210 KB view module stays untouched: this only talks to POST /api/import,
// shows the service's verdict, and asks the accounts view to reload.
//
// The credential never leaves this document except as the request body; it is
// cleared when the dialog closes.

const token = document.querySelector('meta[name="clean-login-token"]')?.content || "";

const messages = {
  en: {
    open: "Import credential",
    title: "Import a credential",
    copy: "Paste a credential for {name}. Login reads it locally, writes it into magpie, and the Accounts tab shows it.",
    label: "Credential",
    hint: "An API key, an access token, JSON, a Cookie or request headers, or key=value pairs all work. The kind is detected automatically; field names are read in camelCase and snake_case.",
    kind: "Sign-in / API key",
    note: "Login reads the paste for this request only and writes the fields magpie accepts into magpie's own account store. It never logs or forwards them. WorkBuddy is checked against WorkBuddy once; other providers are not contacted. A duplicate is refused.",
    cancel: "Cancel",
    submit: "Validate and import",
    checking: "Reading the credential…",
    writing: "Writing into magpie…",
    done: "Imported",
    empty: "The box is empty.",
    failed: "Import failed",
  },
  "zh-Hans": {
    open: "导入凭据",
    title: "导入凭据",
    copy: "粘贴 {name} 的凭据。Login 在本地解析后写入 magpie，账号列表里就能看到。",
    label: "凭据",
    hint: "支持 API key、access token、JSON、Cookie / 请求头、key=value。类型会自动识别，字段大小写与驼峰 / 下划线都认。",
    kind: "登录凭据 / API key",
    note: "凭据只用于这一次请求：Login 解析出 magpie 认的字段后写入 magpie 自己的账号库，不记日志、不外发。只有 WorkBuddy 会向 WorkBuddy 校验一次，其他供应商不联网。重复账号会被拒绝。",
    cancel: "取消",
    submit: "校验并导入",
    checking: "正在读取凭据…",
    writing: "正在写入 magpie…",
    done: "已导入",
    empty: "框是空的。",
    failed: "导入失败",
  },
  "zh-Hant": {
    open: "匯入憑據",
    title: "匯入憑據",
    copy: "貼上 {name} 的憑據。Login 在本機解析後寫入 magpie，帳號列表裡就能看到。",
    label: "憑據",
    hint: "支援 API key、access token、JSON、Cookie / 請求標頭、key=value。類型會自動辨識，欄位大小寫與駝峰 / 底線都認。",
    kind: "登入憑據 / API key",
    note: "憑據只用於這一次請求：Login 解析出 magpie 認得的欄位後寫入 magpie 自己的帳號庫，不記日誌、不外傳。只有 WorkBuddy 會向 WorkBuddy 驗證一次，其他供應商不連網。重複帳號會被拒絕。",
    cancel: "取消",
    submit: "驗證並匯入",
    checking: "正在讀取憑據…",
    writing: "正在寫入 magpie…",
    done: "已匯入",
    empty: "框是空的。",
    failed: "匯入失敗",
  },
  ja: {
    open: "認証情報をインポート",
    title: "認証情報をインポート",
    copy: "{name} の認証情報を貼り付けます。Login がローカルで読み取り、magpie に書き込むとアカウント一覧に表示されます。",
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
let busy = false;
let closeTimer = 0;
let activeProvider = "workbuddy";
let activeName = "WorkBuddy";

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

function clearError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
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
    const result = await api("/api/import", { provider: activeProvider, text: value });
    showStatus(text.writing);
    hideStatus();
    successNode.hidden = false;
    const who = result.accountId || result.key || "";
    successNode.textContent = `${text.done} · ${who}${result.notice ? ` ${result.notice}` : ""}`;
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
    showError(error?.message || text.failed);
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
