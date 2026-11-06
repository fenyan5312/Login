// Importing a pasted credential for a provider OTHER than WorkBuddy.
//
// WorkBuddy has its own prover (lib/import-credential.mjs): a refresh token is
// really spent once against WorkBuddy's endpoint. Every other provider in the
// list has no such endpoint we are allowed to call, so this module does the
// honest thing instead of pretending:
//
//   * it parses what the user pasted (a bare key, JSON, Cookie/headers,
//     key=value pairs, a Bearer line),
//   * it accepts only a small, typed set of fields — no arbitrary object is
//     ever forwarded to magpie's account store,
//   * it refuses a secret that is already in `plugin-auth.json`,
//   * it never logs, stores or transmits the credential, and never invents a
//     network check that did not happen.
//
// The caller (lib/server.mjs) writes the returned body through the injected
// `client.auth.set`, exactly like a sign-in does.
import { ImportError } from "./import-credential.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { magpieConfigDir } from "./paths.mjs";

const MAX_INPUT = 64 * 1024;
const MIN_SECRET = 8;
const MAX_SECRET = 8192;
// Provider ids magpie can address: a lower-case slug, optionally dotted or
// dashed. Anything else is refused before it can become an object key.
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ACCESS_ALIASES = [
  "access",
  "access_token",
  "accessToken",
  "access-token",
  "token",
  "bearer",
  "id_token",
  "idToken",
];
const REFRESH_ALIASES = ["refresh", "refresh_token", "refreshToken", "refresh-token"];
const KEY_ALIASES = ["key", "api_key", "apiKey", "api-key", "x-api-key", "apikey", "secret", "secret_key"];
const EXPIRES_ALIASES = ["expires", "expires_at", "expiresAt", "expiry", "expire_at", "expires_in", "expiresIn"];
const TYPE_ALIASES = ["type", "auth_type", "authType", "kind"];
const NAME_ALIASES = ["accountId", "account_id", "account", "email", "username", "user", "name"];
const UID_ALIASES = ["uid", "user_id", "userId", "sub", "subject"];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProviderId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return PROVIDER_ID.test(id) ? id : "";
}

// A secret is one printable token. Whitespace, control characters or a line
// break inside it mean the paste was something else (a whole file, a sentence),
// and forwarding that into the account store would be worse than refusing.
function isSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= MIN_SECRET &&
    value.length <= MAX_SECRET &&
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

function sanitizeLabel(value, fallback) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return text || fallback;
}

function tailOf(secret) {
  return isSecret(secret) ? secret.slice(-4) : "";
}

// Read one field from a flat map, trying every spelling the user may have
// typed. Later candidates never overwrite an earlier non-empty value.
function pick(map, aliases) {
  for (const name of aliases) {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      const value = map[name];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  for (const [name, value] of Object.entries(map)) {
    if (aliases.some((alias) => alias.toLowerCase() === name.toLowerCase())) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return "";
}

function flatten(value, depth = 0, out = {}) {
  if (!plainObject(value) || depth > 3) return out;
  for (const [name, inner] of Object.entries(value)) {
    if (plainObject(inner) && depth < 3) flatten(inner, depth + 1, out);
    else if (inner !== undefined && inner !== null) out[name] = inner;
  }
  return out;
}

function fromJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportError("unreadable", "这看起来是 JSON，但解析失败。请检查括号和引号。");
  }
  if (Array.isArray(value)) value = value.find(plainObject) ?? value[0];
  if (!plainObject(value)) {
    throw new ImportError("unreadable", "JSON 必须是一个对象，或一个包含对象的数组。");
  }
  // A wrapper such as { ok, value } or { auth, account } is flattened so the
  // same aliases find the fields wherever the provider put them.
  return flatten(value);
}

function fromPairs(text) {
  const fields = {};
  const segments = text.split(/[;&\n]+/);
  for (const segment of segments) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.*?)\s*$/.exec(segment);
    if (!match) {
      // "Bearer abc" has no `=`: treat it as the access token.
      const bearer = /^\s*Bearer\s+(.+)$/i.exec(segment);
      if (bearer) fields.access_token = bearer[1].trim();
      continue;
    }
    const name = match[1];
    const value = match[2];
    // `Cookie: a=1; b=2` and `Authorization: Bearer x` wrap another pair.
    if (/^(cookie|set-cookie|authorization|headers?)$/i.test(name)) {
      Object.assign(fields, fromPairs(value));
      continue;
    }
    fields[name] = value;
  }
  return fields;
}

