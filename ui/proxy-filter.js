// Pure client-side filtering for the Proxy IPs table. The page keeps the
// filter state in memory (the magpie page frame is an opaque origin, so
// localStorage is not available) and only calls these helpers while rendering;
// no filter ever sends a request.
//
// A proxy's `region` may be an empty string when the connection has never been
// tested. The empty string is a real key here, so "untested" can be selected
// on its own instead of being folded into "all regions".

export const UNTESTED_REGION = "";

export function regionKey(proxy = {}) {
  return typeof proxy?.region === "string" ? proxy.region.trim() : "";
}

// Distinct regions in a stable order: named regions alphabetically, the
// untested/empty region last so it never looks like a normal country.
export function distinctRegions(proxies = []) {
  const counts = new Map();
  for (const proxy of Array.isArray(proxies) ? proxies : []) {
    if (!proxy) continue;
    const key = regionKey(proxy);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => {
      if (a.region === UNTESTED_REGION && b.region !== UNTESTED_REGION) return 1;
      if (b.region === UNTESTED_REGION && a.region !== UNTESTED_REGION) return -1;
      if (a.region === b.region) return 0;
      return a.region < b.region ? -1 : 1;
    });
}

// A latency input is a bound only when it is a finite number. An empty string
// (the normal empty input value) means "no bound"; a nonsense string is
// ignored rather than treated as 0.
export function latencyBound(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const EMPTY_SELECTION = new Set();

function selectionOf(regions) {
  if (regions instanceof Set) return regions;
  if (Array.isArray(regions)) return new Set(regions);
  return EMPTY_SELECTION;
}

export function filterProxies(
  proxies = [],
  { regions = [], minLatency = null, maxLatency = null } = {},
) {
  const selected = selectionOf(regions);
  const min = latencyBound(minLatency);
  const max = latencyBound(maxLatency);
  const latencyFilter = min !== null || max !== null;
  return (Array.isArray(proxies) ? proxies : []).filter((proxy) => {
    if (!proxy) return false;
    if (selected.size > 0 && !selected.has(regionKey(proxy))) return false;
    if (latencyFilter) {
      // Only real numeric latencies participate. With a bound set, a row whose
      // latency is null/unknown is excluded rather than passing as 0.
      if (typeof proxy.latency !== "number" || !Number.isFinite(proxy.latency)) return false;
      if (min !== null && proxy.latency < min) return false;
      if (max !== null && proxy.latency > max) return false;
    }
    return true;
  });
}