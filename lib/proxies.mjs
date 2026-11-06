import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const PROXY_FILE_NAME = "proxies.json";
export const PROXY_TYPES = ["http", "https", "socks5"];
export const PROXY_STATUSES = ["untested", "testing", "ok", "error"];
export const PROXY_GROUP_MODES = ["group", "tag"];

const CONTROL = /[\u0000-\u001f\u007f]/;
const NUL = /\u0000/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;
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
  tag: 32,
  tags: 20,
  groupName: 80,
  groupNote: 200,
  groupProvider: 64,
  groupMembers: 500,
  groupPerIp: 50,
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
    tags: readTags(input.tags),
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
  if ("tags" in input) changes.tags = readTags(input.tags);
  if (!Object.keys(changes).length) {
    throw new ProxyInputError("invalid_body", "No proxy fields were provided.");
  }
  return changes;
}

// Tags are the free-form half of "group or tag": a tag-mode group selects its
// members by carrying the group's tag. Accepts an array or a comma-separated
// line from the dialog, and never stores a duplicate or a control character.
export function readTags(value) {
  if (value === undefined || value === null || value === "") return [];
  let items;
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") items = value.split(",");
  else throw new ProxyInputError("invalid_tags", "Tags must be text.");
  const tags = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new ProxyInputError("invalid_tags", "Every tag must be text.");
    }
    const tag = item.trim();
    if (!tag) continue;
    if (tag.length > LIMITS.tag) {
      throw new ProxyInputError("invalid_tags", `A tag must be at most ${LIMITS.tag} characters.`);
    }
    if (CONTROL.test(tag)) {
      throw new ProxyInputError("invalid_tags", "A tag must not contain control characters.");
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > LIMITS.tags) {
    throw new ProxyInputError("invalid_tags", `A proxy can carry at most ${LIMITS.tags} tags.`);
  }
  return tags;
}

function readProvider(value) {
  if (value === undefined || value === null) return "";
  const provider = readText(value, {
    field: "Provider",
    code: "invalid_provider",
    max: LIMITS.groupProvider,
  });
  if (provider && !PROVIDER_ID.test(provider)) {
    throw new ProxyInputError(
      "invalid_provider",
      "Provider must be a provider id such as claude or workbuddy.",
    );
  }
  return provider;
}

function readGroupMode(value, required = true) {
  const mode = readText(value, {
    field: "Mode",
    code: "invalid_group_mode",
    max: 16,
    required,
  }).toLowerCase();
  if (!mode) {
    if (required) throw new ProxyInputError("invalid_group_mode", "Mode is required.");
    return "";
  }
  if (!PROXY_GROUP_MODES.includes(mode)) {
    throw new ProxyInputError("invalid_group_mode", "Mode must be group or tag.");
  }
  return mode;
}

function readPerIp(value, fallback = 2) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "string" && /^\d{1,3}$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isInteger(number) || number < 1 || number > LIMITS.groupPerIp) {
    throw new ProxyInputError(
      "invalid_per_ip",
      `Accounts per IP must be a whole number from 1 to ${LIMITS.groupPerIp}.`,
    );
  }
  return number;
}

// A group's place in the IP-group tree. `null` means a root group; anything
// else must name an existing group, which the store checks against the tree it
// actually holds.
function readParentId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ProxyInputError("invalid_parent", "Parent id must be text.");
  }
  const parentId = value.trim();
  if (!parentId) return null;
  if (parentId.length > LIMITS.id || CONTROL.test(parentId)) {
    throw new ProxyInputError("invalid_parent", "Parent id is not valid.");
  }
  return parentId;
}

// A tag's parent is another tag's name, so it obeys the same 32-character
// rule as a tag itself.
function readTagParent(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ProxyInputError("invalid_parent", "Parent tag must be text.");
  }
  const parent = value.trim();
  if (!parent) return null;
  if (parent.length > LIMITS.tag || CONTROL.test(parent)) {
    throw new ProxyInputError("invalid_parent", "Parent tag is not valid.");
  }
  return parent;
}

function readProxyIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProxyInputError("invalid_members", "Members must be a list of proxy ids.");
  }
  const ids = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new ProxyInputError("invalid_members", "Every member must be a proxy id.");
    }
    const id = item.trim();
    if (id.length > LIMITS.id || CONTROL.test(id)) {
      throw new ProxyInputError("invalid_members", "A member id is not valid.");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > LIMITS.groupMembers) {
    throw new ProxyInputError(
      "invalid_members",
      `A group can hold at most ${LIMITS.groupMembers} proxies.`,
    );
  }
  return ids;
}

// A group is one rule for how many accounts may share each IP:
//   group mode -> its members are exactly `proxyIds`
//   tag mode   -> its members are the proxies carrying `tag`
// It may be scoped to one provider; an empty provider means any provider.
// `parentId` nests it under another group; the store validates the tree.
export function validateGroupCreate(body) {
  const input = objectBody(body);
  const name = readText(input.name, {
    field: "Name",
    code: "invalid_name",
    max: LIMITS.groupName,
    required: true,
  });
  const mode = readGroupMode(input.mode);
  const tag = readText(input.tag, {
    field: "Tag",
    code: "invalid_tag",
    max: LIMITS.tag,
  });
  if (mode === "tag" && !tag) {
    throw new ProxyInputError("invalid_tag", "A tag group needs a tag to select its IPs.");
  }
  const fields = {
    name,
    provider: readProvider(input.provider),
    mode,
    tag: mode === "tag" ? tag : "",
    proxyIds: mode === "group" ? readProxyIds(input.proxyIds) : [],
    perIp: readPerIp(input.perIp),
    note: readText(input.note, {
      field: "Note",
      code: "invalid_note",
      max: LIMITS.groupNote,
    }),
  };
  // Kept out of the default shape so callers validating a v2 body get exactly
  // the fields they asked about.
  if ("parentId" in input) fields.parentId = readParentId(input.parentId);
  return fields;
}

export function validateGroupUpdate(body) {
  const input = objectBody(body);
  const changes = {};
  if ("name" in input) {
    changes.name = readText(input.name, {
      field: "Name",
      code: "invalid_name",
      max: LIMITS.groupName,
      required: true,
    });
  }
  if ("provider" in input) changes.provider = readProvider(input.provider);
  if ("mode" in input) changes.mode = readGroupMode(input.mode);
  if ("tag" in input) {
    changes.tag = readText(input.tag, {
      field: "Tag",
      code: "invalid_tag",
      max: LIMITS.tag,
    });
  }
  if ("proxyIds" in input) changes.proxyIds = readProxyIds(input.proxyIds);
  if ("parentId" in input) changes.parentId = readParentId(input.parentId);
  if ("perIp" in input) changes.perIp = readPerIp(input.perIp);
  if ("note" in input) {
    changes.note = readText(input.note, {
      field: "Note",
      code: "invalid_note",
      max: LIMITS.groupNote,
    });
  }
  if (!Object.keys(changes).length) {
    throw new ProxyInputError("invalid_body", "No group fields were provided.");
  }
  return changes;
}

// Tag registry: tag *names* are the identity (renaming is not supported), and
// `parent` nests a tag under another tag. The registry exists so a tag tree can
// be navigated without scanning every proxy.
export function validateTagCreate(body) {
  const input = objectBody(body);
  return {
    name: readText(input.name, {
      field: "Tag",
      code: "invalid_tag",
      max: LIMITS.tag,
      required: true,
    }),
    parent: readTagParent(input.parent),
  };
}

export function validateTagUpdate(body) {
  const input = objectBody(body);
  if (!("parent" in input)) {
    throw new ProxyInputError("invalid_body", "No tag fields were provided.");
  }
  return { parent: readTagParent(input.parent) };
}

// The tag tree. A root is depth 1; a child may go at most three levels deep.
function tagParent(tag) {
  return tag && typeof tag.parent === "string" && tag.parent ? tag.parent : null;
}

function groupParentId(group) {
  return group && typeof group.parentId === "string" && group.parentId ? group.parentId : null;
}

export function tagChildren(tags, name) {
  const list = Array.isArray(tags) ? tags : [];
  return list.filter((tag) => tagParent(tag) === name);
}

