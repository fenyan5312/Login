// 「填入凭据」这一个方式：弹一个自己的窗口，让人把 JSON 粘进去。
//
// 不走 magpie 的 prompts —— 那个字段在 magpie 的 provider 模型里存不下来
// （连官方插件的 prompts 都被丢了），所以声明了也不会出现输入框。
//
// 这里的窗口是插件自己起的：一个本地 HTTP 服务，只在 127.0.0.1 上监听，
// 带一次性 token 防别的网页乱提交。窗口先不表态——它把内容交给校验，
// 凭据真的能刷新出 token 才说成功，失败了就把原因显示在框下面、窗口留着
// 让人改。凭据只在本机内存里过一遍，不落盘、不外发。
//
// 剪贴板只是「窗口被关掉了」时的退路，不是主路径。

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parsePayload, readClipboard, renew, decodeJwt, knownUids, knownKeys, displayName, readStore } from "./workbuddy-credential.mjs";

/** The page the window shows. Nothing here is fetched from anywhere. */
function page(nonce) {
  return `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<title>Login · 填入凭据</title>
<style>
  :root {
    color-scheme: dark;
    --page: #080b0c;
    --panel: #111618;
    --panel-2: #182022;
    --line: rgba(255, 255, 255, .08);
    --line-strong: rgba(255, 255, 255, .14);
    --ink-1: #e8f0f1;
    --ink-2: #a3b1b4;
    --ink-3: #828f93;
    --accent: #5bd6ff;
    --accent-soft: rgba(91, 214, 255, .13);
    --on-accent: #04161c;
    --danger: #ff6257;
    --ok: #3fcb86;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 40px 24px;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
    color: var(--ink-1);
    background:
      radial-gradient(680px 420px at 88% -12%, rgba(91, 214, 255, .12), transparent 62%),
      radial-gradient(520px 360px at 4% 108%, rgba(240, 168, 104, .07), transparent 60%),
      var(--page);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(620px, 100%);
    margin: 0 auto;
    padding: 26px 28px 22px;
    background: linear-gradient(180deg, rgba(24, 32, 34, .92), rgba(17, 22, 24, .88));
    border: 1px solid var(--line);
    border-radius: 18px;
    box-shadow: 0 30px 80px -40px rgba(0, 0, 0, .9), inset 0 1px 0 rgba(255, 255, 255, .04);
    backdrop-filter: blur(22px);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .mark {
    width: 30px; height: 30px; flex: none;
    display: grid; place-items: center;
    border-radius: 9px;
    background: var(--accent-soft);
    border: 1px solid rgba(91, 214, 255, .28);
    color: var(--accent);
    font: 700 15px/1 var(--mono);
  }
  .brand-name { font-size: 13px; font-weight: 650; letter-spacing: .04em; color: var(--ink-2); }
  .brand-name b { color: var(--ink-1); }
  .step {
    margin-left: auto;
    font: 500 11px/1 var(--mono);
    color: var(--ink-3);
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  h1 { font-size: 20px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -.02em; font-weight: 680; }
  .copy { margin: 0 0 16px; color: var(--ink-3); font-size: 12.5px; }
  textarea {
    width: 100%; box-sizing: border-box; height: 236px;
    padding: 13px 15px; resize: vertical;
    font: 12.5px/1.65 var(--mono);
    color: var(--ink-1);
    border-radius: 12px;
    border: 1px solid var(--line-strong);
    background: rgba(8, 11, 12, .72);
    transition: border-color .16s ease, box-shadow .16s ease;
  }
  textarea::placeholder { color: #677174; }
  textarea:focus {
    outline: none;
    border-color: rgba(91, 214, 255, .55);
    box-shadow: 0 0 0 3px rgba(91, 214, 255, .14);
  }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 16px; }
  button {
    padding: 9px 20px; border-radius: 10px; border: 0;
    font: 600 13.5px/1 inherit; cursor: pointer;
    background: var(--accent); color: var(--on-accent);
    transition: transform .12s ease, filter .16s ease, opacity .16s ease;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.ghost {
    background: transparent; color: var(--ink-2);
    border: 1px solid var(--line-strong);
  }
  button:disabled { opacity: .5; cursor: default; transform: none; }
  .hint { margin-left: auto; color: var(--ink-3); font-size: 11.5px; }
  kbd {
    font: 500 11px/1 var(--mono); padding: 3px 6px; border-radius: 5px;
    border: 1px solid var(--line-strong); color: var(--ink-2); background: rgba(255,255,255,.03);
  }
  .msg {
    margin-top: 14px; min-height: 20px; font-size: 12.5px; white-space: pre-wrap;
    color: var(--ink-2);
  }
  .err { color: var(--danger); } .ok { color: var(--ok); }
  .msg.busy { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
  }
</style>
<div class="card">
  <div class="brand">
    <span class="mark" aria-hidden="true">m</span>
    <span class="brand-name"><b>Login</b> · WorkBuddy</span>
    <span class="step">凭据导入</span>
  </div>
  <h1>填入凭据</h1>
  <p class="copy">把凭据 JSON、Cookie、请求头或 WorkBuddy API key（ck_…）粘进下面的框，点「导入」。成功后窗口会自己关掉。</p>
  <textarea id="t" spellcheck="false" autofocus
    placeholder='{"account":{…},"auth":{"accessToken":"…","refreshToken":"…"}}
或：access_token=…; refresh_token=…
或：ck_…（WorkBuddy API key）'></textarea>
  <div class="row">
    <button id="go">导入</button>
    <button id="cancel" class="ghost">取消</button>
    <span class="hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
  </div>
  <div class="msg" id="m" role="status" aria-live="polite"></div>
</div>
<script>
  const NONCE = ${JSON.stringify(nonce)};
  const t = document.getElementById('t');
  const go = document.getElementById('go');
  const m = document.getElementById('m');

  async function send(body) {
    const r = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WPT': NONCE },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  go.onclick = async () => {
    const text = t.value.trim();
    if (!text) { m.className = 'msg err'; m.textContent = '框是空的。'; return; }
    go.disabled = true;
    m.className = 'msg busy'; m.textContent = '校验中…（会真的刷新一次 token，几秒）';
    try {
      const r = await send({ credential: text });
      if (r.ok) { m.className = 'msg ok'; m.textContent = r.message; setTimeout(() => window.close(), 1500); }
      // 失败就把窗口留着，改完再点一次——不用重新开。
      else { go.disabled = false; m.className = 'msg err'; m.textContent = r.error; }
    } catch (e) {
      go.disabled = false; m.className = 'msg err'; m.textContent = String(e);
    }
  };

  document.getElementById('cancel').onclick = async () => {
    await send({ cancel: true }).catch(() => {});
    window.close();
  };

  // Ctrl/Cmd+Enter submits, the way a dialog usually does.
  t.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go.click(); }
  };
</script>
</html>`;
}

