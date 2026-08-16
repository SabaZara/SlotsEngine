import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC authentication for service-to-service calls on the internal API.
 *
 * The reference architecture this engine is modelled on left its internal
 * routes completely unauthenticated, relying on Docker network isolation
 * alone: anything that could reach the money port could spin as any player
 * under any operator. That is one misconfigured network policy, one
 * sidecar, or one SSRF away from being the whole system's security. The
 * perimeter being well built does not make the interior safe — it only
 * makes the interior's weakness harder to notice.
 *
 * So every internal call is signed here, and `requireServiceAuth` refuses
 * to boot without a secret rather than defaulting to open. Network
 * isolation stays, as a second layer; it just stops being the only one.
 *
 * The canonical string binds method, path and body together:
 *
 *     `${timestamp}.${METHOD}.${path}.${rawBody}`
 *
 * Signing the path matters as much as signing the body — without it a
 * captured signature for one route could be replayed against another.
 */

export class ServiceAuthError extends Error {
  constructor(
    message: string,
    readonly reason: "missing_headers" | "clock_skew" | "bad_signature",
  ) {
    super(message);
    this.name = "ServiceAuthError";
  }
}

export const SERVICE_AUTH_HEADERS = {
  timestamp: "x-service-timestamp",
  signature: "x-service-signature",
  caller: "x-service-caller",
} as const;

/**
 * How far apart the two clocks may be. Narrow enough that a captured
 * signature is useless within a minute, wide enough to tolerate ordinary
 * container clock drift.
 */
export const MAX_CLOCK_SKEW_MS = 30_000;

function canonicalString(timestamp: string, method: string, path: string, rawBody: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${rawBody}`;
}

function computeSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

export interface SignedServiceRequest {
  [SERVICE_AUTH_HEADERS.timestamp]: string;
  [SERVICE_AUTH_HEADERS.signature]: string;
  [SERVICE_AUTH_HEADERS.caller]: string;
}

/** Builds the headers a calling service attaches to an internal request. */
export function signServiceRequest(input: {
  secret: string;
  caller: string;
  method: string;
  path: string;
  rawBody: string;
  timestamp?: number;
}): SignedServiceRequest {
  const timestamp = String(input.timestamp ?? Date.now());
  const signature = computeSignature(input.secret, canonicalString(timestamp, input.method, input.path, input.rawBody));
  return {
    [SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [SERVICE_AUTH_HEADERS.signature]: signature,
    [SERVICE_AUTH_HEADERS.caller]: input.caller,
  };
}

/**
 * Verifies an incoming internal request. Throws `ServiceAuthError` with a
 * specific reason for logging — but a caller must map every reason to the
 * same opaque 401, so a prober learns nothing about which check failed.
 */
export function verifyServiceRequest(input: {
  secret: string;
  method: string;
  path: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  now?: number;
}): { caller: string } {
  const header = (name: string): string | undefined => {
    const value = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  const timestamp = header(SERVICE_AUTH_HEADERS.timestamp);
  const signature = header(SERVICE_AUTH_HEADERS.signature);
  const caller = header(SERVICE_AUTH_HEADERS.caller);

  if (!timestamp || !signature || !caller) {
    throw new ServiceAuthError("missing service auth headers", "missing_headers");
  }

  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || Math.abs((input.now ?? Date.now()) - parsed) > MAX_CLOCK_SKEW_MS) {
    throw new ServiceAuthError("service request timestamp outside the accepted window", "clock_skew");
  }

  const expected = Buffer.from(
    computeSignature(input.secret, canonicalString(timestamp, input.method, input.path, input.rawBody)),
    "base64url",
  );
  const provided = Buffer.from(signature, "base64url");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new ServiceAuthError("bad service signature", "bad_signature");
  }

  return { caller };
}

/**
 * Loads the shared secret, refusing to start without one.
 *
 * This is the same posture the reference codebase used for its dev-only
 * bonus override: turn a configuration-discipline promise into a code
 * guarantee, so "we'll set it in production" cannot silently become "we
 * forgot". A service that boots with authentication disabled looks
 * perfectly healthy right up until it is exploited.
 */
export function loadServiceSecret(): string {
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SERVICE_AUTH_SECRET must be set to at least 32 characters — internal service calls are authenticated and this service will not start without it.",
    );
  }
  return secret;
}