// The named tag and every tag below it, depth-first. An unknown name yields an
// empty list, so a group pointing at a tag that was never registered selects
// nothing rather than throwing.
export function tagDescendants(tags, name) {
  const list = Array.isArray(tags) ? tags : [];
  if (!name || !list.some((tag) => tag.name === name)) return [];
  const found = [];
  const seen = new Set();
  const walk = (current) => {
    if (!current || seen.has(current)) return;
    seen.add(current);
    found.push(current);
    for (const child of tagChildren(list, current)) walk(child.name);
  };
  walk(name);
  return found;
}

export function tagDepth(tags, name) {
  const list = Array.isArray(tags) ? tags : [];
  if (!name) return null;
  const byName = new Map(list.map((tag) => [tag.name, tag]));
  const seen = new Set();
  let current = name;
  let depth = 0;
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    const tag = byName.get(current);
    if (!tag) return null;
    depth += 1;
    current = tagParent(tag);
  }
  return depth;
}

// Direct children of a group, in registry order.
export function groupChildren(groups, id) {
  const list = Array.isArray(groups) ? groups : [];
  return list.filter((group) => groupParentId(group) === id);
}

// The named group and every group below it, depth-first. Includes the id
// itself so callers can treat "own members" and "subtree members" uniformly.
export function groupDescendantIds(groups, id) {
  const list = Array.isArray(groups) ? groups : [];
  if (!id || !list.some((group) => group.id === id)) return [];
  const found = [];
  const seen = new Set();
  const walk = (current) => {
    if (!current || seen.has(current)) return;
    seen.add(current);
    found.push(current);
    for (const child of groupChildren(list, current)) walk(child.id);
  };
  walk(id);
  return found;
}

// Root = 1. An id the caller cannot place in the tree reads as null.
export function groupDepth(groups, id) {
  const list = Array.isArray(groups) ? groups : [];
  if (!id) return null;
  const byId = new Map(list.map((group) => [group.id, group]));
  const seen = new Set();
  let current = id;
  let depth = 0;
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    const group = byId.get(current);
    if (!group) return null;
    depth += 1;
    current = groupParentId(group);
  }
  return depth;
}

// Depth-first ordering: roots in registry order, then each root's subtree. A
// node whose parent is missing from the list is treated as a root, so a file
// that lost a group still renders every other group.
function depthFirst(nodes, keyOf, parentOf) {
  const list = Array.isArray(nodes) ? nodes : [];
  const known = new Set(list.map(keyOf));
  const byParent = new Map();
  for (const node of list) {
    const parent = parentOf(node);
    const key = parent && parent !== keyOf(node) && known.has(parent) ? parent : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent) => {
    for (const node of byParent.get(parent) ?? []) {
      const key = keyOf(node);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(node);
      walk(key);
    }
  };
  walk(null);
  return out;
}

export function orderGroups(groups) {
  return depthFirst(groups, (group) => group.id, groupParentId);
}

export function orderTags(tags) {
  return depthFirst(tags, (tag) => tag.name, tagParent);
}

// The page-facing registry summary. `proxyCount` and `groupCount` name direct
// references only: a parent tag does not claim its children's proxies.
export function tagSummaries(tags, proxies = [], groups = []) {
  const list = Array.isArray(tags) ? tags : [];
  const proxyList = Array.isArray(proxies) ? proxies : [];
  const groupList = Array.isArray(groups) ? groups : [];
  return orderTags(list).map((tag) => ({
    name: tag.name,
    parent: tagParent(tag),
    depth: tagDepth(list, tag.name) ?? 1,
    childCount: tagChildren(list, tag.name).length,
    proxyCount: proxyList.filter(
      (proxy) => Array.isArray(proxy.tags) && proxy.tags.includes(tag.name),
    ).length,
    groupCount: groupList.filter((group) => group.mode === "tag" && group.tag === tag.name).length,
  }));
}

