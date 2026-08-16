import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import {
  checkLock,
  clearFailures,
  loadThrottlePolicy,
  recordFailure,
  type ThrottlePolicy,
} from "./loginThrottle.js";

// Time is passed in rather than slept on, for the same reason as the socket
// limiter: a lockout tested with real waits is slow, and the window maths is
// the part worth checking precisely.
const T0 = 1_700_000_000_000;
const policy: ThrottlePolicy = { maxAttempts: 3, lockoutMs: 60_000, attemptWindowMs: 300_000 };

const db = () => fakeMongo().db as never;

describe("recordFailure / checkLock", () => {
  it("does not lock before the limit is reached", async () => {
    const d = db();
    assert.equal((await recordFailure(d, "a@x.com", policy, T0)).locked, false);
    assert.equal((await recordFailure(d, "a@x.com", policy, T0)).locked, false);
    assert.equal((await checkLock(d, "a@x.com", T0)).locked, false);
  });

  it("locks on the configured attempt and reports how long to wait", async () => {
    const d = db();
    await recordFailure(d, "a@x.com", policy, T0);
    await recordFailure(d, "a@x.com", policy, T0);
    const third = await recordFailure(d, "a@x.com", policy, T0);

    assert.equal(third.locked, true);
    assert.equal(third.retryAfter, 60, "a lockout must say when it ends");
    assert.equal((await checkLock(d, "a@x.com", T0)).locked, true);
  });

  it("expires the lock on its own once the window passes", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);

    assert.equal((await checkLock(d, "a@x.com", T0 + 59_000)).locked, true);
    assert.equal((await checkLock(d, "a@x.com", T0 + 60_001)).locked, false, "recovery must need nothing to be running");
  });

  it("counts down the remaining time rather than reporting a constant", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);

    assert.equal((await checkLock(d, "a@x.com", T0 + 30_000)).retryAfter, 30);
  });

  it("throttles each account separately", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);

    assert.equal((await checkLock(d, "a@x.com", T0)).locked, true);
    assert.equal(
      (await checkLock(d, "b@x.com", T0)).locked,
      false,
      "one attacked account must not lock every other administrator out",
    );
  });

  it("counts attempts against an address that does not exist", async () => {
    // The counter is keyed by what was ATTEMPTED. Tracking only real
    // accounts would make a known and an unknown address behave
    // differently, which is the enumeration oracle the login route's
    // identical error body and dummy hash exist to close.
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "nobody@x.com", policy, T0);
    assert.equal((await checkLock(d, "nobody@x.com", T0)).locked, true);
  });

  it("shares one counter across case and whitespace variants", async () => {
    // Matches `findUserByEmail`'s normalisation. Two counters for one
    // account would halve the protection and be invisible while doing it.
    const d = db();
    await recordFailure(d, "a@x.com", policy, T0);
    await recordFailure(d, "A@X.com", policy, T0);
    await recordFailure(d, "  a@x.com  ", policy, T0);

    assert.equal((await checkLock(d, "a@x.com", T0)).locked, true);
  });

  it("forgets a stale run of failures rather than resuming it", async () => {
    const d = db();
    await recordFailure(d, "a@x.com", policy, T0);
    await recordFailure(d, "a@x.com", policy, T0);

    // Two typos today plus one next week must not add up to a lockout.
    const later = T0 + policy.attemptWindowMs + 1;
    assert.equal((await recordFailure(d, "a@x.com", policy, later)).locked, false);
    assert.equal((await checkLock(d, "a@x.com", later)).locked, false);
  });

  it("keeps counting within the window", async () => {
    const d = db();
    await recordFailure(d, "a@x.com", policy, T0);
    await recordFailure(d, "a@x.com", policy, T0 + 1000);
    const third = await recordFailure(d, "a@x.com", policy, T0 + 2000);

    assert.equal(third.locked, true, "attempts inside the window accumulate");
  });

  it("re-locks after an expired lock rather than granting an unbounded allowance", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);

    // Well past both the lock and the attempt window: the count resets, so
    // the attacker gets another burst — but only another burst, not free rein.
    const after = T0 + policy.attemptWindowMs + 1;
    assert.equal((await checkLock(d, "a@x.com", after)).locked, false);
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, after);
    assert.equal((await checkLock(d, "a@x.com", after)).locked, true);
  });

  it("sets a TTL date no earlier than the lock it must not cut short", async () => {
    // Reaping a document while its lock is still in force would end the
    // lockout early — garbage collection becoming a bypass.
    const d = db();
    const longLock: ThrottlePolicy = { maxAttempts: 1, lockoutMs: 600_000, attemptWindowMs: 60_000 };
    await recordFailure(d, "a@x.com", longLock, T0);

    const doc = await (d as never as ReturnType<typeof fakeMongo>["db"])
      .collection("loginAttempts")
      .findOne({ key: "a@x.com" });
    assert.ok(doc, "the counter document should exist");
    assert.ok(
      (doc!.expiresAt as Date).getTime() >= T0 + longLock.lockoutMs,
      "TTL must not expire a document while it is still locked",
    );
  });
});

describe("clearFailures", () => {
  it("resets the counter after a successful login", async () => {
    const d = db();
    await recordFailure(d, "a@x.com", policy, T0);
    await recordFailure(d, "a@x.com", policy, T0);
    await clearFailures(d, "a@x.com");

    // Back to a full allowance: two more failures must not lock.
    await recordFailure(d, "a@x.com", policy, T0);
    assert.equal((await recordFailure(d, "a@x.com", policy, T0)).locked, false);
  });

  it("releases an existing lock", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);
    assert.equal((await checkLock(d, "a@x.com", T0)).locked, true);

    await clearFailures(d, "a@x.com");
    assert.equal((await checkLock(d, "a@x.com", T0)).locked, false);
  });

  it("normalises the key it clears", async () => {
    const d = db();
    for (let i = 0; i < 3; i++) await recordFailure(d, "a@x.com", policy, T0);
    await clearFailures(d, "  A@X.COM ");
    assert.equal((await checkLock(d, "a@x.com", T0)).locked, false);
  });

  it("writes nothing for an address that has never failed", async () => {
    const d = db();
    await clearFailures(d, "fresh@x.com");
    const count = await (d as never as ReturnType<typeof fakeMongo>["db"])
      .collection("loginAttempts")
      .countDocuments({});
    assert.equal(count, 0, "a first-ever successful login should not create a counter");
  });
});

describe("loadThrottlePolicy", () => {
  it("defaults to ten attempts and a fifteen-minute lockout", () => {
    const p = loadThrottlePolicy({});
    assert.equal(p.maxAttempts, 10);
    assert.equal(p.lockoutMs, 15 * 60_000);
    assert.equal(p.attemptWindowMs, 15 * 60_000);
  });

  it("reads overrides from the environment, in minutes", () => {
    const p = loadThrottlePolicy({
      LOGIN_MAX_ATTEMPTS: "4",
      LOGIN_LOCKOUT_MINUTES: "30",
      LOGIN_ATTEMPT_WINDOW_MINUTES: "5",
    });
    assert.equal(p.maxAttempts, 4);
    assert.equal(p.lockoutMs, 30 * 60_000);
    assert.equal(p.attemptWindowMs, 5 * 60_000);
  });
});