/** Open a URL in whatever browser this machine has. */
function open(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

/**
 * Ask for the credential in a window of its own.
 *
 * `check(text)` does the whole import — parse, duplicate check, one real
 * refresh — and returns what magpie wants. It runs *before* the window says
 * anything, so a credential that cannot sign in is reported in the window
 * itself instead of closing as a success and then failing in the terminal.
 * A failed attempt keeps the window open; only `check` succeeding ends it.
 *
 * Resolves with `{ out }` on success, or `{ reason: "cancelled" | "timeout" }`.
 * The server listens on 127.0.0.1 only.
 */
export function askInWindow(check, { onReady, opener = open, timeoutMs = 5 * 60 * 1000 } = {}) {
  const nonce = randomBytes(18).toString("base64url");

  return new Promise((resolve, reject) => {
    let done = false;
    let deadline;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      server.close();
      resolve(v);
    };

    const server = createServer((req, res) => {
      // A browser opened at this URL has no custom header — it navigated
      // here, it did not fetch. The page is what it needs, so GET is served
      // to anyone asking on loopback; the nonce is what protects the POST
      // that hands a credential in, because only this page knows it.
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(page(nonce));
      }

      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      if (req.headers["x-wpt"] !== nonce) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("forbidden");
      }

      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on("end", async () => {
        let data = {};
        try {
          data = JSON.parse(body);
        } catch {}

        const reply = (payload) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload));
        };

        if (data.cancel) {
          reply({ ok: false, error: "已取消" });
          return finish({ reason: "cancelled" });
        }

        const text = typeof data.credential === "string" ? data.credential.trim() : "";
        if (!text) return reply({ ok: false, error: "框是空的。" });

        let out;
        try {
          out = await check(text);
        } catch (e) {
          // Still open, still listening: the person fixes the paste and
          // tries again without a new window.
          return reply({ ok: false, error: e?.message || String(e) });
        }

        reply({ ok: true, message: out.instructions });
        finish({ out });
      });
    });

    server.on("error", reject);

    // Five minutes to paste something; then the window is closed for them.
    deadline = setTimeout(() => finish({ reason: "timeout" }), timeoutMs);

    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/`;
      onReady?.(url);
      const opened = await opener(url);
      if (!opened) {
        clearTimeout(deadline);
        done = true;
        server.close();
        reject(
          new Error(
            `没能自动打开浏览器。请手动打开这个地址，然后把凭据粘进去：\n\n  ${url}\n\n（这个窗口只在本次导入期间存在，最多 5 分钟。）`
          )
        );
      }
    });
  });
}

/**
 * Pasted text into what magpie's authorize() returns.
 *
 * Throws a readable reason instead, so the window can show it verbatim.
 */
async function prepare(text, source) {
  const parsed = parsePayload(text);

  if (parsed.error) {
    throw new Error(`读不出凭据（${source}）：${parsed.error}`);
  }

  // Say what was found before picking, so a file holding several accounts is
  // not silently reduced to its first one.
  if (parsed.accounts.length > 1) {
    const nameOf = (a) => displayName(a, decodeJwt(a.access) || {});
    console.log(
      `这份内容里有 ${parsed.accounts.length} 个账号（${parsed.accounts.map(nameOf).join("、")}），只导入第一个：${nameOf(parsed.accounts[0])}`
    );
  }

  const rec = parsed.accounts[0];

  // An API key is a sign-in on its own. Nothing renews it, and magpie keeps
  // `{key}` as {type:"api", key} (host save(): no refresh, a key) — the shape
  // the community plugin's keyAccount reads and sends as X-API-Key.
  if (rec.kind === "key") {
    if (knownKeys().has(rec.key)) {
      throw new Error(`这个 API key 已经在 magpie 里了（…${rec.key.slice(-4)}），不用再导入。`);
    }
    const tail = rec.key.slice(-4);
    return {
      url: "about:blank",
      // A key isn't validated here: WorkBuddy's own /v3/config answers 200 to
      // any key, so the only honest check is the first real request.
      instructions: `已导入 WorkBuddy API key（…${tail}，不会过期；无效的 key 会在第一次请求时被拒绝）`,
      method: "auto",
      async callback() {
        return { type: "success", key: rec.key, accountId: `WorkBuddy API key …${tail}` };
      },
    };
  }

  if (!rec.refresh) {
    throw new Error("这份凭据里没有 refresh token，登录会立刻过期。请换一份完整的凭据，或直接粘贴 WorkBuddy 的 API key（ck_ 开头）。");
  }

  const uid = rec.uid || decodeJwt(rec.access)?.sub || "";

  // Refuse a second copy of an account that is already here. magpie appends
  // whatever a method returns without checking, so pasting the same file twice
  // would list the account twice — and the newer copy's refresh token would
  // already have been spent by the older one.
  if (uid && knownUids().has(uid)) {
    const kept = Object.values(readStore()).find((v) => v && v.uid === uid);
    const newer =
      kept?.expires && rec.expires && kept.expires > rec.expires
        ? `\n\n顺带一提：magpie 里那份比这次填的还新（${new Date(kept.expires).toISOString().slice(0, 16)} vs ${new Date(rec.expires).toISOString().slice(0, 16)}），覆盖反而是降级，所以没动它。`
        : "";
    throw new Error(`这个账号已经在 magpie 里了（${uid.slice(0, 8)}…），不用再导入。${newer}`);
  }

  // Prove it works before reporting success, and take the fresh tokens.
  const live = await renew(rec);
  const access = live.accessToken || rec.access;
  const claims = decodeJwt(access) || {};

  const finalUid = uid || claims.sub || "";
  // Never blank: magpie renders an empty accountId as the words "Signed in".
  const who = displayName({ ...rec, uid: finalUid }, claims);

  return {
    url: "about:blank",
    instructions: `已登录 ${who}`,
    method: "auto",
    async callback() {
      return {
        type: "success",
        access,
        refresh: live.refreshToken || rec.refresh,
        expires: Date.now() + (Number(live.expiresIn) > 0 ? Number(live.expiresIn) * 1000 : 3600 * 1000),
        refreshExpiresAt: Date.now() + (Number(live.refreshExpiresIn) > 0 ? Number(live.refreshExpiresIn) * 1000 : 0),
        tokenType: live.tokenType || rec.tokenType || "Bearer",
        accountId: who,
        uid: finalUid,
        domain: live.domain || rec.domain,
        ...(rec.enterpriseId ? { enterpriseId: rec.enterpriseId } : {}),
      };
    },
  };
}

/**
 * magpie's sign-in contract: authorize() hands back what to show plus a
 * callback() that finishes. Everything is done in authorize() because magpie
 * only reports a method as failed when authorize() rejects — a failing
 * callback would still print a tick.
 */
export async function authorize(inputs, { opener, onReady } = {}) {
  // If magpie ever does pass a prompt answer through, use it and skip the
  // window entirely.
  const typed = typeof inputs?.credential === "string" ? inputs.credential.trim() : "";
  if (typed) return prepare(typed, "输入框");

  // A path, for scripts: WPT_FILE=cred.json magpie plugin login workbuddy
  const p = process.env.WPT_FILE;
  if (p && existsSync(p)) return prepare(readFileSync(p, "utf8"), p);

  // The window is the normal path: type or paste, no clipboard needed.
  const asked = await askInWindow((text) => prepare(text, "输入框"), { opener, onReady });
  if (asked.out) return asked.out;

  if (asked.reason === "timeout") throw new Error("等太久了（5 分钟），窗口已关闭。再点一次重新开一个。");

  // Cancelled the window; fall back to the clipboard if there is something.
  const clip = readClipboard();
  if (clip && clip.trim()) return prepare(clip, "剪贴板");

  throw new Error("没有导入：窗口关掉了，也没有别的内容可读。");
}