// Works on raw records and on `publicProxy` output alike: both carry id/tags.
//
// A member of a parent group is a member of every group above it, so group mode
// unions the group's own `proxyIds` with those of all descendant groups, and
// tag mode accepts the group's tag plus every descendant tag. Both are returned
// in proxy-list order, without duplicates.
export function groupMembers(group, proxies, groups = [], tags = []) {
  if (!group || typeof group !== "object") return [];
  const list = Array.isArray(proxies) ? proxies : [];
  if (group.mode === "tag") {
    const tag = String(group.tag || "");
    if (!tag) return [];
    const wanted = new Set(tagDescendants(tags, tag));
    wanted.add(tag);
    return list.filter(
      (proxy) => Array.isArray(proxy.tags) && proxy.tags.some((name) => wanted.has(name)),
    );
  }
  const groupList = Array.isArray(groups) ? groups : [];
  const ids = new Set(Array.isArray(group.proxyIds) ? group.proxyIds : []);
  for (const id of groupDescendantIds(groupList, group.id)) {
    if (id === group.id) continue;
    const descendant = groupList.find((item) => item.id === id);
    if (!descendant) continue;
    for (const member of Array.isArray(descendant.proxyIds) ? descendant.proxyIds : []) {
      ids.add(member);
    }
  }
  return list.filter((proxy) => ids.has(proxy.id));
}

function accountProxyId(account) {
  return (
    account?.meta?.lastLogin?.proxyId ??
    account?.lastLogin?.proxyId ??
    null
  );
}

function accountProvider(account) {
  return account?.meta?.provider ?? account?.provider ?? "";
}

// Per-IP load for one group, counted from the accounts' ledgers. An account
// whose remembered exit is not a member of this group does not consume one of
// its slots. `group.provider` narrows the count to that provider's accounts.
export function groupUsage(group, proxies, accounts, groups = [], tags = []) {
  const members = groupMembers(group, proxies, groups, tags);
  const counts = new Map();
  for (const member of members) counts.set(member.id, 0);
  const wantedProvider = String(group?.provider || "");
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (wantedProvider && accountProvider(account) !== wantedProvider) continue;
    const proxyId = accountProxyId(account);
    if (!proxyId || !counts.has(proxyId)) continue;
    counts.set(proxyId, counts.get(proxyId) + 1);
  }
  let used = 0;
  for (const count of counts.values()) used += count;
  return { members, counts, used, capacity: members.length * Number(group?.perIp || 0) };
}

// Picks the least-loaded member that still has room for one more account.
// Returns null when every member is at the group's per-IP cap, so the caller
// can refuse the sign-in instead of silently exceeding the risk policy.
export function allocateGroupProxy({ group, proxies, accounts, groups = [], tags = [] } = {}) {
  if (!group || typeof group !== "object") return null;
  const perIp = Number(group.perIp);
  if (!Number.isInteger(perIp) || perIp < 1) return null;
  const { members, counts } = groupUsage(group, proxies, accounts, groups, tags);
  const available = members.filter((proxy) => (counts.get(proxy.id) || 0) < perIp);
  if (!available.length) return null;
  available.sort((a, b) => {
    const load = (counts.get(a.id) || 0) - (counts.get(b.id) || 0);
    if (load !== 0) return load;
    const byName = String(a.name || a.id).localeCompare(String(b.name || b.id));
    if (byName !== 0) return byName;
    return String(a.id).localeCompare(String(b.id));
  });
  return available[0];
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
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
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
      tags: raw.tags,
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

function normalizeStoredGroup(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = textOr(raw.id, LIMITS.id);
  if (!id || CONTROL.test(id)) return null;
  let parentId = null;
  if (typeof raw.parentId === "string" && raw.parentId && raw.parentId.length <= LIMITS.id) {
    if (!CONTROL.test(raw.parentId)) parentId = raw.parentId;
  }
  try {
    const fields = validateGroupCreate({
      name: raw.name,
      provider: raw.provider,
      mode: raw.mode,
      tag: raw.tag,
      proxyIds: raw.proxyIds,
      perIp: raw.perIp,
      note: raw.note,
    });
    return {
      id,
      ...fields,
      parentId,
      createdAt: timestampOr(raw.createdAt, now),
      updatedAt: timestampOr(raw.updatedAt, now),
    };
  } catch {
    return null;
  }
}

function normalizeStoredTag(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    return {
      name: readText(raw.name, {
        field: "Tag",
        code: "invalid_tag",
        max: LIMITS.tag,
        required: true,
      }),
      parent: readTagParent(raw.parent),
    };
  } catch {
    return null;
  }
}

