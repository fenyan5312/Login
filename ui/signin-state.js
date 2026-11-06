// Pure helpers for the provider sign-in dialog. Keeping them out of app.js
// lets the tests pin the request shape and the "is a flow still running?"
// decision without a DOM or a running service.

import { signInAccount } from "./account-state.js";

// The proxy value sent to `POST /api/signin`. It deliberately carries only the
// public proxy fields; the stored password never leaves the service. The
// service resolves the record by `id` and fills in the credential itself. A
// null/blank selection means "no proxy (direct)".
export function signInProxy(proxy) {
  if (!proxy || typeof proxy !== "object" || typeof proxy.id !== "string" || !proxy.id) {
    return null;
  }
  return {
    id: proxy.id,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || "",
  };
}

// The exact label of the method the user picked, when the plugin exposes
// several (ZCode's per-site oauth methods). The service looks the method up
// by this label, so it must match exactly; an empty selection means "let the
// service choose".
export function signInMethodLabel(label) {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed ? trimmed : null;
}

export function signInPayload(provider, proxy, methodLabel = null, account = null, groupId = null) {
  const payload = { provider: String(provider || ""), proxy: signInProxy(proxy) };
  const label = signInMethodLabel(methodLabel);
  if (label) payload.methodLabel = label;
  // An existing identity to continue. Only the account key travels; the
  // service looks the directory up and verifies its ledger.
  const claim = signInAccount(account);
  if (claim) payload.account = claim;
  // The IP group whose per-IP rule allocates the exit. A non-empty proxy above
  // still wins, but it must be a member of this group.
  if (typeof groupId === "string" && groupId.trim()) payload.groupId = groupId.trim();
  return payload;
}

// A flow is still running until it reaches one of the terminal states. Used to
// decide whether closing the dialog must cancel the flow first.
export function signInActive(state) {
  return state === "authorizing" || state === "waiting-login" || state === "finishing";
}

// The terminal states the UI must stop polling on.
export function signInSettled(state) {
  return state === "done" || state === "error" || state === "cancelled";
}
