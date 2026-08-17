/**
 * Storage keys, and the rule that stops a signed URL being stored as one.
 *
 * **This file exists because of a bug the reference repo shipped to
 * production, and it is worth stating in full before anything else here
 * makes sense.**
 *
 * Their design — and now ours — stores a *key* in the game document and
 * mints a short-lived signed URL at serve time. That means the shape a
 * client **reads** differs from the shape the server **stores**, and their
 * draft-update route did not know it: `updateDraft` blindly `$set` the
 * client-supplied `assets` object, so every "Save draft" wrote the signed
 * URL the client had been shown back over the raw key. The corruption
 * compounded, because the next read signed the already-corrupted value —
 * producing keys like `http://host/bucket/http%3A%2F%2Fhost%2Fbucket%2F…`
 * nested several levels deep. They needed a repair script with a recursive
 * unwinder to get the data back.
 *
 * Two things follow, and both are load-bearing:
 *
 *  1. **The draft write path must never accept `assets` at all.** Only the
 *     dedicated upload and clear routes may touch it. That is enforced in
 *     `drafts.ts`, not here.
 *  2. **A key must be recognisably not-a-URL**, so that if rule 1 is ever
 *     bypassed the value is refused rather than stored. That is this file.
 *
 * The second is defence in depth for the first. The reference had neither.
 */

/**
 * Where an asset lives, relative to the bucket.
 *
 * Shaped `games/<gameId>/<slot>/<random>.<ext>` — game first so a game's
 * assets are listable and deletable as a unit, and a random component
 * because two uploads to the same slot must not collide. The original
 * filename is deliberately **not** used: it is attacker-controlled, may
 * contain path separators, and carries no information the system needs.
 */
export function buildAssetKey(gameId: string, slot: string, extension: string, random: string): string {
  const safeGame = sanitizeSegment(gameId);
  const safeSlot = sanitizeSegment(slot);
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const safeRandom = sanitizeSegment(random);
  return `games/${safeGame}/${safeSlot}/${safeRandom}${safeExt ? `.${safeExt}` : ""}`;
}

/**
 * One path segment, with everything that could escape it removed.
 *
 * `..` and `/` are the obvious hazards — a key is a path, and a caller who
 * can write `../` can write outside the prefix this scheme relies on for
 * per-game isolation. Everything outside a conservative allowlist is
 * replaced rather than rejected, because these values come from a gameId a
 * designer chose and refusing one would make a legitimate game
 * un-uploadable.
 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
}

/**
 * Whether a stored value is a storage key rather than a URL.
 *
 * **The guard against the reference's compounding corruption.** A signed
 * URL written back into the document is the failure; refusing anything
 * URL-shaped at the boundary means one bad write is rejected instead of
 * being re-signed on the next read and nested one level deeper.
 *
 * Deliberately strict about what a key looks like rather than clever about
 * detecting URLs. "Not starting with http" would pass `//evil.example/x`,
 * which a browser treats as protocol-relative and fetches; an allowlist of
 * key-shaped characters cannot.
 */
export function isStorageKey(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;

  /*
   * The allowlist below does most of the work, and measuring which checks
   * are load-bearing is worth recording — mutation testing found two of
   * the original guards to be equivalent mutants, and keeping them without
   * saying so would imply a defence that is not there.
   *
   * The allowlist alone already refuses every scheme (`:` is not in the
   * set), every query and fragment (`?` and `#` are not either), and all
   * whitespace. What it accepts and must not:
   *
   *   /etc/passwd            — an absolute path
   *   //evil.example/x.png   — protocol-relative, which a browser fetches
   *   games/../x             — traversal out of the game's prefix
   *
   * Two checks cover all three, because a leading-slash test catches the
   * protocol-relative case as well. An explicit `startsWith("//")` was
   * written first and removed: mutation testing showed it could be deleted
   * with every test still passing, which means it was defending nothing
   * that the line below does not already defend.
   */
  if (value.startsWith("/")) return false;
  if (value.includes("..")) return false;

  return /^[a-zA-Z0-9._\-/]+$/.test(value);
}

/**
 * Which upload slots exist, and what each one sets.
 *
 * Enumerated rather than free-form so an upload cannot write to an
 * arbitrary field of `assets`. A slot names a destination the server
 * already understands; a client that could name its own would be choosing
 * where in the document to write, which is the same class of problem as
 * accepting `assets` wholesale.
 */
export const UPLOAD_SLOTS = ["background", "music", "spinSound", "symbol"] as const;

export type UploadSlot = (typeof UPLOAD_SLOTS)[number];

export function isUploadSlot(value: unknown): value is UploadSlot {
  return typeof value === "string" && (UPLOAD_SLOTS as readonly string[]).includes(value);
}

/**
 * What each slot may contain, as MIME types.
 *
 * Checked server-side against the *declared* content type, which is a
 * claim rather than a fact — a caller can lie. That is acceptable here
 * because the stored object is only ever served back as a download and
 * never executed, and because the alternative (sniffing magic bytes) buys
 * little against a designer-facing endpoint behind authentication. What it
 * does prevent is the ordinary mistake: a designer uploading a PDF into a
 * symbol slot and seeing a blank reel.
 */
export const ALLOWED_CONTENT_TYPES: Record<UploadSlot, readonly string[]> = {
  background: ["image/png", "image/jpeg", "image/webp", "image/avif"],
  symbol: ["image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml"],
  music: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
  spinSound: ["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"],
};

/** The extension to store under, derived from the content type rather than
 * from the uploaded filename — which is attacker-controlled and may not
 * match what was actually sent. */
export const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "weba",
};

export function isAllowedForSlot(slot: UploadSlot, contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES[slot].includes(contentType.split(";")[0].trim().toLowerCase());
}