// On load a broken parent link must not poison the tree: a tag or group whose
// parent is gone, whose chain loops, that would sit deeper than three levels,
// or (for groups) that disagrees with its parent's provider is lifted to the
// root instead of being dropped. A hand-edited file therefore still lists
// everything, just with the impossible nesting removed.
function sanitizeTagTree(list) {
  const records = [];
  const byName = new Map();
  for (const tag of list) {
    if (byName.has(tag.name)) continue;
    const record = { name: tag.name, parent: tagParent(tag) };
    byName.set(record.name, record);
    records.push(record);
  }
  for (const tag of records) {
    let parent = tag.parent;
    if (!parent) continue;
    const seen = new Set([tag.name]);
    let depth = 1;
    let valid = true;
    while (parent) {
      if (seen.has(parent)) {
        valid = false;
        break;
      }
      seen.add(parent);
      const record = byName.get(parent);
      if (!record) {
        valid = false;
        break;
      }
      depth += 1;
      parent = tagParent(record);
    }
    if (!valid || depth > 3) tag.parent = null;
  }
  return records;
}

function sanitizeGroupParents(list) {
  const byId = new Map(list.map((group) => [group.id, group]));
  return list.map((group) => {
    let parentId = groupParentId(group);
    if (!parentId) return { ...group, parentId: null };
    const seen = new Set([group.id]);
    let child = group;
    let current = parentId;
    let depth = 1;
    let valid = true;
    while (current) {
      if (seen.has(current)) {
        valid = false;
        break;
      }
      seen.add(current);
      const parent = byId.get(current);
      if (!parent) {
        valid = false;
        break;
      }
      const parentProvider = String(parent.provider || "");
      if (parentProvider && String(child.provider || "") !== parentProvider) {
        valid = false;
        break;
      }
      depth += 1;
      child = parent;
      current = groupParentId(parent);
    }
    if (!valid || depth > 3) parentId = null;
    return { ...group, parentId };
  });
}

// A candidate tree is validated whole: every parent link, every loop and the
// three-level limit. Doing it on the whole list means a provider change on a
// parent is checked against its children as well.
function validateGroupTree(list) {
  const byId = new Map(list.map((group) => [group.id, group]));
  for (const group of list) {
    const parentId = groupParentId(group);
    if (!parentId) continue;
    if (parentId === group.id) {
      throw new ProxyInputError("invalid_parent", "Groups cannot be nested inside themselves.");
    }
    if (!byId.has(parentId)) {
      throw new ProxyInputError("invalid_parent", "Parent group does not exist.");
    }
    const seen = new Set([group.id]);
    let child = group;
    let current = parentId;
    let depth = 1;
    while (current) {
      if (seen.has(current)) {
        throw new ProxyInputError("invalid_parent", "Groups cannot be nested inside themselves.");
      }
      seen.add(current);
      const parent = byId.get(current);
      if (!parent) throw new ProxyInputError("invalid_parent", "Parent group does not exist.");
      const parentProvider = String(parent.provider || "");
      if (parentProvider && String(child.provider || "") !== parentProvider) {
        throw new ProxyInputError(
          "provider_mismatch",
          `Group "${child.name}" must use provider "${parentProvider}" to sit under "${parent.name}".`,
        );
      }
      depth += 1;
      child = parent;
      current = groupParentId(parent);
    }
    if (depth > 3) {
      throw new ProxyInputError("invalid_parent", "Groups can be nested at most 3 levels deep.");
    }
  }
}

function validateTagTree(list) {
  const byName = new Map();
  for (const tag of list) {
    if (byName.has(tag.name)) {
      throw new ProxyInputError("tag_exists", `Tag "${tag.name}" already exists.`, 409);
    }
    byName.set(tag.name, tag);
  }
  for (const tag of list) {
    const parent = tagParent(tag);
    if (!parent) continue;
    if (parent === tag.name) {
      throw new ProxyInputError("invalid_parent", "Tags cannot be nested inside themselves.");
    }
    if (!byName.has(parent)) {
      throw new ProxyInputError("invalid_parent", "Parent tag does not exist.");
    }
    const seen = new Set([tag.name]);
    let current = parent;
    let depth = 1;
    while (current) {
      if (seen.has(current)) {
        throw new ProxyInputError("invalid_parent", "Tags cannot be nested inside themselves.");
      }
      seen.add(current);
      const record = byName.get(current);
      if (!record) throw new ProxyInputError("invalid_parent", "Parent tag does not exist.");
      depth += 1;
      current = tagParent(record);
    }
    if (depth > 3) {
      throw new ProxyInputError("invalid_parent", "Tags can be nested at most 3 levels deep.");
    }
  }
}

