// What a pasted credential is, and how to put it into magpie's account list.
//
// This writes magpie's own store directly and registers no plugin. A plugin
// would have to take over the `workbuddy` provider to add a sign-in method,
// and magpie lets only one plugin serve a provider — taking over would hide
// the browser / desktop / API-key sign-ins the community plugin already
// offers. Importing an account is not a sign-in method, so it stays out of
// that contest entirely.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where magpie keeps its sign-ins. */
export function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  return join(homedir(), ".config", "magpie");
}

const REFRESH_ENDPOINT = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  let p = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (p.length % 4) p += "=";
  try {
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** A JWT: three dot-separated segments. */
function isJwt(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(v);
}

/**
 * A WorkBuddy API key.
 *
 * Keys made on the keys page most often start with `ck_` / `pt_`, but
 * WorkBuddy's own CLI accepts any key — those two prefixes only decide
 * whether the model list comes from `/v3/config`. So anything that is one
 * bare token (no `=`, `:`, `;`, whitespace or JWT dots) and is long enough
 * to be a key is taken as one.
 */
export function looksLikeApiKey(v) {
  const s = str(v);
  return !!s && s.length >= 12 && !/[.;=:\s]/.test(s) && /^[A-Za-z0-9._~+/-]+$/.test(s) && !isJwt(s);
}

/** A key as a credential record, the way the community plugin's keyAccount has it. */
function keyRecord(key, { uid, domain, nickname } = {}) {
  const k = str(key);
  if (!k) return null;
  return {
    kind: "key",
    key: k,
    // Not a token: the plugin's sign() sends it as X-API-Key, and its
    // keyAccount derives the same uid and no domain.
    access: k,
    refresh: "",
    uid: str(uid) || "anonymous_" + k.slice(-8),
    domain: str(domain),
    tokenType: "Bearer",
    nickname: str(nickname) || "WorkBuddy API key",
    expires: 0,
    refreshExpiresAt: 0,
  };
}

const unquote = (v) => {
  const s = String(v ?? "").trim();
  return /^(['"]).*\1$/.test(s) ? s.slice(1, -1).trim() : s;
};

function decodePart(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * What to call an account in magpie's list.
 *
 * Never empty. magpie shows the blank `accountId` as the literal "Signed in",
 * so a credential whose JWT carries no nickname (a phone-login token) would
 * otherwise appear in the list as a row that names nothing.
 */
export function displayName(rec, claims) {
  // A stated nickname wins, but a bare phone number is not a name: it is
  // masked like one, so the list never shows a whole number.
  const nick = str(rec?.nickname) || str(claims?.nickname);
  if (nick) return maskHandle(nick);

  const pu = str(claims?.preferred_username) || str(rec?.preferred_username);
  if (pu) return maskHandle(pu);

  const uid = str(rec?.uid) || str(claims?.sub);
  return uid ? uid.slice(0, 8) : "WorkBuddy 账号";
}

/** A phone number as an account name: 176****1852. */
function maskHandle(v) {
  if (/^\d{7,15}$/.test(v)) return `${v.slice(0, 3)}****${v.slice(-4)}`;
  return v;
}

/**
 * A time in any of the spellings the exporters use: epoch seconds, epoch
 * milliseconds, or an ISO-8601 string. `recordedAt` in one backup is the last
 * of those, and read as a number it is NaN — silently dropped.
 */
function toMs(v) {
  if (typeof v === "string") {
    const iso = Date.parse(v.trim());
    if (Number.isFinite(iso)) return iso;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // epoch seconds (~1e9), milliseconds (~1e12), microseconds (~1e15): the
  // digit count says which. A value past that is not a date anyone wrote on
  // purpose, so it is dropped rather than turned into a year 58867.
  if (n < 1e12) return Math.round(n * 1000);
  if (n < 1e14) return Math.round(n);
  if (n < 1e17) return Math.round(n / 1000);
  return 0;
}

/**
 * The first candidate that holds a time, as milliseconds.
 *
 * Separate from `pickNum` because a time may be written as a string
 * (`"2026-11-24T06:27:32Z"`), which `Number()` turns into NaN — the field
 * would then look absent and fall through to the JWT's own value.
 */
function pickMs(...vals) {
  for (const v of vals) {
    const ms = toMs(v);
    if (ms > 0) return ms;
  }
  return 0;
}

/**
 * The first of several spellings that holds a value.
 *
 * Credential files come from a handful of tools and each spells the same
 * field its own way: `accessToken` / `access_token`, `expiresAt` /
 * `expires_at` / `expiresIn` / `expiry`, `refreshExpiresAt` /
 * `refresh_expires_at`. Reading only one spelling silently drops the others —
 * which is how an `expires_at` of 1795501652000 ends up replaced by whatever
 * the JWT says, a second either side.
 */
function pick(...vals) {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return "";
}

function pickNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** `expiresIn` is a duration, not a timestamp: seconds from now. */
function fromDuration(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Date.now() + (n < 1e12 ? n * 1000 : n);
}

/** One credential out of one object, or null when it holds no token. */
function fromObject(o) {
  if (!isObj(o)) return null;
  const auth = isObj(o.auth) ? o.auth : isObj(o.credential) ? o.credential : o;
  const account = isObj(o.account) ? o.account : isObj(o.user) ? o.user : {};

  // WorkBuddy 5.6+ writes the token as an object (`{$wbEncrypted: 1, …}`)
  // rather than a string. Nothing here can decrypt it, but saying so beats
  // "没找到 accessToken", which reads as the person's mistake.
  const sealed = [auth.accessToken, o.accessToken, auth.refreshToken, o.refreshToken].some(
    (v) => isObj(v) && ("$wbEncrypted" in v || "envelope" in v)
  );
  if (sealed) {
    const e = new Error("ENCRYPTED");
    e.sealed = true;
    throw e;
  }

  // A credential written as JSON but holding a key: `{key}`, `{apiKey}`,
  // `{ck}` (what some exporters call it), or OpenCode's `{type:"api", key}`.
  const statedKey = pick(
    auth.key,
    auth.apiKey,
    auth.api_key,
    auth["api-key"],
    o.key,
    o.apiKey,
    o.api_key,
    o["api-key"],
    account.key,
    looksLikeApiKey(o.ck) ? o.ck : ""
  );

  // A JSON object whose `ck` / `cookie` / `Cookie` field is a Cookie header
  // rather than a token. Re-read it as the text it is.
  const cookieText = pick(o.ck, o.cookie, o.Cookie, auth.cookie);
  if (!statedKey && cookieText && /[=;]/.test(cookieText)) {
    const fromCookie = parseText(cookieText);
    if (fromCookie.accounts.length) return fromCookie.accounts[0];
  }

  // Every field is read from either the nested auth block or the object
  // itself, in both spellings, so a flat row and a nested file read the same.
  const access = pick(auth.accessToken, auth.access_token, o.accessToken, o.access_token, auth.access, o.access, auth.token, o.token);
  const refresh = pick(auth.refreshToken, auth.refresh_token, o.refreshToken, o.refresh_token, auth.refresh, o.refresh);

  // A key named as `token` / `access` still a key: nothing renews it, and
  // sent as a token it would be refused for want of X-API-Key.
  if (!refresh && looksLikeApiKey(access)) {
    return keyRecord(access, { uid: account.uid ?? o.uid, domain: auth.domain ?? o.domain, nickname: account.nickname ?? o.nickname });
  }
  if (!access && !refresh && statedKey && looksLikeApiKey(statedKey)) {
    return keyRecord(statedKey, { uid: account.uid ?? o.uid, domain: auth.domain ?? o.domain, nickname: account.nickname ?? o.nickname });
  }
  if (!access && !refresh) return null;

  const ac = decodeJwt(access);
  const rc = decodeJwt(refresh);

  const uid = pick(account.uid, auth.uid, o.uid, account.sub, ac?.sub, rc?.sub);

  let domain = pick(auth.domain, o.domain, auth.host, o.host);
  if (!domain) {
    const iss = pick(ac?.iss, rc?.iss);
    try {
      if (iss) domain = new URL(iss).host;
    } catch {}
  }

  // A nickname the file states wins; a bare phone number is not a nickname,
  // so it is left for displayName() to mask like one. The desktop export
  // usually carries no nickname at all and only a `phoneNumber`, which is
  // what the account is then known by.
  const nickname = pick(
    account.nickname,
    auth.nickname,
    o.nickname,
    o.name,
    o.display_name,
    account.phoneNumber,
    account.phone_number,
    o.phoneNumber,
    o.phone_number
  );

  // magpie's own store spells the timestamps `expires` / `refreshExpiresAt`
  // with bare `access` / `refresh`, so it is read too — that is what a backup
  // of the store is, and restoring one has to work.
  //
  // Order matters in the desktop export, which carries `expiresAt` and
  // `expiresIn` at once: `expiresAt` is the absolute time and wins; a bare
  // `expiresIn` is a duration counted from now.
  const expires =
    pickMs(auth.expiresAt, auth.expires_at, o.expiresAt, o.expires_at, o.expiry, o.expiration, o.expires) ||
    fromDuration(pickNum(auth.expiresIn, auth.expires_in, o.expiresIn, o.expires_in)) ||
    toMs(ac?.exp);

  const refreshExpiresAt =
    pickMs(auth.refreshExpiresAt, auth.refresh_expires_at, o.refreshExpiresAt, o.refresh_expires_at, o.refresh_expiry) ||
    fromDuration(pickNum(auth.refreshExpiresIn, auth.refresh_expires_in, o.refreshExpiresIn, o.refresh_expires_in)) ||
    toMs(rc?.exp);

  return {
    access,
    refresh,
    uid,
    domain: domain || "www.codebuddy.cn",
    tokenType: pick(auth.tokenType, auth.token_type, o.tokenType, o.token_type) || "Bearer",
    nickname,
    enterpriseId: pick(account.enterpriseId, account.enterprise_id, auth.enterpriseId, o.enterpriseId, o.enterprise_id, ac?.enterprise_id),
    expires,
    refreshExpiresAt,
  };
}

/**
 * A credential written as text rather than JSON.
 *
 * The exporters, and people copying from DevTools or curl, hand over the
 * same sign-in in other spellings: a `Cookie:` header, a block of headers,
 * a `k=v&k=v` string, or a bare API key (`ck_…`). None of those is JSON, so
 * before this they all ended in "不是合法的 JSON".
 */
export function parseText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { accounts: [], error: "内容是空的" };

  // One bare token, with no field syntax around it.
  if (!/[;=&:\s]/.test(text)) {
    if (looksLikeApiKey(text)) return { accounts: [keyRecord(text)], error: null };
    if (isJwt(text)) {
      const rec = fromObject({ accessToken: text });
      if (rec) return { accounts: [rec], error: null };
    }
    return { accounts: [], error: "这段内容既不是凭据 JSON，也不是 API key（ck_…）。" };
  }

  const fields = new Map();
  const put = (name, value) => {
    const k = unquote(name).trim().toLowerCase();
    const v = decodePart(unquote(value)).trim();
    if (k && v && !fields.has(k)) fields.set(k, v);
  };

  // curl's -H 'Name: value' arguments, then the rest of the text with
  // those arguments taken out (their words aren't fields).
  const chunks = [];
  const curlHead = /(?:^|\s)(?:-H|--header)\s+(['"])([\s\S]*?)\1/g;
  for (let m; (m = curlHead.exec(text)); ) chunks.push(m[2]);
  chunks.push(text.replace(curlHead, " "));

  for (const chunk of chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      // Netscape cookies.txt: domain, flag, path, secure, expiry, name, value.
      const tsv = line.split("\t");
      if (tsv.length >= 7) {
        put(tsv[tsv.length - 2], tsv[tsv.length - 1]);
        continue;
      }

      const cookie = line.replace(/^\s*(?:set-)?cookie\s*:\s*/i, "").replace(/^\s*header\s*:\s*/i, "").trim();
      if (/^bearer\s+\S+$/i.test(cookie)) {
        put("authorization", cookie);
        continue;
      }
      for (const part of cookie.split(/[;&]/)) {
        const p = part.trim();
        if (!p) continue;
        const eq = p.indexOf("=");
        const co = p.indexOf(":");
        // `a=b` before `a: b`: a value can hold a colon, a name cannot.
        if (eq > 0 && (co < 0 || eq < co)) put(p.slice(0, eq), p.slice(eq + 1));
        else if (co > 0) put(p.slice(0, co), p.slice(co + 1));
      }
    }
  }

  const get = (...names) => {
    for (const n of names) {
      const v = fields.get(n);
      if (v) return v;
    }
    return "";
  };

  const bearer = get(
    "access_token",
    "access-token",
    "accesstoken",
    "access",
    "x-access-token",
    "token",
    "authorization"
  ).replace(/^bearer\s+/i, "");
  const refresh = get("refresh_token", "refresh-token", "refreshtoken", "refresh", "x-refresh-token");
  const apiKey = get("x-api-key", "api_key", "api-key", "api key", "apikey", "key");
  const uid = get("uid", "user_id", "userid", "x-user-id", "sub");
  const domain = get("domain", "x-domain");
  const nickname = get("nickname", "name", "phone", "phone_number", "phonenumber");
  const ck = get("ck");

  if (apiKey && !refresh && looksLikeApiKey(apiKey)) {
    return { accounts: [keyRecord(apiKey, { uid, domain, nickname })], error: null };
  }
  if (bearer && !refresh && looksLikeApiKey(bearer)) {
    return { accounts: [keyRecord(bearer, { uid, domain, nickname })], error: null };
  }
  if (!bearer && !refresh && looksLikeApiKey(ck)) {
    return { accounts: [keyRecord(ck, { uid, domain, nickname })], error: null };
  }

  if (bearer || refresh) {
    const rec = fromObject({ accessToken: bearer, refreshToken: refresh, uid, domain, nickname });
    if (rec) return { accounts: [rec], error: null };
  }

  return {
    accounts: [],
    error: /cookie|session|skey|p_skey|uins?=/i.test(text)
      ? "这段 Cookie 里没有 accessToken / refreshToken，也没有 API key。Cookie 本身换不到 token：请在 WorkBuddy 网页登录后从站点数据里复制 accessToken 与 refreshToken，或改用 ck_ 开头的 API key。"
      : "这段文本里没有 accessToken / refreshToken / API key。",
  };
}

/** Any accepted payload (nested, flat array, desktop .info) into credentials. */
export function parsePayload(raw) {
  let data = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return { accounts: [], error: "内容是空的" };
    try {
      data = JSON.parse(t);
    } catch {
      // Not JSON: a Cookie, a header block, a query string, or a bare key.
      return parseText(t);
    }
  }

  // A JSON string is still a string.
  if (typeof data === "string") return parseText(data);

  const out = [];
  let sealed = false;
  const push = (o) => {
    try {
      const r = fromObject(o);
      if (r) out.push(r);
    } catch (e) {
      if (e.sealed) sealed = true;
      else throw e;
    }
  };

  if (Array.isArray(data)) {
    // A browser extension's cookie export: [{name, value, domain}, …].
    if (data.length && data.every((x) => isObj(x) && (x.name || x.key) && x.value !== undefined)) {
      return parseText(data.map((x) => `${x.name ?? x.key}=${x.value}`).join("; "));
    }
    data.forEach(push);
  } else if (isObj(data)) {
    push(data);
    if (Array.isArray(data.accounts)) data.accounts.forEach(push);
    for (const k of ["data", "list", "items"]) if (Array.isArray(data[k])) data[k].forEach(push);

    // One level further down, a whole payload wrapped twice:
    // {"data": {"accounts": [...]}}.
    for (const k of ["data", "result", "payload"]) {
      const inner = data[k];
      if (!isObj(inner)) continue;
      push(inner);
      if (Array.isArray(inner.accounts)) inner.accounts.forEach(push);
      for (const k2 of ["list", "items"]) if (Array.isArray(inner[k2])) inner[k2].forEach(push);
    }

    // magpie's own store: an object whose keys are provider ids and whose
    // values are the credentials. A backup of it is the file to restore, so
    // every entry that holds a token is read — this provider's only:
    // `workbuddy-ai` is a different vendor with its own domain, and taking
    // one of its accounts as a `workbuddy` one would be wrong.
    for (const [key, v] of Object.entries(data)) {
      if (!isObj(v)) continue;
      if (!/^workbuddy(#|$)/.test(key)) continue;
      push(v);
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    // A uid is the account; a rotated refresh token for the same account is
    // still the same account, so the uid alone decides a duplicate. Records
    // without one fall back to what they do carry.
    const k = r.kind === "key" ? `key:${r.key}` : r.uid || `${r.refresh.slice(0, 32)}|${r.access.slice(0, 32)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }

  return {
    accounts: uniq,
    error: uniq.length
      ? null
      : sealed
      ? "这份凭据的 token 是加密的（{$wbEncrypted}），这里解不开。请在 magpie 里用桌面端登录方式，或换一份明文凭据。"
      : "没找到 WorkBuddy 凭据字段（accessToken / refreshToken）或 API key",
  };
}

/** Spend the refresh token once, so a dead credential fails here and now. */
export async function renew(rec, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!rec.refresh) throw new Error("没有 refresh token");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Refresh-Token": rec.refresh,
        "X-Auth-Refresh-Source": "plugin",
        "X-Domain": rec.domain || "www.codebuddy.cn",
      },
      body: "{}",
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}

    if (!res.ok || !body || body.code !== 0) {
      const reason = body?.msg || body?.error_description || body?.error || text.slice(0, 160) || "被拒绝";
      throw new Error(reason);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uids magpie already holds a WorkBuddy sign-in for.
 *
 * magpie appends whatever it is handed; it does not check whether the account
 * is already in the list. Without this, importing a credential for an account
 * that is already there shows it twice — and the second copy holds a refresh
 * token the first one has already spent.
 *
 * Only this provider's entries are read (`workbuddy`, `workbuddy#xxxxxx`):
 * other providers keep their accounts in the same file, and a uid belongs to
 * the realm it came from.
 */
export function knownUids() {
  const out = new Set();
  for (const [id, v] of Object.entries(readStore())) {
    if (!/^workbuddy(#|$)/.test(id)) continue;
    if (v && typeof v === "object" && v.uid) out.add(v.uid);
  }
  return out;
}

/** API keys magpie already holds, so the same key is not added twice. */
export function knownKeys() {
  const out = new Set();
  for (const [id, v] of Object.entries(readStore())) {
    if (!/^workbuddy(#|$)/.test(id)) continue;
    if (v && typeof v === "object" && v.type === "api" && typeof v.key === "string") out.add(v.key);
  }
  return out;
}

/** magpie's sign-in store, as it is on disk. */
export function readStore() {
  const f = join(configDir(), "plugin-auth.json");
  try {
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

/** The clipboard, which is where a pasted credential lands. */
export function readClipboard() {
  const tries =
    process.platform === "win32"
      ? [["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]]]
      : process.platform === "darwin"
      ? [["pbpaste", []]]
      : [
          ["xclip", ["-selection", "clipboard", "-o"]],
          ["xsel", ["--clipboard", "--output"]],
          ["wl-paste", ["--no-newline"]],
        ];

  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, windowsHide: true });
      if (out && out.trim()) return out;
    } catch {}
  }
  return null;
}
