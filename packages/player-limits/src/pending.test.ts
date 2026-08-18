import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOOSENING_DELAY_MS, effectiveLimits, isDue, type PendingLimitChange } from "./pending.js";
import type { PlayerLimit } from "./decide.js";

/**
 * A loosening waiting out its delay.
 *
 * The boundary matters more than it looks: a change that matures a
 * millisecond early is a control that can be defeated by a clock, and one
 * that never matures is a player permanently held to a limit they lifted a
 * week ago. Both are silent.
 *
 * `now` is passed rather than read, so these are deterministic — and so
 * the money path can take one clock reading per round and use it for every
 * decision, which is the same rule the period counters follow.
 */

const STORED: PlayerLimit[] = [{ period: "daily", maxStake: 1_000 }];
const LOOSER: PlayerLimit[] = [{ period: "daily", maxStake: 9_000 }];

const pendingAt = (effectiveAt: number): PendingLimitChange => ({
  effectiveAt,
  limits: LOOSER,
  requestedAt: effectiveAt - LOOSENING_DELAY_MS,
});

describe("whether a change is due", () => {
  it("is not due while the delay is still running", () => {
    assert.equal(isDue(pendingAt(1_000), 999), false);
  });

  it("is due at exactly the effective instant, not a tick later", () => {
    // `>` instead of `>=` here would leave the change pending forever if no
    // request ever landed on a later millisecond — unlikely, but the kind
    // of boundary that only shows up once in production.
    assert.equal(isDue(pendingAt(1_000), 1_000), true);
  });

  it("stays due afterwards", () => {
    assert.equal(isDue(pendingAt(1_000), 60_000), true);
  });

  it("reports nothing pending as not due, rather than throwing", () => {
    // The overwhelmingly common case — almost no player has a pending
    // change — and it is on the money path, so it must be cheap and total.
    assert.equal(isDue(undefined, Date.now()), false);
  });
});

describe("which limits are actually in force", () => {
  it("holds the player to the stored limits while a loosening waits", () => {
    assert.deepEqual(effectiveLimits(STORED, pendingAt(10_000), 5_000), STORED);
  });

  it("honours a matured loosening even before anything has written it", () => {
    // Otherwise there is a window where the delay has passed and the player
    // is still refused, until some unrelated write happens to persist the
    // change. A limit that expired yesterday must not still be binding
    // because nobody has saved since.
    assert.deepEqual(effectiveLimits(STORED, pendingAt(10_000), 10_000), LOOSER);
  });

  it("uses the stored limits when nothing is pending", () => {
    assert.deepEqual(effectiveLimits(STORED, undefined, Date.now()), STORED);
  });

  it("returns the stored set unchanged rather than a copy of a different shape", () => {
    // The money path feeds this straight into `decideBet`, so the identity
    // of the common path matters: no allocation, no reordering.
    const result = effectiveLimits(STORED, undefined, Date.now());
    assert.equal(result, STORED);
  });
});

describe("the delay itself", () => {
  it("is 24 hours", () => {
    // Pinned as a claim rather than left implicit. If this ever changes it
    // should be a deliberate edit with a migration for rows already
    // carrying an `effectiveAt` computed from the old value.
    assert.equal(LOOSENING_DELAY_MS, 86_400_000);
  });

  it("is long enough that a session cannot outlast it", () => {
    // The property that matters, stated separately from the number: the
    // control exists so the player who raises a limit while chasing is not
    // the person who receives it.
    assert.ok(LOOSENING_DELAY_MS >= 12 * 60 * 60 * 1000);
  });
});
