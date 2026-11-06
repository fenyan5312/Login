import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const PROXY_FILE_NAME = "proxies.json";
export const PROXY_TYPES = ["http", "https", "socks5"];
export const PROXY_STATUSES = ["untested", "testing", "ok", "error"];

const CONTROL = /[\u0000-\u001f\u007f]/;
const NUL = /\u0000/;
const LIMITS = {
  name: 80,
  host: 255,
  username: 255,
  password: 255,
  region: 120,
  exitIp: 80,
  error: 240,
  errorCode: 48,
  scoreLabel: 40,
  scoreIp: 80,
  id: 128,
  timestamp: 40,
};

export class ProxyInputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ProxyInputError";
    this.code = code;
    this.status = status;
  }
}

function objectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProxyInputError("invalid_body", "Request body must be a JSON object.");
  }
  return value;
}

function readText(value, { field, code, max, required = false, trim = true, control = true }) {
  if (value === undefined || value === null) {
    if (required) throw new ProxyInputError(code, `${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new ProxyInputError(code, `${field} must be text.`);
  const result = trim ? value.trim() : value;
  if (required && !result) throw new ProxyInputError(code, `${field} is required.`);
  if (result.length > max) throw new ProxyInputError(code, `${field} is too long.`);
  if (control && CONTROL.test(result)) {
    throw new ProxyInputError(code, `${field} must not contain control characters.`);
  }
  return result;
}

function readType(value, required = false) {
  const type = readText(value, {
    field: "Type",
    code: "invalid_type",
    max: 16,
    required,
  }).toLowerCase();
  if (!type) {
    if (required) throw new ProxyInputError("invalid_type", "Type is required.");
    return "";
  }
  if (!PROXY_TYPES.includes(type)) {
    throw new ProxyInputError("invalid_type", "Type must be http, https or socks5.");
  }
  return type;
}

function readHost(value, required = false) {
  let host = readText(value, {
    field: "Host",
    code: "invalid_host",
    max: LIMITS.host,
    required,
  });
  if (!host) {
    if (required) throw new ProxyInputError("invalid_host", "Host is required.");
    return "";
  }
  if (/\s/.test(host)) {
    throw new ProxyInputError("invalid_host", "Host must not contain spaces.");
  }
  // IPv6 literals are often pasted with brackets; store the bare address so
  // net.connect and SOCKS5 address encoding both see the real host.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) throw new ProxyInputError("invalid_host", "Host is required.");
  return host;
}

function readPort(value, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProxyInputError("invalid_port", "Port is required.");
    return null;
  }
  let port;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^\d{1,5}$/.test(value.trim())) {
    port = Number(value.trim());
  } else {
    throw new ProxyInputError("invalid_port", "Port must be a number between 1 and 65535.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyInputError("invalid_port", "Port must be a number between 1 and 65535.");
  }
  return port;
}

function readUsername(value) {
  return readText(value, {
    field: "Username",
    code: "invalid_username",
    max: LIMITS.username,
    trim: true,
  });
}

function readPassword(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ProxyInputError("invalid_password", "Password must be text.");
  }
  if (value.length > LIMITS.password) {
    throw new ProxyInputError("invalid_password", "Password is too long.");
  }
  if (NUL.test(value)) {
    throw new ProxyInputError("invalid_password", "Password must not contain NUL characters.");
  }
  return value;
}

export function validateCreate(body) {
  const input = objectBody(body);
  return {
    name: readText(input.name, {
      field: "Name",
      code: "invalid_name",
      max: LIMITS.name,
      required: true,
    }),
    type: readType(input.type, true),
    host: readHost(input.host, true),
    port: readPort(input.port, true),
    username: readUsername(input.username),
    password: readPassword(input.password),
  };
}

export function validateUpdate(body) {
  const input = objectBody(body);
  const changes = {};
  if ("name" in input) {
    changes.name = readText(input.name, {
      field: "Name",
      code: "invalid_name",
      max: LIMITS.name,
      required: true,
    });
  }
  if ("type" in input) changes.type = readType(input.type, true);
  if ("host" in input) changes.host = readHost(input.host, true);
  if ("port" in input) changes.port = readPort(input.port, true);
  if ("username" in input) changes.username = readUsername(input.username);
  if ("password" in input) changes.password = readPassword(input.password);
  if (!Object.keys(changes).length) {
    throw new ProxyInputError("invalid_body", "No proxy fields were provided.");
  }
  return changes;
}

// The dialog can test values before they are saved. A stored proxy supplies
// the password when the form leaves it blank, exactly as PATCH does.
export function validateProbe(body, stored = null) {
  const input = objectBody(body);
  const base = stored || {};
  const type = "type" in input ? readType(input.type, true) : readType(base.type, true);
  const host = "host" in input ? readHost(input.host, true) : readHost(base.host, true);
  const port = "port" in input ? readPort(input.port, true) : readPort(base.port, true);
  return {
    name: base.name || "",
    type,
    host,
    port,
    username: "username" in input ? readUsername(input.username) : String(base.username || ""),
    password: "password" in input ? readPassword(input.password) : String(base.password || ""),
  };
}

export function publicProxy(record) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    host: record.host,
    port: record.port,
    username: record.username || "",
    hasPassword: Boolean(record.password),
    region: record.region || "",
    exitIp: record.exitIp || "",
    status: PROXY_STATUSES.includes(record.status) ? record.status : "untested",
    latency: Number.isFinite(record.latency) ? record.latency : null,
    lastCheckedAt: record.lastCheckedAt || null,
    error: record.error || "",
    errorCode: record.errorCode || "",
    // The Claude trust score. `score` is only ever a real 0..100 integer from
    // the page, or null; the label/IP/error fields describe the last attempt.
    score: validScore(record.score),
    scoreLabel: record.scoreLabel || "",
    scoreIp: record.scoreIp || "",
    scoreCheckedAt: record.scoreCheckedAt || null,
    scoreError: record.scoreError || "",
    scoreErrorCode: record.scoreErrorCode || "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// A trust score is an integer from 0 to 100 inclusive. Anything else reads as
// "no score" rather than as a rounded or clamped fake.
function validScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function connectionKey(record) {
  return JSON.stringify([
    record.type,
    record.host,
    record.port,
    record.username || "",
    record.password || "",
  ]);
}

function textOr(value, max, fallback = "") {
  return typeof value === "string" && value.length <= max ? value : fallback;
}

function timestampOr(value, fallback) {
  return typeof value === "string" && value.length <= LIMITS.timestamp ? value : fallback;
}

function normalizeStored(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = textOr(raw.id, LIMITS.id);
  if (!id || CONTROL.test(id)) return null;
  try {
    const fields = validateCreate({
      name: raw.name,
      type: raw.type,
      host: raw.host,
      port: raw.port,
      username: raw.username,
      password: raw.password,
    });
    const status = PROXY_STATUSES.includes(raw.status) && raw.status !== "testing"
      ? raw.status
      : "untested";
    return {
      id,
      ...fields,
      region: textOr(raw.region, LIMITS.region),
      exitIp: textOr(raw.exitIp, LIMITS.exitIp),
      status,
      latency: Number.isFinite(raw.latency) && raw.latency >= 0 ? Math.round(raw.latency) : null,
      lastCheckedAt: raw.lastCheckedAt ? timestampOr(raw.lastCheckedAt, null) : null,
      error: textOr(raw.error, LIMITS.error),
      errorCode: textOr(raw.errorCode, LIMITS.errorCode),
      score: validScore(raw.score),
      scoreLabel: textOr(raw.scoreLabel, LIMITS.scoreLabel),
      scoreIp: textOr(raw.scoreIp, LIMITS.scoreIp),
      scoreCheckedAt: raw.scoreCheckedAt ? timestampOr(raw.scoreCheckedAt, null) : null,
      scoreError: textOr(raw.scoreError, LIMITS.error),
      scoreErrorCode: textOr(raw.scoreErrorCode, LIMITS.errorCode),
      createdAt: timestampOr(raw.createdAt, now),
      updatedAt: timestampOr(raw.updatedAt, now),
    };
  } catch {
    return null;
  }
}

export function createProxyStore({ dataDir }) {
  const file = join(dataDir, PROXY_FILE_NAME);
  let records = [];
  let loaded = false;
  let loading = null;
  let chain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    if (!loading) {
      loading = (async () => {
        const now = new Date().toISOString();
        let text;
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          if (error?.code === "ENOENT") {
            records = [];
            loaded = true;
            return;
          }
          throw error;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("The proxy data file is not valid JSON.");
        }
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.proxies) ? parsed.proxies : [];
        const seen = new Set();
        records = [];
        for (const item of list) {
          const record = normalizeStored(item, now);
          if (!record || seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
        loaded = true;
      })().finally(() => {
        loading = null;
      });
    }
    await loading;
  }

  function run(work) {
    const next = chain.then(async () => {
      await ensureLoaded();
      return work();
    });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function writeAtomic() {
    const payload = `${JSON.stringify({ version: 1, proxies: records }, null, 2)}\n`;
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dataDir, 0o700);
    } catch {
      // Windows and some filesystems do not implement POSIX modes. The file
      // still lives in the plugin's private data directory.
    }
    const temp = join(dataDir, `.${PROXY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await chmod(temp, 0o600);
      } catch {
        // See the directory-mode note above.
      }
      try {
        await rename(temp, file);
      } catch (error) {
        if (!["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code)) throw error;
        await rm(file, { force: true });
        await rename(temp, file);
      }
      try {
        await chmod(file, 0o600);
      } catch {
        // See the directory-mode note above.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    file,
    list: () => run(() => records.map(publicProxy)),
    get: (id) => run(() => {
      const record = records.find((item) => item.id === id);
      return record ? { ...record } : null;
    }),
    create: (input) => run(async () => {
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(),
        ...input,
        region: "",
        exitIp: "",
        status: "untested",
        latency: null,
        lastCheckedAt: null,
        error: "",
        errorCode: "",
        score: null,
        scoreLabel: "",
        scoreIp: "",
        scoreCheckedAt: null,
        scoreError: "",
        scoreErrorCode: "",
        createdAt: now,
        updatedAt: now,
      };
      // randomUUID collisions are vanishingly unlikely, but ids are the API's
      // addressing scheme, so never let two records share one.
      while (records.some((item) => item.id === record.id)) record.id = randomUUID();
      const before = records;
      records = [...records, record];
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        throw error;
      }
      return { ...record };
    }),
    update: (id, changes) => run(async () => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const previous = records[index];
      const now = new Date().toISOString();
      const next = { ...previous, ...changes, updatedAt: now };
      if (connectionKey(previous) !== connectionKey(next)) {
        next.region = "";
        next.exitIp = "";
        next.status = "untested";
        next.latency = null;
        next.lastCheckedAt = null;
        next.error = "";
        next.errorCode = "";
        next.score = null;
        next.scoreLabel = "";
        next.scoreIp = "";
        next.scoreCheckedAt = null;
        next.scoreError = "";
        next.scoreErrorCode = "";
      }
      const before = records;
      records = records.slice();
      records[index] = next;
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        throw error;
      }
      return { ...next };
    }),
    remove: (id) => run(async () => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const before = records;
      const removed = records[index];
      records = records.filter((item) => item.id !== id);
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        throw error;
      }
      return { ...removed };
    }),
    // A test result is applied only to the exact revision that was tested.
    // Deleting or editing the row while a probe is in flight therefore cannot
    // resurrect or overwrite it.
    applyTestResult: (id, result, expectedUpdatedAt) => run(async () => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const previous = records[index];
      if (expectedUpdatedAt && previous.updatedAt !== expectedUpdatedAt) return null;
      const now = new Date().toISOString();
      const next = {
        ...previous,
        status: result.ok ? "ok" : "error",
        latency: result.ok && Number.isFinite(result.latency) ? Math.round(result.latency) : null,
        region: result.ok ? textOr(result.region, LIMITS.region) : "",
        exitIp: result.ok ? textOr(result.exitIp, LIMITS.exitIp) : "",
        error: result.ok ? "" : textOr(result.error, LIMITS.error, "The proxy test failed."),
        errorCode: result.ok ? "" : textOr(result.errorCode, LIMITS.errorCode),
        lastCheckedAt: timestampOr(result.checkedAt, now),
        updatedAt: now,
      };
      const before = records;
      records = records.slice();
      records[index] = next;
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        throw error;
      }
      return { ...next };
    }),
    // A trust score is applied only to the exact revision that was measured.
    // Editing the row while the page is open therefore cannot scribble the old
    // result onto the new connection. A failed attempt records its own error
    // and clears the score; it never leaves a stale number behind.
    applyScoreResult: (id, result, expectedUpdatedAt) => run(async () => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const previous = records[index];
      if (expectedUpdatedAt && previous.updatedAt !== expectedUpdatedAt) return null;
      const now = new Date().toISOString();
      const ok = result?.ok === true && validScore(result.score) !== null;
      const next = {
        ...previous,
        score: ok ? result.score : null,
        scoreLabel: ok ? textOr(result.label, LIMITS.scoreLabel) : "",
        scoreIp: ok ? textOr(result.ip, LIMITS.scoreIp) : "",
        scoreCheckedAt: timestampOr(result.checkedAt, now),
        scoreError: ok
          ? ""
          : textOr(result?.error, LIMITS.error, "The trust score check returned no usable score."),
        scoreErrorCode: ok
          ? ""
          : textOr(result?.errorCode, LIMITS.errorCode) || "score_missing",
        updatedAt: now,
      };
      const before = records;
      records = records.slice();
      records[index] = next;
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        throw error;
      }
      return { ...next };
    }),
  };
}
