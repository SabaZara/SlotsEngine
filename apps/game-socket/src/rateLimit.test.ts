import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConnectionLimiter, TokenBucket } from "./rateLimit.js";

// Time is passed explicitly throughout rather than slept on: a limiter
// tested with real waits is slow and flaky, and the refill maths is the
// part worth checking precisely.
const T0 = 1_000_000;

describe("TokenBucket", () => {
  it("allows a full burst immediately, then refuses", () => {
    const bucket = new TokenBucket({ ratePerSecond: 5, burst: 3 }, T0);

    assert.equal(bucket.tryConsume(T0), true);
    assert.equal(bucket.tryConsume(T0), true);
    assert.equal(bucket.tryConsume(T0), true);
    assert.equal(bucket.tryConsume(T0), false, "the fourth exceeds a burst of 3");
  });

  it("refills continuously rather than in steps", () => {
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 5 }, T0);
    for (let i = 0; i < 5; i++) bucket.tryConsume(T0);

    // At 10/s, 100ms buys exactly one token.
    assert.equal(bucket.tryConsume(T0 + 50), false, "half a token is not a token");
    assert.equal(bucket.tryConsume(T0 + 100), true);
  });

  it("never refills beyond the burst, so idle time cannot be banked", () => {
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 3 }, T0);

    // An hour idle should still only buy `burst` back-to-back messages.
    const later = T0 + 3_600_000;
    assert.equal(bucket.tryConsume(later), true);
    assert.equal(bucket.tryConsume(later), true);
    assert.equal(bucket.tryConsume(later), true);
    assert.equal(bucket.tryConsume(later), false, "idling must not accumulate an unbounded allowance");
  });

  it("holds the sustained rate over a long run, without a window edge to exploit", () => {
    const bucket = new TokenBucket({ ratePerSecond: 5, burst: 5 }, T0);
    let allowed = 0;

    // Ten seconds, attempting every 50ms. A fixed-window limiter would let
    // through two full allowances across a boundary; a bucket should
    // converge on rate*seconds plus the initial burst.
    for (let ms = 0; ms <= 10_000; ms += 50) {
      if (bucket.tryConsume(T0 + ms)) allowed++;
    }

    assert.ok(allowed <= 5 + 5 * 10 + 1, `allowed ${allowed}, expected about 55`);
    assert.ok(allowed >= 5 + 5 * 10 - 1, `allowed ${allowed}, expected about 55`);
  });

  it("does not consume a token when it refuses", () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1 }, T0);
    bucket.tryConsume(T0);

    // Ten refused attempts must not push the next success further away.
    for (let i = 0; i < 10; i++) bucket.tryConsume(T0);

    assert.equal(bucket.tryConsume(T0 + 1000), true, "a refusal must not extend the penalty");
  });

  it("reports how long to wait, and zero when a token is ready", () => {
    const bucket = new TokenBucket({ ratePerSecond: 2, burst: 1 }, T0);
    bucket.tryConsume(T0);

    const wait = bucket.retryAfterSeconds(T0);
    assert.ok(wait > 0 && wait <= 0.5, `expected about 0.5s, got ${wait}`);
    assert.equal(bucket.retryAfterSeconds(T0 + 500), 0);
  });

  it("treats a clock that jumps backwards as no elapsed time, not as a refill", () => {
    const bucket = new TokenBucket({ ratePerSecond: 5, burst: 2 }, T0);
    bucket.tryConsume(T0);
    bucket.tryConsume(T0);

    assert.equal(bucket.tryConsume(T0 - 60_000), false, "a backwards clock must not grant free tokens");
  });
});

describe("ConnectionLimiter", () => {
  const limits = {
    spin: { ratePerSecond: 1, burst: 2 },
    message: { ratePerSecond: 10, burst: 20 },
  };

  it("lets ordinary traffic through untouched", () => {
    const limiter = new ConnectionLimiter(limits, T0);

    assert.equal(limiter.check("PING", T0).allowed, true);
    assert.equal(limiter.check("JOIN", T0).allowed, true);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
  });

  it("limits spins tightly while leaving other messages usable", () => {
    const limiter = new ConnectionLimiter(limits, T0);

    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, false, "third spin exceeds a burst of 2");

    // The connection is still usable for everything else — a rate-limited
    // player should still be able to recover a round or answer a ping.
    assert.equal(limiter.check("PING", T0).allowed, true);
    assert.equal(limiter.check("ROUND_RECOVER", T0).allowed, true);
  });

  it("charges the general bucket for a spin too, so spins cannot dodge the flood limit", () => {
    const floodable = { spin: { ratePerSecond: 100, burst: 100 }, message: { ratePerSecond: 1, burst: 3 } };
    const limiter = new ConnectionLimiter(floodable, T0);

    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, true);
    assert.equal(
      limiter.check("SPIN_REQUEST", T0).allowed,
      false,
      "the message ceiling must apply even when the spin ceiling is generous",
    );
  });

  it("reports a retry hint a client can act on", () => {
    const limiter = new ConnectionLimiter(limits, T0);
    limiter.check("SPIN_REQUEST", T0);
    limiter.check("SPIN_REQUEST", T0);

    const verdict = limiter.check("SPIN_REQUEST", T0);
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) assert.ok(verdict.retryAfter > 0, "a refusal must say when to try again");
  });

  it("recovers on its own once the client slows down", () => {
    const limiter = new ConnectionLimiter(limits, T0);
    limiter.check("SPIN_REQUEST", T0);
    limiter.check("SPIN_REQUEST", T0);
    assert.equal(limiter.check("SPIN_REQUEST", T0).allowed, false);

    // One second at 1/s buys exactly one spin back.
    assert.equal(limiter.check("SPIN_REQUEST", T0 + 1000).allowed, true);
  });

  it("gives each connection its own allowance", () => {
    const a = new ConnectionLimiter(limits, T0);
    const b = new ConnectionLimiter(limits, T0);

    a.check("SPIN_REQUEST", T0);
    a.check("SPIN_REQUEST", T0);
    assert.equal(a.check("SPIN_REQUEST", T0).allowed, false);

    assert.equal(b.check("SPIN_REQUEST", T0).allowed, true, "one abusive client must not limit another");
  });

  it("limits an unknown message type rather than letting it bypass the ceiling", () => {
    const limiter = new ConnectionLimiter({ spin: { ratePerSecond: 1, burst: 1 }, message: { ratePerSecond: 1, burst: 2 } }, T0);

    assert.equal(limiter.check("", T0).allowed, true);
    assert.equal(limiter.check("NOT_A_REAL_TYPE", T0).allowed, true);
    assert.equal(limiter.check("NOT_A_REAL_TYPE", T0).allowed, false, "garbage must still be counted");
  });
});
