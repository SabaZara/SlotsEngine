import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Signed, short-lived token that hands a player off from an operator's
 * launch call to the socket's JOIN. Hand-rolled HMAC rather than a JWT
 * library: one fewer dependency, one less format for a reviewer to learn,
 * and the whole verification path fits on one screen.
 *
 * Issuer and verifier must share `LAUNCH_TOKEN_SECRET`. Verification is a
 * pure signature and expiry check with no I/O — single-use enforcement is
 * deliberately a separate concern, since it needs a database and this
 * package has none.
 *
 * Two kinds of token, same shape, different lifecycle:
 *   - `"launch"` — the one-shot handoff, 60s TTL, single-use. Short-lived
 *     because it travels in a URL, which leaks via referrer headers, proxy
 *     logs and browser history.
 *   - `"session"` — minted the moment a launch token is consumed, returned
 *     in the JOINED message. Longer TTL, reusable, so a dropped connection
 *     can reconnect without going back to the operator. Never in a URL.
 */
export interface LaunchTokenPayload {
  kind: "launch" | "session";
  operatorId: string;
  playerId: string;
  gameId: string;
  /** Unique per issued token — the single-use tracking key for a launch
   * token. Present but unused for a session token. */
  jti: string;
  /** Issued-at, ms epoch. */
  iat: number;
  /** Expiry, ms epoch. */
  exp: number;
}

/** A play session shouldn't outlive a reasonable single sitting. */
const SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const LAUNCH_TOKEN_TTL_MS = 60_000;

export class InvalidLaunchTokenError extends Error {}
export class ExpiredLaunchTokenError extends Error {}

function loadSecret(): string {
  const secret = process.env.LAUNCH_TOKEN_SECRET;
  if (!secret) {
    throw new Error("LAUNCH_TOKEN_SECRET is not set — required to sign and verify launch tokens.");
  }
  return secret;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export interface SignLaunchTokenInput {
  operatorId: string;
  playerId: string;
  gameId: string;
  ttlMs?: number;
}

export interface SignedLaunchToken {
  token: string;
  jti: string;
  expiresAt: number;
}

function signToken(kind: "launch" | "session", input: SignLaunchTokenInput, defaultTtlMs: number): SignedLaunchToken {
  const secret = loadSecret();
  const now = Date.now();
  const exp = now + (input.ttlMs ?? defaultTtlMs);
  const payload: LaunchTokenPayload = {
    kind,
    operatorId: input.operatorId,
    playerId: input.playerId,
    gameId: input.gameId,
    jti: randomUUID(),
    iat: now,
    exp,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token: `${payloadB64}.${sign(payloadB64, secret)}`, jti: payload.jti, expiresAt: exp };
}

export function signLaunchToken(input: SignLaunchTokenInput): SignedLaunchToken {
  return signToken("launch", input, LAUNCH_TOKEN_TTL_MS);
}

export function signSessionToken(input: SignLaunchTokenInput): SignedLaunchToken {
  return signToken("session", input, SESSION_TOKEN_TTL_MS);
}

/**
 * Verifies signature and expiry only — never single-use. Throws
 * `InvalidLaunchTokenError` for anything malformed or tampered with, and
 * `ExpiredLaunchTokenError` for a validly-signed but expired token, kept
 * distinct so a player can be told which of the two actually happened.
 */
export function verifyLaunchToken(token: string): LaunchTokenPayload {
  const secret = loadSecret();
  const parts = token.split(".");
  if (parts.length !== 2) throw new InvalidLaunchTokenError("malformed token");
  const [payloadB64, signature] = parts;

  const expectedSig = sign(payloadB64, secret);
  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = Buffer.from(expectedSig, "base64url");
    provided = Buffer.from(signature, "base64url");
  } catch {
    throw new InvalidLaunchTokenError("malformed signature");
  }
  // Length is compared first because timingSafeEqual throws on a mismatch;
  // the comparison itself stays constant-time, so a forged signature leaks
  // nothing about how close it was.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new InvalidLaunchTokenError("bad signature");
  }

  let payload: LaunchTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new InvalidLaunchTokenError("malformed payload");
  }
  if (
    (payload.kind !== "launch" && payload.kind !== "session") ||
    typeof payload.operatorId !== "string" ||
    typeof payload.playerId !== "string" ||
    typeof payload.gameId !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new InvalidLaunchTokenError("malformed payload fields");
  }
  if (Date.now() > payload.exp) {
    throw new ExpiredLaunchTokenError("token expired");
  }
  return payload;
}
