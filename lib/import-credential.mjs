// Importing a pasted WorkBuddy credential (JSON, Cookie header, curl, API key)
// into magpie, from the page rather than from magpie's own provider menu.
//
// This module parses and *proves* the credential — a refresh token is really
// spent once, so a dead credential fails here instead of being stored — and
// hands back the body magpie's `save` would write. It never writes to disk and
// never logs a credential; lib/server.mjs does the write through the injected
// `client.auth.set`, exactly like a sign-in.
import {
  decodeJwt,
  displayName,
  knownKeys,
  knownUids,
  parsePayload,
  renew,
  readStore,
} from "./workbuddy-credential.mjs";

export class ImportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.status = status;
  }
}

function keyTail(key) {
  return String(key || "").slice(-4);
}

/**
 * Parse a pasted credential and return the account magpie should store.
 *
 * `{ result, accountId, uid, kind }` on success. Throws `ImportError` with a
 * sentence that can be shown verbatim; no credential value is ever included.
 */
export async function prepareImport(text, { provider = "workbuddy", fetchImpl = fetch } = {}) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) throw new ImportError("empty", "框是空的：把凭据 JSON、Cookie、请求头或 API key 粘进来。");

  const parsed = parsePayload(raw);
  if (parsed.error) {
    throw new ImportError("unreadable", `读不出凭据：${parsed.error}`);
  }
  if (!parsed.accounts.length) {
    throw new ImportError("unreadable", "读不出凭据：没有找到 access token、refresh token 或 API key。");
  }

  const rec = parsed.accounts[0];
  const multiple =
    parsed.accounts.length > 1
      ? `这份内容里有 ${parsed.accounts.length} 个账号，只导入第一个。`
      : "";

  // An API key is a sign-in on its own: magpie keeps it as {type:"api", key},
  // the shape every WorkBuddy client sends as X-API-Key. Nothing renews it and
  // WorkBuddy's own /v3/config answers 200 to any key, so it is not validated
  // here; the first real request is the honest check.
  if (rec.kind === "key") {
    if (knownKeys().has(rec.key)) {
      throw new ImportError(
        "duplicate_key",
        `这个 API key 已经在 magpie 里了（…${keyTail(rec.key)}），不用再导入。`,
        409,
      );
    }
    const tail = keyTail(rec.key);
    return {
      kind: "key",
      accountId: `WorkBuddy API key …${tail}`,
      uid: rec.uid || `anonymous_${tail}`,
      notice: multiple,
      result: {
        type: "success",
        provider,
        key: rec.key,
        accountId: `WorkBuddy API key …${tail}`,
        uid: rec.uid || `anonymous_${tail}`,
      },
    };
  }

  if (!rec.refresh) {
    throw new ImportError(
      "no_refresh",
      "这份凭据里没有 refresh token，登录会在一小时后失效。请换一份完整的凭据，或直接粘贴 WorkBuddy 的 API key（ck_ 开头）。",
    );
  }

  const uid = rec.uid || decodeJwt(rec.access)?.sub || "";

  if (uid && knownUids().has(uid)) {
    const kept = Object.values(readStore()).find((value) => value && value.uid === uid);
    const newer =
      kept?.expires && rec.expires && kept.expires > rec.expires
        ? " magpie 里那份还比这次填的新，覆盖反而是降级，所以没有动它。"
        : "";
    throw new ImportError(
      "duplicate_account",
      `这个账号已经在 magpie 里了（${uid.slice(0, 8)}…），不用再导入。${newer}`,
      409,
    );
  }

  let live;
  try {
    live = await renew(rec, { fetchImpl });
  } catch (error) {
    const reason = String(error?.message || error);
    throw new ImportError(
      "refresh_failed",
      `凭据没能换到新 token：${reason}。凭据可能已失效，或这台机器连不上 WorkBuddy。`,
      502,
    );
  }

  const access = live.accessToken || rec.access;
  const claims = decodeJwt(access) || {};
  const finalUid = uid || claims.sub || "";
  // Never empty: magpie renders an empty accountId as the literal "Signed in".
  const who = displayName({ ...rec, uid: finalUid }, claims);

  return {
    kind: "oauth",
    accountId: who,
    uid: finalUid,
    notice: multiple,
    result: {
      type: "success",
      provider,
      access,
      refresh: live.refreshToken || rec.refresh,
      expires: Date.now() + (Number(live.expiresIn) > 0 ? Number(live.expiresIn) * 1000 : 3600 * 1000),
      refreshExpiresAt:
        Date.now() + (Number(live.refreshExpiresIn) > 0 ? Number(live.refreshExpiresIn) * 1000 : 0),
      tokenType: live.tokenType || rec.tokenType || "Bearer",
      accountId: who,
      uid: finalUid,
      domain: live.domain || rec.domain,
      ...(rec.enterpriseId ? { enterpriseId: rec.enterpriseId } : {}),
    },
  };
}
