// Launcher frame. A magpie page runs sandboxed with connect-src 'none', so
// this frame cannot fetch, probe or read the service: its only network move
// is to navigate itself to the loopback service. Everything below reads from
// the bridge and then does exactly one location.replace.
//
// The port comes from the plugin option (default 3492); index.mjs starts the
// service on the same value.
//
// Where to go: 127.0.0.1 is the computer that opened the page. Under
// `magpie web` (opened from another computer) the bridge offers
// `magpie.service`, magpie's forward on its own address. Follow it when
// present; otherwise fall back to 127.0.0.1 for the desktop window.
(() => {
  const messages = {
    en: {
      title: "Login",
      connecting: "Connecting to the local service…",
      failed: "The local service did not answer.",
      retry: "Try again",
      remote: "This page's service runs only on the computer that runs magpie.",
    },
    "zh-Hans": {
      title: "Login",
      connecting: "正在连接本地服务…",
      failed: "本地服务没有响应。",
      retry: "重试",
      remote: "此页面的服务只在运行 magpie 的电脑上可用。",
    },
    "zh-Hant": {
      title: "Login",
      connecting: "正在連線至本機服務…",
      failed: "本機服務沒有回應。",
      retry: "重試",
      remote: "此頁面的服務只在執行 magpie 的電腦上可用。",
    },
    ja: {
      title: "Login",
      connecting: "ローカルサービスに接続しています…",
      failed: "ローカルサービスから応答がありません。",
      retry: "再試行",
      remote: "このページのサービスは magpie を実行しているコンピューターでのみ利用できます。",
    },
  };

  let text = messages.en;

  function languageOf(lang) {
    const parts = String(lang || "en").toLowerCase().replaceAll("_", "-").split("-");
    if (parts[0] === "zh") {
      return parts.includes("hant") ||
        (!parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part)))
        ? "zh-Hant"
        : "zh-Hans";
    }
    return parts[0];
  }

  function setLanguage(lang) {
    const key = languageOf(lang);
    text = messages[key] || messages.en;
    if (document.documentElement) document.documentElement.lang = messages[key] ? key : "en";
    document.title = text.title;
    const title = document.getElementById("title");
    if (title) title.textContent = text.title;
    const status = document.getElementById("status");
    if (status) status.textContent = text.connecting;
  }

  function isLocalHost(host) {
    const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    return !value || value === "localhost" || value.endsWith(".localhost") ||
      value === "::1" || /^127\./.test(value);
  }

  function showFailure(message) {
    const status = document.getElementById("status");
    if (status) status.textContent = message;
    if (!status || document.getElementById("retry")) return;
    const button = document.createElement("button");
    button.id = "retry";
    button.type = "button";
    button.textContent = text.retry;
    button.addEventListener("click", () => location.reload());
    status.after(button);
  }

  // Read magpie's provider list into a small envelope for the UI. The sandbox
  // cannot fetch, so the only way to carry this data to the loopback service
  // is the navigation URL. A missing bridge, a thrown read, a timeout or an
  // empty answer must never delay or block navigation: every failure returns
  // ok:false and the UI falls back to this plugin's local registry.
  //
  // UNVERIFIED: the real payload shape of `providers:list` has not been
  // confirmed on this machine. The value is forwarded as-is and normalized by
  // the service (lib/provider-sources.mjs).
  function readProviders() {
    const read = window.magpie?.read;
    if (typeof read !== "function") return Promise.resolve({ v: 1, ok: false });
    let timer;
    return Promise.race([
      Promise.resolve().then(() => read("providers:list")),
      new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("providers:list timed out")), 1500);
      }),
    ])
      .then((value) => ({ v: 1, ok: true, value: value ?? null }))
      .catch(() => ({ v: 1, ok: false }))
      .finally(() => window.clearTimeout?.(timer));
  }

  return (async () => {
    let port = 3492;
    let theme = "";
    let lang = "";

    try {
      const themeInfo = await window.magpie?.ready;
      if (themeInfo && typeof themeInfo === "object") {
        if (typeof themeInfo.dark === "boolean") theme = themeInfo.dark ? "dark" : "light";
        if (typeof themeInfo.lang === "string" && themeInfo.lang) lang = themeInfo.lang;
      }
    } catch { /* no bridge: keep defaults */ }

    try {
      const options = await window.magpie?.options?.get?.();
      const value = Number(options?.port);
      if (Number.isInteger(value) && value > 0 && value <= 65535) port = value;
    } catch { /* no options: keep the default port */ }

    // Fall back to the launcher frame's own ?lang= when the bridge has none.
    if (!lang) {
      try { lang = new URLSearchParams(location.search).get("lang") || ""; } catch { /* ignore */ }
    }
    setLanguage(lang);

    let service = "";
    try {
      const offered = window.magpie?.service;
      if (typeof offered === "string" && /^https?:\/\//.test(offered)) service = offered;
    } catch { /* a magpie from before magpie.service */ }

    // Without magpie.service a remote viewer cannot reach this computer's
    // loopback service. Say so instead of navigating into a refused port.
    if (!service && !isLocalHost(location.hostname)) {
      showFailure(text.remote);
      return;
    }

    const target = new URL(service || `http://127.0.0.1:${port}/`, location.href);
    if (theme) target.searchParams.set("theme", theme);
    if (lang) target.searchParams.set("lang", lang);

    // Carry the magpie-derived provider list in the hash fragment, not the
    // query, so it never reaches the service's request log. The UI reads it
    // and hands it to /api/provider-sources for normalization and merging.
    const providerRead = await readProviders();
    target.hash = `providers=${encodeURIComponent(JSON.stringify(providerRead))}`;

    // WebKit does not report an unreachable target: location.replace simply
    // does nothing and this document stays alive. If we are still here after
    // 8s, the navigation did not happen, so show a real message and a way back.
    // The service now binds in the background, so the page can legitimately be
    // ready before the port is. While the previous host still owns 3492 the
    // navigation simply reaches that host; in the short gap where nothing
    // listens yet, WebKit leaves this document alive. Retry the navigation
    // instead of declaring the service dead after one attempt.
    let attempts = 0;
    const MAX_ATTEMPTS = 120;
    const RETRY_MS = 1500;
    let interval = null;
    const stop = () => {
      if (interval !== null) window.clearInterval?.(interval);
      interval = null;
    };
    const navigate = () => {
      attempts += 1;
      // A changing query keeps each attempt a real navigation rather than a
      // repeat of the one that just failed; the service only reads the path.
      const url = new URL(target.href);
      if (attempts > 1) url.searchParams.set("retry", String(attempts));
      location.replace(url.href);
      if (attempts >= MAX_ATTEMPTS) {
        stop();
        showFailure(text.failed);
      }
    };
    navigate();
    interval = window.setInterval(navigate, RETRY_MS);
    window.addEventListener?.("pagehide", stop, { once: true });
  })().catch((error) => {
    showFailure(`${text.failed} ${String(error?.message || error)}`);
  });
})();
