// A guard for the token-expiry auto-reload in app.js.
//
// A module variable resets on every page reload, so it cannot count reloads
// across documents; a still-mismatched token would then reload forever. The
// guard keeps the count in the page URL instead: the first reload adds a
// marker, and a document that already carries the marker never auto-reloads
// again, so it falls through to the normal error path. The module also caps
// the current document at one automatic reload. Kept DOM-free so it can be
// tested without a browser.

export const RELOAD_MARKER = "clean_login_reloaded";
export const RELOAD_MARKER_VALUE = "1";

export function createReloadGuard({ location, history } = {}) {
  let attempted = false;

  function hasMarker() {
    if (!location) return false;
    try {
      const search = String(location.search || "");
      return new URLSearchParams(search).get(RELOAD_MARKER) === RELOAD_MARKER_VALUE;
    } catch {
      return false;
    }
  }

  // The marker only ever suppresses another automatic reload. A successful
  // load removes it so the next genuine token expiry can reload again; the
  // launcher's theme/lang and the provider hash are left untouched.
  function clearMarker() {
    if (!location || !history) return;
    try {
      const url = new URL(location.href);
      if (url.searchParams.get(RELOAD_MARKER) !== RELOAD_MARKER_VALUE) return;
      url.searchParams.delete(RELOAD_MARKER);
      history.replaceState(history.state, "", url.href);
    } catch {
      // A sandboxed frame may not expose history; a leftover marker stays
      // harmless because it only suppresses another automatic reload.
    }
  }

  // Returns true when it navigated away. The caller must then stop: the
  // document is about to be replaced. Returns false when the reload is
  // suppressed (already attempted here, or the marker is present), so the
  // caller can show the real error instead.
  function reloadOnce() {
    if (attempted || hasMarker()) return false;
    if (!location || typeof location.replace !== "function") return false;
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return false;
    }
    attempted = true;
    url.searchParams.set(RELOAD_MARKER, RELOAD_MARKER_VALUE);
    location.replace(url.href);
    return true;
  }

  return { hasMarker, clearMarker, reloadOnce };
}
