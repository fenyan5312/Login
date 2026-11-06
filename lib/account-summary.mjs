// Read-only fingerprint summary for the accounts page.
//
// The page needs a short, stable id for the pinned `identity.json` and the time
// it was pinned. It must never see the identity object itself (hundreds of
// thousands of bytes of fingerprint detail) or the directory it lives in. The
// id is therefore a digest of the file's bytes, not a field inside it.

import { createHash } from "node:crypto";
import { readFile as defaultReadFile, stat as defaultStat } from "node:fs/promises";
import { join } from "node:path";

const IDENTITY_FILE = "identity.json";

export async function readFingerprintSummary(
  dir,
  { readFile = defaultReadFile, stat = defaultStat } = {},
) {
  const empty = { id: null, pinnedAt: null };
  if (!dir || typeof dir !== "string") return empty;
  const file = join(dir, IDENTITY_FILE);

  let bytes;
  try {
    const raw = await readFile(file);
    bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
    if (!bytes.length) return empty;
    // A truncated/hand-edited pin is not a pin the page should name. Reading
    // it as JSON is the same validity rule the rest of the package uses.
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  } catch {
    return empty;
  }

  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const id = `${hex.slice(0, 4)}·${hex.slice(4)}`;
  let pinnedAt = null;
  try {
    const info = await stat(file);
    if (typeof info?.mtime?.toISOString === "function") pinnedAt = info.mtime.toISOString();
  } catch {
    // A stat failure leaves `pinnedAt` unknown but does not erase a valid id.
  }
  return { id, pinnedAt };
}
