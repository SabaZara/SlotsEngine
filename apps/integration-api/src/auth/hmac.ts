import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing for the operator-facing API.
 *
 * Deliberately the same shape as `@slots-engine/service-auth` rather than a
 * shared implementation, and the duplication is the point: that package
 * authenticates *our own services* to each other with one process-wide
 * secret, this one authenticates *external customers* with a per-operator
 * secret. Merging them would mean one secret change, or one bug, crossing a
 * trust boundary it has no business crossing. They are two policies that
 * happen to use the same primitive.
 */

/**
 * The canonical string every signature covers.
 *
 * All four parts are load-bearing:
 *
 * - **timestamp** binds the signature to a moment, which is what makes the
 *   skew window enforceable.
 * - **method** stops a signed GET being replayed as a POST to the same URL.
 * - **url**, including the query string, is why tampering with
 *   `?playerId=` invalidates the signature. Signing only the body would
 *   leave every GET route — balance and transactions, both of which read
 *   another operator's data if the query is swapped — completely unprotected,
 *   since they have no body at all.
 * - **rawBody** must be the exact bytes received, never a re-serialisation
 *   of the parsed object: `JSON.parse` followed by `JSON.stringify` is not
 *   the identity function (key order, whitespace, number formatting), so a
 *   re-serialised body produces a different signature for a request the
 *   operator signed correctly.
 *
 * The separator is `.` and the parts are never length-prefixed. That is
 * safe here only because the first three fields cannot contain a `.` in a
 * way that shifts a boundary — timestamp is digits, method is alphabetic,
 * and while a URL can contain dots, it is the *third* field and the body is
 * the remainder, so no split is performed on the verifying side. Nothing
 * parses this string; it is only ever recomputed and compared whole.
 */
export function canonicalRequest(timestamp: string, method: string, url: string, rawBody: string): string {
  return `${timestamp}.${method.toUpperCase()}.${url}.${rawBody}`;
}

export function computeSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Constant-time comparison.
 *
 * A `===` on two hex strings returns as soon as it finds a differing
 * character, so the time it takes leaks how long a shared prefix is. That
 * turns forging a signature from 2^256 guesses into roughly 64 x 16 —
 * guess one character at a time, keep whichever is measurably slower. The
 * comparison is on the decoded bytes rather than the hex text, which halves
 * the number of positions an attacker gets feedback on.
 */
export function verifySignature(secret: string, canonical: string, providedHex: string): boolean {
  // `Buffer.from(…, "hex")` truncates at the first non-hex character rather
  // than throwing, so a provided signature of "zz" decodes to an empty
  // buffer. Without this check that would reach the length comparison as a
  // 0-length buffer and be refused correctly — but only by accident, and a
  // future edit to the length handling would silently turn it into a
  // bypass. Refused explicitly instead.
  if (!/^[0-9a-fA-F]*$/.test(providedHex)) return false;

  const expected = Buffer.from(computeSignature(secret, canonical), "hex");
  const provided = Buffer.from(providedHex, "hex");

  // `timingSafeEqual` throws on a length mismatch instead of returning
  // false. The length of a signature is not secret — it is fixed by the
  // algorithm — so comparing it first leaks nothing.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
