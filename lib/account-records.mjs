// Pure helpers for the extended `account.json` ownership ledger.
//
// The ledger is the only place a note, an exit snapshot or an identity-check
// result is persisted. Everything that reaches this module is untrusted: a
// proxy record carries a password, a host and a port, and an account directory
// is a filesystem path. Only the whitelisted display fields below may ever be
// written to (or read back out of) the ledger, so a credential or a path can
// never travel into the page response.

export const NOTE_MAX_LENGTH = 200;
export const LOGIN_HISTORY_LIMIT = 20;
export const CHECK_HISTORY_LIMIT = 10;

const PROXY_TYPES = new Set(["http", "https", "socks5"]);
const GRADES = new Set(["A", "B", "C", "D"]);
const SUMMARY_LIMIT = 4;
const SUMMARY_LINE_MAX = 500;

export class AccountRecordError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AccountRecordError";
    this.code = code;
    this.status = status;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nullableText(value, max) {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function timestamp(value) {
  return typeof value === "string" && value ? value.slice(0, 40) : null;
}

function proxyType(value) {
  return PROXY_TYPES.has(value) ? value : null;
}

export function normalizeNote(value) {
  if (typeof value !== "string") {
    throw new AccountRecordError("invalid_note", "The note must be text.", 400);
  }
  const note = value.trim();
  if (note.length > NOTE_MAX_LENGTH) {
    throw new AccountRecordError(
      "invalid_note",
      `The note must be at most ${NOTE_MAX_LENGTH} characters.`,
      400,
    );
  }
  return note;
}

// Turns a full stored proxy record (or the already-whitelisted `{ id, name,
// region, type }` meta the sign-in flow receives) into the display-only exit
// snapshot. A null proxy means a direct connection. `source.id` /
// `source.proxyId` are both accepted so a normalized snapshot can be re-read.
export function loginSnapshot(proxy, at) {
  const source = isObject(proxy) ? proxy : {};
  return {
    at: timestamp(at),
    proxyId: nullableText(source.id ?? source.proxyId, 128),
    proxyName: text(source.name ?? source.proxyName, 80),
    region: text(source.region, 120),
    type: proxyType(source.type),
  };
}

function cleanLogin(value) {
  const source = isObject(value) ? value : {};
  return {
    at: timestamp(source.at),
    proxyId: nullableText(source.proxyId, 128),
    proxyName: text(source.proxyName, 80),
    region: text(source.region, 120),
    type: proxyType(source.type),
  };
}

function cleanCheck(value) {
  const source = isObject(value) ? value : {};
  return {
    at: timestamp(source.at),
    grade: GRADES.has(source.grade) ? source.grade : null,
    proxyId: nullableText(source.proxyId, 128),
    proxyName: text(source.proxyName, 80),
    region: text(source.region, 120),
    exposure:
      Number.isFinite(source.exposure) && source.exposure >= 0
        ? Math.trunc(source.exposure)
        : 0,
    summary: Array.isArray(source.summary)
      ? source.summary
          .filter((line) => typeof line === "string")
          .slice(0, SUMMARY_LIMIT)
          .map((line) => line.slice(0, SUMMARY_LINE_MAX))
      : [],
  };
}

export function withLogin(meta, snapshot) {
  const base = isObject(meta) ? meta : {};
  const history = Array.isArray(base.loginHistory) ? base.loginHistory : [];
  return {
    ...base,
    lastLogin: snapshot,
    loginHistory: [snapshot, ...history].slice(0, LOGIN_HISTORY_LIMIT),
  };
}

export function withNote(meta, note) {
  const base = isObject(meta) ? meta : {};
  return { ...base, note };
}

export function withCheck(meta, check) {
  const base = isObject(meta) ? meta : {};
  const history = Array.isArray(base.checks) ? base.checks : [];
  return {
    ...base,
    checks: [check, ...history].slice(0, CHECK_HISTORY_LIMIT),
  };
}

// The page-facing projection of the ledger's optional fields. Every nested
// entry is rebuilt from whitelisted fields, so a stale or tampered ledger can
// never smuggle a credential or a path into the response.
export function accountExtras(meta) {
  const base = isObject(meta) ? meta : {};
  const loginHistory = (Array.isArray(base.loginHistory) ? base.loginHistory : [])
    .slice(0, LOGIN_HISTORY_LIMIT)
    .map(cleanLogin);
  const checks = (Array.isArray(base.checks) ? base.checks : [])
    .slice(0, CHECK_HISTORY_LIMIT)
    .map(cleanCheck);
  return {
    note: typeof base.note === "string" ? base.note.slice(0, NOTE_MAX_LENGTH) : "",
    lastLogin: isObject(base.lastLogin) ? cleanLogin(base.lastLogin) : null,
    loginHistory,
    lastCheck: checks[0] ?? null,
    checks,
    // The group an account belongs to. The specific exit is already in
    // `lastLogin.proxyId`; this only names the rule the exit was chosen under.
    proxyGroupId: nullableText(base.proxyGroupId, 128),
    proxyGroupName: text(base.proxyGroupName, 80),
  };
}
