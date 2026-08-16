import { createHmac, timingSafeEqual } from "node:crypto";
import type { RoleId } from "@slots-engine/shared-types";

/**
 * Admin session tokens.
 *
 * Hand-rolled HMAC in the same format the launch tokens use, rather than a
 * JWT library — one fewer dependency, and the entire verification path fits
 * on one screen where a reviewer can check it. The format is deliberately
 * NOT interchangeable with a launch token: `verifySession` only accepts its
 * own payload shape, so an admin token and a player token can never be
 * confused for one another even if the secrets were ever misconfigured to
 * match.
 */
export interface SessionPayload {
  userId: string;
  email: string;
  roles: RoleId[];
  /** Snapshot of the user's `tokenVersion` at issue time. A mismatch
   * against the current value means this token has been revoked. */
  tokenVersion: number;
  iat: number;
  exp: number;
}

/** A single working day. Long enough not to interrupt a designer, short
 * enough that a forgotten open laptop stops being useful overnight. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function loadSecret(): string {
  const secret = process.env.BACKOFFICE_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BACKOFFICE_JWT_SECRET must be set to at least 32 characters — admin sessions are signed with it.");
  }
  return secret;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function signSession(input: { userId: string; email: string; roles: RoleId[]; tokenVersion: number }): {
  token: string;
  expiresAt: number;
} {
  const secret = loadSecret();
  const now = Date.now();
  const payload: SessionPayload = { ...input, iat: now, exp: now + SESSION_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token: `${payloadB64}.${sign(payloadB64, secret)}`, expiresAt: payload.exp };
}

/**
 * Returns the payload, or `null` for anything wrong — malformed, tampered,
 * expired. A single null rather than distinct errors is deliberate here:
 * unlike a player launch token, where "expired" is worth explaining, an
 * admin surface should tell an unauthenticated caller as little as
 * possible about why they failed.
 */
export function verifySession(token: string): SessionPayload | null {
  let secret: string;
  try {
    secret = loadSecret();
  } catch {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = Buffer.from(sign(payloadB64, secret), "base64url");
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  // Deliberately `unknown` rather than `SessionPayload`: the value came off
  // the wire, and annotating it as the type we hope for is how a cast gets
  // mistaken for a check. The compiler now refuses to let anything read a
  // field until the guards below have actually established the shape.
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  // `JSON.parse` happily returns null, a number, a string or an array, and
  // every one of those is a valid JSON document. Without this line, a
  // payload of literal `null` reached the field checks below and threw a
  // TypeError on `payload.userId` — which the middleware does not catch, so
  // a *correctly signed* junk token produced a 500 instead of a 401.
  //
  // Signed junk is reachable by anyone who can obtain any token from this
  // service, and the wrong status code is the smaller half: a verifier
  // whose failure mode is "throw" fails open in whatever code path forgets
  // to catch it. Refuse anything that is not an object, first.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const claims = payload as Record<string, unknown>;

  if (
    typeof claims.userId !== "string" ||
    typeof claims.email !== "string" ||
    !Array.isArray(claims.roles) ||
    typeof claims.tokenVersion !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (Date.now() > claims.exp) return null;

  return payload as SessionPayload;
}
