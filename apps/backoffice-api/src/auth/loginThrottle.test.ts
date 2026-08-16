import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import {
  checkLock,
  clearFailures,
  loadThrottlePolicy,
  lockoutDurationMs,
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

describe("exponential backoff (docs/TODO.md item 3)", () => {
  /**
   * The item this addresses: a flat lockout window is a denial-of-service
   * lever, because anyone who knows an administrator's email can keep that
   * account locked indefinitely by failing on purpose.
   *
   * Backoff does not remove that lever — nothing does, short of not locking
   * at all — but it changes the asymmetry. A legitimate user's FIRST lockout
   * is unchanged, while an attacker grinding the same account spends
   * exponentially more wall-clock time per allowance of guesses.
   *
   * The cap is the other half, and it is the reason this is a mitigation
   * rather than a trade of one problem for a worse one: uncapped doubling
   * would let a determined attacker push a targeted user's wait to weeks.
   */
  const backoff: ThrottlePolicy = {
    maxAttempts: 2,
    lockoutMs: 60_000,
    maxLockoutMs: 8 * 60_000,
    attemptWindowMs: 300_000,
  };

  describe("lockoutDurationMs", () => {
    it("leaves the first lockout at the base duration", () => {
      // The property that keeps this safe to ship: someone who mistypes
      // their password waits exactly what they waited before.
      assert.equal(lockoutDurationMs(backoff, 1), 60_000);
    });

    it("doubles for each consecutive lockout", () => {
      assert.equal(lockoutDurationMs(backoff, 2), 120_000);
      assert.equal(lockoutDurationMs(backoff, 3), 240_000);
      assert.equal(lockoutDurationMs(backoff, 4), 480_000);
    });

    it("stops doubling at the cap", () => {
      // Without this an attacker willing to keep failing turns a mitigation
      // for the DoS lever into a better version of the lever.
      assert.equal(lockoutDurationMs(backoff, 5), 8 * 60_000);
      assert.equal(lockoutDurationMs(backoff, 50), 8 * 60_000);
    });

    it("does not overflow into Infinity for an absurd lockout count", () => {
      // 2**1024 is Infinity. A duration of Infinity would store a
      // `lockedUntil` of Infinity, and no time would ever pass it.
      const duration = lockoutDurationMs(backoff, 5_000);
      assert.ok(Number.isFinite(duration), `duration must stay finite, got ${duration}`);
      assert.equal(duration, 8 * 60_000);
    });

    it("treats a missing cap as uncapped rather than as NaN", () => {
      // `Math.min(x, undefined)` is NaN, and a NaN `lockedUntil` compares
      // false against every `now` — locking an account forever with nothing
      // to show why. A policy literal written outside this module is exactly
      // how that would arrive.
      const uncapped = { maxAttempts: 2, lockoutMs: 60_000, attemptWindowMs: 300_000 } as ThrottlePolicy;

      assert.equal(lockoutDurationMs(uncapped, 1), 60_000);
      assert.equal(lockoutDurationMs(uncapped, 3), 240_000);
      assert.ok(Number.isFinite(lockoutDurationMs(uncapped, 5_000)));
    });

    it("treats a zeroth lockout as the base duration, not half of it", () => {
      assert.equal(lockoutDurationMs(backoff, 0), 60_000);
    });
  });

  describe("through recordFailure", () => {
    it("lengthens each successive lockout for the same account", async () => {
      const { db } = fakeMongo();
      const d = db as never;

      // First lockout: base duration.
      await recordFailure(d, "target@x.com", backoff, T0);
      const first = await recordFailure(d, "target@x.com", backoff, T0);
      assert.equal(first.locked, true);
      assert.equal(first.retryAfter, 60, "the first lockout is the base window");

      // Wait it out, then fail again — the attacker's pattern.
      const afterFirst = T0 + 61_000;
      await recordFailure(d, "target@x.com", backoff, afterFirst);
      const second = await recordFailure(d, "target@x.com", backoff, afterFirst);
      assert.equal(second.locked, true);
      assert.equal(second.retryAfter, 120, "the second lockout must cost more than the first");

      const afterSecond = afterFirst + 121_000;
      await recordFailure(d, "target@x.com", backoff, afterSecond);
      const third = await recordFailure(d, "target@x.com", backoff, afterSecond);
      assert.equal(third.retryAfter, 240, "and the third more again");
    });

    it("records the escalating deadline, so checkLock agrees with what was reported", async () => {
      // The returned `retryAfter` and the stored `lockedUntil` must describe
      // the same moment. If they diverged, a client would be told to wait
      // one duration and refused for another.
      const { db } = fakeMongo();
      const d = db as never;

      await recordFailure(d, "target@x.com", backoff, T0);
      await recordFailure(d, "target@x.com", backoff, T0);
      const afterFirst = T0 + 61_000;
      await recordFailure(d, "target@x.com", backoff, afterFirst);
      const second = await recordFailure(d, "target@x.com", backoff, afterFirst);

      const observed = await checkLock(d, "target@x.com", afterFirst);
      assert.equal(observed.locked, true);
      assert.equal(observed.retryAfter, second.retryAfter);
    });

    it("holds the escalated lock for its full, longer duration", async () => {
      // The base duration must not silently still apply underneath.
      const { db } = fakeMongo();
      const d = db as never;

      await recordFailure(d, "target@x.com", backoff, T0);
      await recordFailure(d, "target@x.com", backoff, T0);
      const afterFirst = T0 + 61_000;
      await recordFailure(d, "target@x.com", backoff, afterFirst);
      await recordFailure(d, "target@x.com", backoff, afterFirst);

      // 90s in: past the BASE window, still inside the doubled one.
      assert.equal((await checkLock(d, "target@x.com", afterFirst + 90_000)).locked, true);
      // 121s in: past the doubled window.
      assert.equal((await checkLock(d, "target@x.com", afterFirst + 121_000)).locked, false);
    });

    it("does not escalate a different account", async () => {
      // The history is per-account, so one targeted address cannot make
      // everyone else's lockouts longer.
      const { db } = fakeMongo();
      const d = db as never;

      for (const at of [T0, T0 + 61_000, T0 + 200_000]) {
        await recordFailure(d, "target@x.com", backoff, at);
        await recordFailure(d, "target@x.com", backoff, at);
      }

      await recordFailure(d, "bystander@x.com", backoff, T0);
      const bystander = await recordFailure(d, "bystander@x.com", backoff, T0);
      assert.equal(bystander.retryAfter, 60, "an unrelated account starts at the base window");
    });

    it("caps the wait, so a targeted user still recovers the same day", async () => {
      // The DoS lever this item is about. Backoff must not become a way to
      // lock someone out for a week.
      const { db } = fakeMongo();
      const d = db as never;

      let now = T0;
      let last = 0;
      for (let round = 0; round < 8; round++) {
        await recordFailure(d, "target@x.com", backoff, now);
        last = (await recordFailure(d, "target@x.com", backoff, now)).retryAfter;
        now += last * 1000 + 1_000;
      }

      assert.equal(last, 8 * 60, "the wait must plateau at the configured ceiling");
    });
  });

  describe("what forgives the escalation", () => {
    it("resets on a successful login, and only there", async () => {
      // The asymmetry that makes backoff acceptable: the legitimate owner
      // proves they know the password and the history is wiped, while an
      // attacker who never succeeds keeps climbing.
      const { db } = fakeMongo();
      const d = db as never;

      await recordFailure(d, "target@x.com", backoff, T0);
      await recordFailure(d, "target@x.com", backoff, T0);
      const afterFirst = T0 + 61_000;
      await recordFailure(d, "target@x.com", backoff, afterFirst);
      await recordFailure(d, "target@x.com", backoff, afterFirst);

      await clearFailures(d, "target@x.com");

      const afterClear = afterFirst + 200_000;
      await recordFailure(d, "target@x.com", backoff, afterClear);
      const relocked = await recordFailure(d, "target@x.com", backoff, afterClear);
      assert.equal(relocked.retryAfter, 60, "a successful login returns the account to the base window");
    });

    it("does NOT reset merely because the lock expired", async () => {
      // Resetting on expiry would give an attacker a fresh full allowance
      // every window instead of a slow drip — the same reasoning that
      // governs the attempt counter.
      const { db } = fakeMongo();
      const d = db as never;

      await recordFailure(d, "target@x.com", backoff, T0);
      await recordFailure(d, "target@x.com", backoff, T0);

      // Long after the lock expired AND after the attempt window, so the
      // attempt count is forgotten — but the lockout history is not.
      const muchLater = T0 + 10 * 300_000;
      await recordFailure(d, "target@x.com", backoff, muchLater);
      const second = await recordFailure(d, "target@x.com", backoff, muchLater);

      assert.equal(second.retryAfter, 120, "a patient attacker must not be reset to the base window");
    });
  });

  describe("loadThrottlePolicy", () => {
    it("defaults the cap to two hours", () => {
      // Long enough that grinding is pointless, short enough that a
      // deliberately-targeted administrator recovers the same day without
      // anyone's intervention.
      assert.equal(loadThrottlePolicy({}).maxLockoutMs, 120 * 60_000);
    });

    it("reads the cap from the environment, in minutes", () => {
      assert.equal(loadThrottlePolicy({ LOGIN_MAX_LOCKOUT_MINUTES: "45" }).maxLockoutMs, 45 * 60_000);
    });
  });
});
