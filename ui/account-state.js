// Pure helpers for the account identities. Keeping them out of app.js lets
// the tests pin the request shape and the "which identity is offered?"
// decision without a DOM.
//
// An "identity" is one account directory with its pinned fingerprint. magpie
// deletes the credential when an account signs out, but the directory (and
// therefore the fingerprint) is kept: one credential must always present the
// same machine. These helpers describe those kept identities; they never
// touch the pin itself.

// The name shown for one identity. The account's own name first, then its
// stable uid, then the account key. The pinned fingerprint is never part of
// it: the page has no business showing a fingerprint.
export function accountLabel(account) {
  const value = account && typeof account === "object" ? account : {};
  const name = typeof value.accountId === "string" ? value.accountId.trim() : "";
  if (name) return name;
  const uid = typeof value.uid === "string" ? value.uid.trim() : "";
  if (uid) return uid;
  return String(value.key ?? "");
}

// The identities of one provider that are not signed in any more. Their
// directory is kept, so signing in again reuses the same fingerprint instead
// of drawing a new one.
export function retiredAccounts(accounts, provider) {
  return (Array.isArray(accounts) ? accounts : []).filter(
    (account) => account?.provider === provider && account?.signedIn !== true,
  );
}

// The identity the sign-in dialog pre-selects: the only one, when the
// provider has exactly one retired identity. With several, the choice stays
// with the user.
export function defaultAccountKey(accounts, provider) {
  const retired = retiredAccounts(accounts, provider);
  return retired.length === 1 ? String(retired[0].key ?? "") : "";
}

// The request body for a sign-in that continues an existing identity. The
// page sends the exact account key it listed; the service verifies the
// directory's ledger before reusing its fingerprint.
export function signInAccount(key) {
  const value = typeof key === "string" ? key.trim() : "";
  return value ? { key: value } : null;
}

// The DELETE path for one identity. Both segments are URL-encoded: a magpie
// account key looks like `workbuddy#ab12`, and `#` must not start a fragment.
export function accountIdentityPath(provider, key) {
  return `api/accounts/${encodeURIComponent(String(provider ?? ""))}/${encodeURIComponent(
    String(key ?? ""),
  )}`;
}

// The row shown for one identity: the account's own name, its uid and when it
// was last signed in. The accounts page also needs the provider, key and
// current sign-in state; still no fingerprint, no path, no credential.
export function accountIdentityView(account) {
  const value = account && typeof account === "object" ? account : {};
  return {
    label: accountLabel(value),
    uid: typeof value.uid === "string" && value.uid ? value.uid : "",
    retiredAt: typeof value.signedInAt === "string" ? value.signedInAt : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    key: String(value.key ?? ""),
    signedIn: Boolean(value.signedIn),
    note: typeof value.note === "string" ? value.note : "",
    lastLogin: value.lastLogin && typeof value.lastLogin === "object" ? value.lastLogin : null,
    lastCheck: value.lastCheck && typeof value.lastCheck === "object" ? value.lastCheck : null,
  };
}

// The check endpoint for one account. Both segments are URL-encoded by
// accountIdentityPath; the service owns the job behind `/check`.
export function accountCheckPath(provider, key) {
  return `${accountIdentityPath(provider, key)}/check`;
}

// Cancelling a running check is a distinct POST; failure/cancel writes no
// history, so the previous verdict stays untouched.
export function accountCheckCancelPath(provider, key) {
  return `${accountCheckPath(provider, key)}/cancel`;
}