// Adding a proxy tag that the registry has never seen registers it at the root.
// This is what makes the proxy form the place a new tag is born.
function withRegisteredTag(list, name) {
  if (!name || list.some((tag) => tag.name === name)) return list;
  return [...list, { name, parent: null }];
}

function withRegisteredTags(list, names) {
  let next = list;
  for (const name of Array.isArray(names) ? names : []) next = withRegisteredTag(next, name);
  return next;
}

export function createProxyStore({ dataDir }) {
  const file = join(dataDir, PROXY_FILE_NAME);
  let records = [];
  let groups = [];
  let tags = [];
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
            groups = [];
            tags = [];
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
        const groupList = Array.isArray(parsed?.groups) ? parsed.groups : [];
        const seen = new Set();
        records = [];
        for (const item of list) {
          const record = normalizeStored(item, now);
          if (!record || seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
        const seenGroups = new Set();
        groups = [];
        for (const item of groupList) {
          const group = normalizeStoredGroup(item, now);
          if (!group || seenGroups.has(group.id)) continue;
          seenGroups.add(group.id);
          groups.push(group);
        }
        groups = sanitizeGroupParents(groups);
        // v1 and v2 files predate the registry; they simply have no tags and
        // are upgraded to v3 on the next write.
        const tagList = Array.isArray(parsed?.tags) ? parsed.tags : [];
        const seenTags = [];
        for (const item of tagList) {
          const tag = normalizeStoredTag(item);
          if (tag) seenTags.push(tag);
        }
        tags = sanitizeTagTree(seenTags);
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
    const payload = `${JSON.stringify({ version: 3, proxies: records, groups, tags }, null, 2)}\n`;
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
        tags: readTags(input.tags),
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
      const beforeTags = tags;
      records = [...records, record];
      // A tag typed on the proxy form is registered at the root the first time
      // it is used, so the tag picker learns about it without a second step.
      tags = withRegisteredTags(tags, record.tags);
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        tags = beforeTags;
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
      const beforeTags = tags;
      records = records.slice();
      records[index] = next;
      if (Array.isArray(next.tags)) tags = withRegisteredTags(tags, next.tags);
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        tags = beforeTags;
        throw error;
      }
      return { ...next };
    }),
    remove: (id) => run(async () => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const before = records;
      const beforeGroups = groups;
      const removed = records[index];
      records = records.filter((item) => item.id !== id);
      // A deleted IP cannot stay a member of a group-mode group.
      groups = groups.map((group) =>
        group.mode === "group" && group.proxyIds.includes(id)
          ? { ...group, proxyIds: group.proxyIds.filter((member) => member !== id) }
          : group,
      );
      try {
        await writeAtomic();
      } catch (error) {
        records = before;
        groups = beforeGroups;
        throw error;
      }
      return { ...removed };
    }),
    listGroups: () => run(() =>
      groups.map((group) => ({ ...group, proxyIds: [...group.proxyIds] })),
    ),
    getGroup: (id) => run(() => {
      const group = groups.find((item) => item.id === id);
      return group ? { ...group, proxyIds: [...group.proxyIds] } : null;
    }),
    createGroup: (input) => run(async () => {
      const now = new Date().toISOString();
      const group = {
        id: randomUUID(),
        ...input,
        parentId: input?.parentId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      while (groups.some((item) => item.id === group.id)) group.id = randomUUID();
      // The candidate is validated as a whole tree, so a new parent link can
      // never introduce a loop, a fourth level or a provider mismatch.
      validateGroupTree([...groups, group]);
      const before = groups;
      const beforeTags = tags;
      groups = [...groups, group];
      if (group.mode === "tag" && group.tag) tags = withRegisteredTag(tags, group.tag);
      try {
        await writeAtomic();
      } catch (error) {
        groups = before;
        tags = beforeTags;
        throw error;
      }
      return { ...group, proxyIds: [...group.proxyIds] };
    }),
    updateGroup: (id, changes) => run(async () => {
      const index = groups.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const previous = groups[index];
      // Validate the merged record: switching to tag mode without a tag, or
      // clearing a name, is refused rather than stored half-applied.
      const fields = validateGroupCreate({ ...previous, ...changes });
      const next = {
        ...previous,
        ...fields,
        parentId: "parentId" in fields ? fields.parentId : groupParentId(previous),
        updatedAt: new Date().toISOString(),
      };
      const candidate = groups.map((group) => (group.id === id ? next : group));
      validateGroupTree(candidate);
      const before = groups;
      const beforeTags = tags;
      groups = candidate;
      if (next.mode === "tag" && next.tag) tags = withRegisteredTag(tags, next.tag);
      try {
        await writeAtomic();
      } catch (error) {
        groups = before;
        tags = beforeTags;
        throw error;
      }
      return { ...next, proxyIds: [...next.proxyIds] };
    }),
    removeGroup: (id) => run(async () => {
      const index = groups.findIndex((item) => item.id === id);
      if (index < 0) return null;
      // Deleting a parent would orphan its children's subtree, so the caller
      // is told to move or delete them first instead of silently flattening
      // the tree.
      if (groups.some((group) => groupParentId(group) === id)) {
        throw new ProxyInputError(
          "group_has_children",
          `Group "${groups[index].name}" still has child groups. Remove them first.`,
          409,
        );
      }
      const before = groups;
      const removed = groups[index];
      groups = groups.filter((item) => item.id !== id);
      try {
        await writeAtomic();
      } catch (error) {
        groups = before;
        throw error;
      }
      return { ...removed, proxyIds: [...removed.proxyIds] };
    }),
    listTags: () => run(() => tags.map((tag) => ({ ...tag }))),
    getTag: (name) => run(() => {
      const tag = tags.find((item) => item.name === name);
      return tag ? { ...tag } : null;
    }),
    createTag: (input) => run(async () => {
      const fields = validateTagCreate(input);
      const record = { name: fields.name, parent: fields.parent ?? null };
      const candidate = [...tags, record];
      // Duplicate names, cycles, missing parents and a fourth level are all
      // refused by validating the resulting tree.
      validateTagTree(candidate);
      const before = tags;
      tags = candidate;
      try {
        await writeAtomic();
      } catch (error) {
        tags = before;
        throw error;
      }
      return { ...record };
    }),
    updateTag: (name, changes) => run(async () => {
      const index = tags.findIndex((item) => item.name === name);
      if (index < 0) return null;
      const parent = "parent" in (changes ?? {}) ? changes.parent ?? null : tagParent(tags[index]);
      const record = { name, parent };
      const candidate = tags.map((tag, position) => (position === index ? record : tag));
      validateTagTree(candidate);
      const before = tags;
      tags = candidate;
      try {
        await writeAtomic();
      } catch (error) {
        tags = before;
        throw error;
      }
      return { ...record };
    }),
    removeTag: (name) => run(async () => {
      const index = tags.findIndex((item) => item.name === name);
      if (index < 0) return null;
      // A tag is still meaningful while a child tag, a proxy or a tag-mode
      // group names it; deleting it then would silently drop that selection.
      if (tags.some((tag) => tagParent(tag) === name)) {
        throw new ProxyInputError("tag_in_use", `Tag "${name}" still has child tags.`, 409);
      }
      if (records.some((record) => Array.isArray(record.tags) && record.tags.includes(name))) {
        throw new ProxyInputError("tag_in_use", `Tag "${name}" is still carried by a proxy.`, 409);
      }
      if (groups.some((group) => group.mode === "tag" && group.tag === name)) {
        throw new ProxyInputError("tag_in_use", `Tag "${name}" is still used by a proxy group.`, 409);
      }
      const before = tags;
      const removed = tags[index];
      tags = tags.filter((item) => item.name !== name);
      try {
        await writeAtomic();
      } catch (error) {
        tags = before;
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
