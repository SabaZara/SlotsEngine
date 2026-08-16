import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CLOCK_SKEW_MS,
  SERVICE_AUTH_HEADERS,
  ServiceAuthError,
  loadServiceSecret,
  signServiceRequest,
  verifyServiceRequest,
} from "./index.js";

const SECRET = "an-internal-service-secret-long-enough-to-pass";
const BODY = JSON.stringify({ operatorId: "op-1", playerId: "p-1", totalBet: 100 });

function signed(overrides: Partial<{ method: string; path: string; rawBody: string; timestamp: number }> = {}) {
  return signServiceRequest({
    secret: SECRET,
    caller: "game-socket",
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/internal/rounds/spin",
    rawBody: overrides.rawBody ?? BODY,
    ...(overrides.timestamp !== undefined ? { timestamp: overrides.timestamp } : {}),
  });
}

function verify(headers: Record<string, string | undefined>, overrides: Partial<{ method: string; path: string; rawBody: string }> = {}) {
  return verifyServiceRequest({
    secret: SECRET,
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/internal/rounds/spin",
    rawBody: overrides.rawBody ?? BODY,
    headers,
  });
}

describe("service auth", () => {
  it("accepts a correctly signed request and reports the caller", () => {
    assert.equal(verify(signed()).caller, "game-socket");
  });

  it("rejects a request with no signature at all", () => {
    // This is the case the reference architecture allowed everywhere on its
    // internal API: anything that could reach the port could spin as anyone.
    assert.throws(() => verify({}), (err: ServiceAuthError) => err.reason === "missing_headers");
  });

  it("rejects a tampered body — the amount cannot be rewritten in flight", () => {
    const headers = signed();
    assert.throws(
      () => verify(headers, { rawBody: JSON.stringify({ operatorId: "op-1", playerId: "p-1", totalBet: 999999 }) }),
      (err: ServiceAuthError) => err.reason === "bad_signature",
    );
  });

  it("rejects a signature replayed against a different route", () => {
    // The path is inside the signed string precisely so a captured
    // signature for one endpoint is worthless against another.
    const headers = signed({ path: "/internal/players/balance" });
    assert.throws(() => verify(headers, { path: "/internal/rounds/spin" }), (err: ServiceAuthError) => err.reason === "bad_signature");
  });

  it("rejects a signature replayed with a different method", () => {
    const headers = signed({ method: "GET" });
    assert.throws(() => verify(headers, { method: "POST" }), (err: ServiceAuthError) => err.reason === "bad_signature");
  });

  it("rejects a stale timestamp, limiting the replay window", () => {
    const headers = signed({ timestamp: Date.now() - MAX_CLOCK_SKEW_MS - 1000 });
    assert.throws(() => verify(headers), (err: ServiceAuthError) => err.reason === "clock_skew");
  });

  it("rejects a timestamp from the future", () => {
    const headers = signed({ timestamp: Date.now() + MAX_CLOCK_SKEW_MS + 1000 });
    assert.throws(() => verify(headers), (err: ServiceAuthError) => err.reason === "clock_skew");
  });

  it("tolerates ordinary clock drift within the window", () => {
    assert.equal(verify(signed({ timestamp: Date.now() - 5000 })).caller, "game-socket");
  });

  it("rejects a signature made with a different secret", () => {
    const headers = signServiceRequest({
      secret: "some-other-secret-entirely-that-is-long-enough",
      caller: "game-socket",
      method: "POST",
      path: "/internal/rounds/spin",
      rawBody: BODY,
    });
    assert.throws(() => verify(headers), (err: ServiceAuthError) => err.reason === "bad_signature");
  });

  it("rejects a garbage signature without throwing something unexpected", () => {
    const headers = { ...signed(), [SERVICE_AUTH_HEADERS.signature]: "!!!not-base64!!!" };
    assert.throws(() => verify(headers), ServiceAuthError);
  });

  it("handles header arrays, as a proxy may produce", () => {
    const headers = signed();
    const result = verifyServiceRequest({
      secret: SECRET,
      method: "POST",
      path: "/internal/rounds/spin",
      rawBody: BODY,
      headers: {
        [SERVICE_AUTH_HEADERS.timestamp]: [headers[SERVICE_AUTH_HEADERS.timestamp]],
        [SERVICE_AUTH_HEADERS.signature]: [headers[SERVICE_AUTH_HEADERS.signature]],
        [SERVICE_AUTH_HEADERS.caller]: [headers[SERVICE_AUTH_HEADERS.caller]],
      },
    });
    assert.equal(result.caller, "game-socket");
  });
});

describe("loadServiceSecret", () => {
  it("refuses to start without a secret, rather than defaulting to open", () => {
    const saved = process.env.SERVICE_AUTH_SECRET;
    delete process.env.SERVICE_AUTH_SECRET;
    try {
      assert.throws(() => loadServiceSecret(), /SERVICE_AUTH_SECRET must be set/);
    } finally {
      if (saved !== undefined) process.env.SERVICE_AUTH_SECRET = saved;
    }
  });

  it("refuses a trivially short secret", () => {
    const saved = process.env.SERVICE_AUTH_SECRET;
    process.env.SERVICE_AUTH_SECRET = "short";
    try {
      assert.throws(() => loadServiceSecret(), /at least 32 characters/);
    } finally {
      if (saved === undefined) delete process.env.SERVICE_AUTH_SECRET;
      else process.env.SERVICE_AUTH_SECRET = saved;
    }
  });
});
