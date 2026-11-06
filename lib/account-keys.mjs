// Account-key allocation, mirroring magpie's own `freshKey`/`providerOf`
// pair. This file only decides which key a new sign-in gets; it does not
// sign in, store credentials or touch an auth file's contents.
//
// magpie's convention, from the same source comment as `freshKey`:
// "the first account is kept under the provider's id, the others under
// id#<slot>".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { magpieConfigDir } from "./paths.mjs";

// magpie's `providerOf`: the part before the first `#`, so `workbuddy-ai` and
// `workbuddy#slot` stay distinct providers.
export function providerOf(key) {
  return key.split("#")[0];
}

// magpie's loop is unbounded: with a real random source a collision is
// astronomically unlikely, so an unproductive generator would spin forever.
// This bound is the only deliberate difference from magpie; it turns a broken
// random source into an error instead of a hang. It is high enough that a real
// auth file never reaches it.
const MAX_ATTEMPTS = 1000;

export function freshAccountKey(provider, existingKeys, random = Math.random) {
  const existing = existingKeys instanceof Set ? existingKeys : new Set(existingKeys ?? []);
  if (!existing.has(provider)) return provider;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Same construction as magpie, including `slice(2, 8)`:
    // `Math.random().toString(36)` can be shorter than six fractional digits
    // (e.g. 0.5 -> "0.i"), and magpie keeps that short suffix. Do not "fix"
    // it to a fixed width.
    const key = provider + "#" + random().toString(36).slice(2, 8);
    if (!existing.has(key)) return key;
  }
  throw new Error(
    `freshAccountKey: no free key for "${provider}" after ${MAX_ATTEMPTS} attempts`,
  );
}

// Reads only the key names of magpie's `plugin-auth.json`, reusing
// `magpieConfigDir` for the path. Any failure (missing file, unreadable,
// malformed JSON) yields an empty set and never throws.
//
// Only key names are ever taken: after `JSON.parse` we immediately call
// `Object.keys` and never index the parsed object for a value. Do not add a
// code path that reads or returns a value here.
//
// This is the tolerant reader for key *allocation* (lib/signin-flow.mjs): a
// missing auth file simply means the provider's bare key is free. The orphan
// sweep needs the opposite default, so it uses `readAuthKeysResult` below.
export function readAuthKeys(env = process.env) {
  const result = readAuthKeysResult(env);
  return result.ok ? result.keys : new Set();
}

// The same read, but it never collapses a failure into an empty key set. The
// orphan sweep must tell "this auth file legitimately has no keys" from "the
// key set could not be read at all", because the two mean opposite things for
// a directory with no credential:
//
//   * a readable file whose JSON is an object (including `{}`) is
//     `{ ok: true, keys }` -- an empty object is a valid empty key set, so
//     orphan reclamation must proceed;
//   * a missing file is `{ ok: false, reason: "auth_missing" }` and is NOT an
//     empty set: the file disappearing is itself an abnormal state, and
//     guessing "no keys" would wipe every directory;
//   * a read failure (permissions, EISDIR, IO) is `{ ok: false, reason:
//     "auth_unreadable" };
//   * malformed JSON, or JSON that is not an object, is `{ ok: false, reason:
//     "auth_invalid" }`.
//
// Only key names are read, exactly as in `readAuthKeys`.
export function readAuthKeysResult(env = process.env) {
  let text;
  try {
    text = readFileSync(join(magpieConfigDir(env), "plugin-auth.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "auth_missing" };
    return { ok: false, reason: "auth_unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "auth_invalid" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "auth_invalid" };
  }
  return { ok: true, keys: new Set(Object.keys(parsed)) };
}
