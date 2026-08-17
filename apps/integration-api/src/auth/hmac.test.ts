import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalRequest, computeSignature, verifySignature } from "./hmac.js";

/**
 * What these tests cannot establish:
 *
 *   - **They do not establish that the comparison is actually constant
 *     time.** `timingSafeEqual` is Node's, and measuring timing in a test
 *     would be flaky on shared CI hardware and prove little on a machine
 *     with a JIT. What is tested is that the constant-time path is the one
 *     taken, and that a length mismatch returns false rather than throwing.
 *   - **They do not establish that HMAC-SHA256 is sound.** That is
 *     `node:crypto`.
 *   - **A correct canonical string here does not mean the *server* builds
 *     the same one.** That is the app suite's job, which signs a request
 *     the way an operator would and lets the real hook verify it.
 */

const SECRET = "operator-shared-secret";

describe("canonicalRequest", () => {
  it("covers timestamp, method, url and body, so tampering with any of them breaks the signature", () => {
    const base = canonicalRequest("1700000000000", "POST", "/v1/wallet/cash-in", '{"amount":100}');

    // Each of these is a request an attacker might substitute for the
    // signed one. Every substitution must produce a different canonical
    // string, or the signature would still verify against it.
    assert.notEqual(base, canonicalRequest("1700000000001", "POST", "/v1/wallet/cash-in", '{"amount":100}'));
    assert.notEqual(base, canonicalRequest("1700000000000", "GET", "/v1/wallet/cash-in", '{"amount":100}'));
    assert.notEqual(base, canonicalRequest("1700000000000", "POST", "/v1/wallet/cash-out", '{"amount":100}'));
    assert.notEqual(base, canonicalRequest("1700000000000", "POST", "/v1/wallet/cash-in", '{"amount":999}'));
  });

  it("includes the query string, which is the only protection a GET route has", () => {
    // `/v1/wallet/balance` has no body. If the canonical string omitted the
    // query, every balance request by one operator would carry a signature
    // valid for *any* playerId — swap the query, keep the headers, read
    // someone else's balance.
    const mine = canonicalRequest("1700000000000", "GET", "/v1/wallet/balance?playerId=me", "");
    const theirs = canonicalRequest("1700000000000", "GET", "/v1/wallet/balance?playerId=someone-else", "");

    assert.notEqual(mine, theirs);
  });

  it("normalises the method's case so a correctly-signed lowercase verb still verifies", () => {
    assert.equal(
      canonicalRequest("1700000000000", "post", "/v1/launch", ""),
      canonicalRequest("1700000000000", "POST", "/v1/launch", ""),
    );
  });
});

describe("verifySignature", () => {
  it("accepts a signature computed over the same canonical string", () => {
    const canonical = canonicalRequest("1700000000000", "POST", "/v1/launch", '{"playerId":"p1"}');
    assert.equal(verifySignature(SECRET, canonical, computeSignature(SECRET, canonical)), true);
  });

  it("rejects a signature computed with a different secret", () => {
    // The property that makes per-operator secrets meaningful: one
    // operator's valid signature must not authenticate as another.
    const canonical = canonicalRequest("1700000000000", "POST", "/v1/launch", "");
    assert.equal(verifySignature(SECRET, canonical, computeSignature("a-different-secret", canonical)), false);
  });

  it("rejects a signature for a different request", () => {
    const signed = canonicalRequest("1700000000000", "POST", "/v1/wallet/cash-in", '{"amount":100}');
    const attempted = canonicalRequest("1700000000000", "POST", "/v1/wallet/cash-in", '{"amount":100000}');

    assert.equal(verifySignature(SECRET, attempted, computeSignature(SECRET, signed)), false);
  });

  it("rejects a truncated signature rather than matching on its prefix", () => {
    // If the comparison were a prefix match — or if lengths were coerced
    // before comparing — a short signature would be the cheapest possible
    // forgery.
    const canonical = canonicalRequest("1700000000000", "GET", "/v1/games", "");
    const full = computeSignature(SECRET, canonical);

    assert.equal(verifySignature(SECRET, canonical, full.slice(0, 32)), false);
    assert.equal(verifySignature(SECRET, canonical, ""), false);
  });

  it("rejects a non-hex signature instead of letting it decode to an empty buffer", () => {
    // `Buffer.from("zz", "hex")` yields a 0-length buffer rather than
    // throwing. Refused explicitly, so this does not depend on the length
    // check happening to catch it.
    const canonical = canonicalRequest("1700000000000", "GET", "/v1/games", "");

    assert.equal(verifySignature(SECRET, canonical, "zz"), false);
    assert.equal(verifySignature(SECRET, canonical, "not-a-hex-signature"), false);
  });

  it("rejects an over-long signature without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, so an unguarded
    // implementation turns a malformed header into a 500 — which is both an
    // error-handling bug and a way to tell malformed from merely wrong.
    const canonical = canonicalRequest("1700000000000", "GET", "/v1/games", "");
    const tooLong = computeSignature(SECRET, canonical) + "aabb";

    assert.doesNotThrow(() => verifySignature(SECRET, canonical, tooLong));
    assert.equal(verifySignature(SECRET, canonical, tooLong), false);
  });

  it("accepts an uppercase hex signature, since hex case carries no meaning", () => {
    const canonical = canonicalRequest("1700000000000", "GET", "/v1/games", "");
    const signature = computeSignature(SECRET, canonical);

    assert.equal(verifySignature(SECRET, canonical, signature.toUpperCase()), true);
  });
});