// The decoded payload of a JWT, or null. Used only to label an account (sub /
// email); never treated as proof of anything.
function jwtClaims(secret) {
  if (typeof secret !== "string") return null;
  const parts = secret.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return plainObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function normalizeExpires(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  // `expires_in` is a duration; `expires_at` is an epoch. A small number is
  // therefore "seconds from now", a large one is an epoch in seconds, and a
  // very large one is already milliseconds (what magpie stores).
  if (number < 1e6) return Date.now() + Math.round(number * 1000);
  if (number < 1e12) return Math.round(number * 1000);
  return Math.round(number);
}

function secretsOf(entries) {
  const seen = new Set();
  for (const entry of Object.values(entries ?? {})) {
    if (!plainObject(entry)) continue;
    for (const field of ["key", "access", "refresh"]) {
      if (typeof entry[field] === "string" && entry[field]) seen.add(entry[field]);
    }
  }
  return seen;
}

/**
 * The secret values already in magpie's `plugin-auth.json`, for duplicate
 * refusal only. `readAuthEntries` deliberately strips secrets, so this is the
 * one place that reads them; the set never leaves this process and is never
 * logged. Any failure yields an empty set.
 */
function knownSecrets(entries, extra) {
  const known = secretsOf(entries);
  if (extra instanceof Set) {
    for (const secret of extra) if (typeof secret === "string" && secret) known.add(secret);
  }
  return known;
}

export function readAuthSecrets(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(join(magpieConfigDir(env), "plugin-auth.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    return secretsOf(parsed);
  } catch {
    return new Set();
  }
}

/**
 * Parse a pasted credential for any provider.
 *
 * Returns `{ kind, accountId, uid, notice, body }` where `body` is exactly what
 * `client.auth.set` should write. Throws `ImportError` with a user-facing
 * sentence; the credential itself is never echoed.
 */
export function prepareGenericImport(text, { provider, entries = {}, secrets = null } = {}) {
  const id = normalizeProviderId(provider);
  if (!id) {
    throw new ImportError("invalid_provider", "这个供应商的 id 不能作为 magpie 的账号键。", 400);
  }
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    throw new ImportError("empty", "框是空的：把 API key、token 或凭据 JSON 粘进来。");
  }
  if (raw.length > MAX_INPUT) {
    throw new ImportError("too_large", "粘贴的内容太大了，请只放一份凭据。", 413);
  }

  // A JWT is an access token, not an API key, even though it is one word.
  const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(raw);
  // A single printable token is a key even when it ends in base64 padding
  // (`=`), which would otherwise be read as a `key=value` pair.
  const singleToken = !jwtShape && !/\s/.test(raw) && /^[A-Za-z0-9._~+/%-]+={0,2}$/.test(raw);
  const fields = jwtShape
    ? {}
    : singleToken
      ? {}
      : raw.startsWith("{") || raw.startsWith("[")
        ? fromJson(raw)
        : fromPairs(raw);
  const bare = !jwtShape && singleToken && isSecret(raw) ? raw : "";

  const explicitType = String(pick(fields, TYPE_ALIASES) || "").toLowerCase();
  const key = isSecret(pick(fields, KEY_ALIASES)) ? pick(fields, KEY_ALIASES) : isSecret(bare) ? bare : "";
  const accessValue = pick(fields, ACCESS_ALIASES) || (jwtShape ? raw : "");
  const refreshValue = pick(fields, REFRESH_ALIASES);
  const access = isSecret(accessValue) ? accessValue : "";
  const refresh = isSecret(refreshValue) ? refreshValue : "";

  const wantsKey = explicitType === "api" || explicitType === "key" || Boolean(key && !access);
  if (wantsKey) {
    if (!key) {
      throw new ImportError("no_key", "没有找到可用的 API key。请粘贴完整的一串密钥。");
    }
    const known = knownSecrets(entries, secrets);
    if (known.has(key)) {
      throw new ImportError(
        "duplicate_key",
        `这个 API key 已经在 magpie 里了（…${tailOf(key)}），不用再导入。`,
        409,
      );
    }
    const accountId = sanitizeLabel(pick(fields, NAME_ALIASES), `API key …${tailOf(key)}`);
    const uid = sanitizeLabel(pick(fields, UID_ALIASES), `key_${tailOf(key)}`);
    return {
      kind: "key",
      accountId,
      uid,
      notice: "",
      body: { type: "api", key, accountId, uid },
    };
  }

  if (!access) {
    throw new ImportError(
      "no_secret",
      "没有找到 access token 或 API key。支持 JSON、Cookie / 请求头、key=value、Bearer 行，或单独一串 API key。",
    );
  }

  const known = knownSecrets(entries, secrets);
  if (known.has(access) || (refresh && known.has(refresh))) {
    throw new ImportError("duplicate_account", "这份凭据已经在 magpie 里了，不用再导入。", 409);
  }

  const claims = jwtClaims(access) || {};
  const accountId = sanitizeLabel(
    pick(fields, NAME_ALIASES) || claims.email || claims.preferred_username,
    `${id} account …${tailOf(access)}`,
  );
  const uid = sanitizeLabel(pick(fields, UID_ALIASES) || claims.sub, `access_${tailOf(access)}`);
  const expires = normalizeExpires(pick(fields, EXPIRES_ALIASES));
  const tokenType = String(pick(fields, ["token_type", "tokenType"]) || "Bearer").slice(0, 32);

  const body = {
    type: "oauth",
    access,
    expires: expires || Date.now() + 3600 * 1000,
    tokenType: /^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/.test(tokenType) ? tokenType : "Bearer",
    accountId,
    uid,
  };
  if (refresh) body.refresh = refresh;

  return {
    kind: "oauth",
    accountId,
    uid,
    notice: refresh
      ? ""
      : "这份凭据没有 refresh token：到期后需要重新导入。",
    body,
  };
}
