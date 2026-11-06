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
    copy: "Paste a WorkBuddy credential. It is validated first, then written into magpie and shown in Accounts.",
    label: "Credential",
    hint: "JSON, a flat array, a Cookie or request headers, curl, a query string or an API key all work. Field names are read in camelCase and snake_case; timestamps may be seconds or milliseconds.",
    kind: "Sign-in / API key",
    note: "The credential is held in memory only: one refresh request, never written to disk, never sent anywhere else. A duplicate account is refused.",
    cancel: "Cancel",
    submit: "Validate and import",
    checking: "Validating… the refresh token is really spent once.",
    writing: "Writing into magpie…",
    done: "Imported",
    empty: "The box is empty.",
    failed: "Import failed",
  },
  "zh-Hans": {
    open: "导入凭据",
    title: "导入凭据",
    copy: "粘贴 WorkBuddy 凭据。校验通过后直接写入 magpie，并出现在账号列表里。",
    label: "凭据",
    hint: "支持 JSON、扁平数组、Cookie / 请求头、curl、query 串和 API key。字段大小写与驼峰 / 下划线都认，时间戳秒和毫秒都认。",
    kind: "登录凭据 / API key",
    note: "凭据只在内存里过一遍：只发一个刷新请求，不落盘、不外发。重复账号会被拒绝。",
    cancel: "取消",
    submit: "校验并导入",
    checking: "校验中… 会真的拿 refresh token 换一次 token。",
    writing: "正在写入 magpie…",
    done: "已导入",
    empty: "框是空的。",
    failed: "导入失败",
  },
  "zh-Hant": {
    open: "匯入憑據",
    title: "匯入憑據",
    copy: "貼上 WorkBuddy 憑據。驗證通過後直接寫入 magpie，並出現在帳號列表裡。",
    label: "憑據",
    hint: "支援 JSON、扁平陣列、Cookie / 請求標頭、curl、query 字串與 API key。欄位大小寫與駝峰 / 底線都認，時間戳秒與毫秒都認。",
    kind: "登入憑據 / API key",
    note: "憑據只在記憶體裡過一遍：只發一個刷新請求，不落盤、不外傳。重複帳號會被拒絕。",
    cancel: "取消",
    submit: "驗證並匯入",
    checking: "驗證中… 會真的用 refresh token 換一次 token。",
    writing: "正在寫入 magpie…",
    done: "已匯入",
    empty: "框是空的。",
    failed: "匯入失敗",
  },
  ja: {
    open: "認証情報をインポート",
    title: "認証情報をインポート",
    copy: "WorkBuddy の認証情報を貼り付けます。検証してから magpie に書き込み、アカウント一覧に表示します。",
    label: "認証情報",
    hint: "JSON、配列、Cookie / リクエストヘッダー、curl、クエリ文字列、API key に対応。camelCase と snake_case の両方、秒とミリ秒の両方を読みます。",
    kind: "ログイン / API key",
    note: "認証情報はメモリ上だけで扱います。リフレッシュ要求は 1 回、ディスクにも外部にも残しません。重複アカウントは拒否されます。",
    cancel: "キャンセル",
    submit: "検証してインポート",
    checking: "検証中… refresh token を実際に 1 回使います。",
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

function applyText() {
  document.documentElement.lang = lang;
  for (const [id, value] of [
    ["import-credential", text.open],
    ["import-title", text.title],
    ["import-copy", text.copy],
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
    ? '{"account":{…},"auth":{"accessToken":"…","refreshToken":"…"}}\n或：access_token=…; refresh_token=…\n或：Cookie: access_token=…; refresh_token=…\n或：ck_…（WorkBuddy API key）'
    : '{"account":{…},"auth":{"accessToken":"…","refreshToken":"…"}}\nor: access_token=…; refresh_token=…\nor: Cookie: access_token=…; refresh_token=…\nor: ck_… (WorkBuddy API key)';
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

function openDialog() {
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
    // The call covers parse → duplicate check → one real refresh → write. The
    // status line changes once the service has answered, because there is no
    // mid-flight event to subscribe to.
    const result = await api("/api/import", { provider: "workbuddy", text: value });
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

byId("import-credential")?.addEventListener("click", openDialog);
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
