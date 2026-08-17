import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideBet, type PeriodUsage, type PlayerLimit } from "./decide.js";
import type { LimitPeriod } from "./periods.js";

/**
 * The bet decision.
 *
 * Pure arithmetic against declared ceilings, which is why it is tested this
 * closely: every branch here is a decision about whether someone's money
 * moves, and the failure mode is not an exception but a bet that should
 * have been refused and was not.
 *
 * What these cannot establish: that the counters handed in are accurate, or
 * that two concurrent spins cannot both pass. Neither is decidable here —
 * accumulation is atomic and lives inside the spin transaction, and its
 * tests are in game-backend against real MongoDB.
 */

const NO_USAGE: Record<LimitPeriod, PeriodUsage> = {
  daily: { staked: 0, won: 0 },
  weekly: { staked: 0, won: 0 },
  monthly: { staked: 0, won: 0 },
};

function usage(overrides: Partial<Record<LimitPeriod, PeriodUsage>>): Record<LimitPeriod, PeriodUsage> {
  return { ...NO_USAGE, ...overrides };
}

describe("with no limits configured", () => {
  it("allows the bet, because an absent limit is not a limit of zero", () => {
    // The default posture matters: a player with no limits set must be
    // able to play. Reading "no limits" as "nothing allowed" would break
    // every existing player the moment this shipped.
    assert.deepEqual(decideBet([], NO_USAGE, 500), { allowed: true });
  });
});

describe("a stake limit", () => {
  const daily: PlayerLimit[] = [{ period: "daily", maxStake: 1_000 }];

  it("allows a bet that fits inside the remaining allowance", () => {
    assert.equal(decideBet(daily, usage({ daily: { staked: 400, won: 0 } }), 600).allowed, true);
  });

  it("allows a bet that lands exactly on the ceiling", () => {
    // The boundary a `>=` would get wrong. A limit of 1,000 means a player
    // may stake 1,000, not 999.
    assert.equal(decideBet(daily, usage({ daily: { staked: 0, won: 0 } }), 1_000).allowed, true);
  });

  it("refuses the bet that would cross the ceiling, naming what is left", () => {
    const decision = decideBet(daily, usage({ daily: { staked: 900, won: 0 } }), 200);
    assert.deepEqual(decision, {
      allowed: false,
      reason: "stake_limit_reached",
      period: "daily",
      remaining: 100,
    });
  });

  it("reports zero remaining once the allowance is spent, rather than omitting it", () => {
    // `remaining: 0` and an absent `remaining` mean different things to a
    // client — "you have nothing left" versus "we did not say".
    const decision = decideBet(daily, usage({ daily: { staked: 1_000, won: 0 } }), 100);
    assert.equal(decision.remaining, 0);
  });

  it("never reports negative headroom, even if a counter overran its limit", () => {
    // A counter can legitimately exceed its ceiling if a limit is lowered
    // after the fact. Reporting -500 remaining would render as nonsense to
    // a player and could be arithmetic-ed back into headroom by a caller.
    const decision = decideBet(daily, usage({ daily: { staked: 1_500, won: 0 } }), 100);
    assert.equal(decision.remaining, 0);
  });

  it("counts stake, not net position — a win does not re-open a stake limit", () => {
    // The distinction from a loss limit. A stake limit bounds how much is
    // put at risk; winning some of it back does not un-risk it.
    const decision = decideBet(daily, usage({ daily: { staked: 1_000, won: 5_000 } }), 100);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "stake_limit_reached");
  });
});

describe("a loss limit", () => {
  const daily: PlayerLimit[] = [{ period: "daily", maxLoss: 1_000 }];

  it("measures net loss, so winnings offset what was staked", () => {
    // Staked 5,000 and won 4,500 is a loss of 500, not of 5,000. Reading
    // it as gross would exhaust the limit ten times faster than the person
    // who set it expects.
    assert.equal(decideBet(daily, usage({ daily: { staked: 5_000, won: 4_500 } }), 400).allowed, true);
  });

  it("refuses once net loss leaves less room than the bet", () => {
    const decision = decideBet(daily, usage({ daily: { staked: 5_000, won: 4_200 } }), 400);
    assert.deepEqual(decision, {
      allowed: false,
      reason: "loss_limit_reached",
      period: "daily",
      remaining: 200,
    });
  });

  it("gives a player who is ahead their whole allowance, not more", () => {
    // Up on the period, so nothing is lost — but the limit is still 1,000
    // and must not be inflated by however far ahead they are. This is the
    // floor-at-zero rule; without it a player up 10,000 could lose 11,000.
    const decision = decideBet(daily, usage({ daily: { staked: 1_000, won: 11_000 } }), 1_001);
    assert.deepEqual(decision, {
      allowed: false,
      reason: "loss_limit_reached",
      period: "daily",
      remaining: 1_000,
    });
  });
});

