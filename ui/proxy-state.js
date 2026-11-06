// Small pure helpers used by the page. Keeping them out of app.js lets the
// tests exercise confirmation and stale-result behaviour without a DOM.

export function normalizeProxyForm(values = {}) {
  return {
    name: String(values.name ?? "").trim(),
    type: String(values.type ?? "").toLowerCase(),
    host: String(values.host ?? "").trim(),
    port: String(values.port ?? "").trim(),
    username: String(values.username ?? "").trim(),
    password: String(values.password ?? ""),
  };
}

// Only connection fields matter when deciding whether a test result still
// describes the values that will be saved.
export function proxyFingerprint(values = {}) {
  const form = normalizeProxyForm(values);
  return JSON.stringify([form.type, form.host, form.port, form.username, form.password]);
}

export function formatAddress(proxy = {}) {
  const host = String(proxy.host ?? "");
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${shown}:${proxy.port ?? ""}`;
}

export function statusView(proxy = {}, labels = {}, testing = false) {
  if (testing) {
    return { state: "testing", label: labels.statusTesting || "Testing…", detail: "" };
  }
  if (proxy.status === "ok") {
    return {
      state: "ok",
      label: labels.statusOk || "Available",
      detail: Number.isFinite(proxy.latency) ? `${proxy.latency} ms` : "",
    };
  }
  if (proxy.status === "error") {
    return {
      state: "error",
      label: labels.statusError || "Failed",
      detail: proxy.error || "",
    };
  }
  return { state: "untested", label: labels.statusUntested || "Never tested", detail: "" };
}

// A guard for async work tied to a dialog or row. cancel() invalidates every
// token handed out before it, so a late response cannot touch newer state.
export function createRequestGuard() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    cancel() {
      current += 1;
    },
    isCurrent(token) {
      return token === current;
    },
  };
}

// Delete is a two-step action: ask() only remembers the row. A cancelled
// dialog clears it without touching data; take() is the only way to obtain a
// target for the actual DELETE request.
export function createConfirmController() {
  let pending = null;
  return {
    ask(id, name) {
      pending = { id: String(id), name: String(name ?? "") };
      return { ...pending };
    },
    cancel() {
      const previous = pending;
      pending = null;
      return previous;
    },
    peek() {
      return pending ? { ...pending } : null;
    },
    take(id) {
      if (!pending || pending.id !== String(id)) return null;
      const target = pending;
      pending = null;
      return target;
    },
  };
}