describe("several limits at once", () => {
  it("refuses with the one that leaves the player least room", () => {
    // Both are breached; the monthly is tighter. Naming the daily limit
    // would invite the player back tomorrow to the same refusal.
    const limits: PlayerLimit[] = [
      { period: "daily", maxStake: 1_000 },
      { period: "monthly", maxStake: 10_000 },
    ];
    const decision = decideBet(
      limits,
      usage({ daily: { staked: 800, won: 0 }, monthly: { staked: 9_950, won: 0 } }),
      500,
    );
    assert.equal(decision.period, "monthly");
    assert.equal(decision.remaining, 50);
  });

  it("checks every period, not only the first that is configured", () => {
    // A weekly limit breached while the daily one is fine must still
    // refuse. Returning early on the first *pass* would miss it.
    const limits: PlayerLimit[] = [
      { period: "daily", maxStake: 10_000 },
      { period: "weekly", maxStake: 1_000 },
    ];
    const decision = decideBet(limits, usage({ weekly: { staked: 1_000, won: 0 } }), 100);
    assert.equal(decision.allowed, false);
    assert.equal(decision.period, "weekly");
  });

  it("weighs a stake limit against a loss limit on the same period", () => {
    // One limit of each kind, both breached, genuinely different headroom:
    // stake leaves 200, loss leaves 50. The tightest must win regardless of
    // which kind it is, and loss is checked second — so this also proves
    // a later check can displace an earlier refusal.
    const limits: PlayerLimit[] = [{ period: "daily", maxStake: 2_000, maxLoss: 500 }];
    const decision = decideBet(limits, usage({ daily: { staked: 1_800, won: 1_350 } }), 400);
    assert.equal(decision.reason, "loss_limit_reached");
    assert.equal(decision.remaining, 50);
  });

  it("keeps the earlier refusal when two leave exactly the same room", () => {
    // A tie is decided by declaration order rather than by which check
    // happens to run second, so the message a player sees is stable across
    // a refactor that reorders the checks.
    const limits: PlayerLimit[] = [{ period: "daily", maxStake: 2_000, maxLoss: 500 }];
    const decision = decideBet(limits, usage({ daily: { staked: 1_800, won: 1_500 } }), 400);
    assert.equal(decision.reason, "stake_limit_reached");
    assert.equal(decision.remaining, 200);
  });

  it("allows a bet that fits inside every configured limit", () => {
    const limits: PlayerLimit[] = [
      { period: "daily", maxStake: 1_000, maxLoss: 500 },
      { period: "weekly", maxStake: 5_000 },
      { period: "monthly", maxLoss: 20_000 },
    ];
    assert.equal(decideBet(limits, NO_USAGE, 100).allowed, true);
  });

  it("treats a period with no counter yet as unused rather than crashing", () => {
    // A player's first-ever bet has no counter rows at all. Reading a
    // missing period as `undefined` and comparing against it would make
    // every check pass silently.
    const limits: PlayerLimit[] = [{ period: "weekly", maxStake: 100 }];
    const decision = decideBet(limits, {} as Record<LimitPeriod, PeriodUsage>, 500);
    assert.equal(decision.allowed, false, "a missing counter means zero used, not unlimited");
    assert.equal(decision.remaining, 100);
  });
});

describe("a stake that is not money", () => {
  it("refuses a NaN stake rather than passing every comparison", () => {
    // Every `>` against NaN is false, so an unchecked NaN reads as "within
    // every limit" — the exact mechanism of F22, on the bet amount.
    assert.throws(() => decideBet([{ period: "daily", maxStake: 10 }], NO_USAGE, Number.NaN), RangeError);
  });

  it("refuses a fractional stake, because money here is integer minor units", () => {
    assert.throws(() => decideBet([], NO_USAGE, 10.5), RangeError);
  });

  it("refuses a zero or negative stake", () => {
    // A negative stake would *increase* remaining headroom on every limit.
    assert.throws(() => decideBet([], NO_USAGE, 0), RangeError);
    assert.throws(() => decideBet([], NO_USAGE, -100), RangeError);
  });
});
