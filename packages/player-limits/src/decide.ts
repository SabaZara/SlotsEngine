import type { LimitPeriod } from "./periods.js";

/**
 * Deciding whether a bet may be placed. Pure — no clock, no database.
 *
 * The impurity is pushed to the caller on purpose. `spinRound` reads the
 * limits and the counters inside its transaction and hands them here, so
 * this file holds the part that can be *wrong about money* while holding
 * none of the part that can be wrong about concurrency. It also means a
 * refusal is reproducible from its inputs, which matters when a player
 * disputes one.
 *
 * **What this is not.** These are the operator- and player-set limits a
 * licence requires; they are not a fraud system and not a risk engine.
 * Nothing here reasons about behaviour, only about arithmetic against a
 * declared ceiling.
 */

/** Every amount is integer minor units, like all money in this system. */
export interface PlayerLimit {
  period: LimitPeriod;
  /** Maximum total staked in the period. Absent means unlimited. */
  maxStake?: number;
  /**
   * Maximum net loss in the period, where loss is `staked - won`.
   *
   * Net rather than gross, because gross is not what a player means by
   * "lose": staking 100 and winning 95 back is a loss of 5, and counting it
   * as 100 would exhaust a limit five times faster than the person setting
   * it expects. The consequence, stated because it surprises people: a
   * winning session can *lower* accumulated loss and re-open headroom
   * that was previously exhausted. That is the honest reading of a loss
   * limit and is what regulators specify.
   */
  maxLoss?: number;
}

/** What has already happened in the period, as accumulated counters. */
export interface PeriodUsage {
  staked: number;
  won: number;
}

export type LimitRefusalReason = "stake_limit_reached" | "loss_limit_reached";

export interface LimitDecision {
  allowed: boolean;
  reason?: LimitRefusalReason;
  /** Which period refused, so the player can be told *which* limit. */
  period?: LimitPeriod;
  /**
   * What the player could still stake under the binding limit, in minor
   * units. Present on a refusal so the client can say "you can still bet
   * 250" rather than only "no" — and `0` when nothing is left, which is
   * distinct from absent.
   */
  remaining?: number;
}

const ALLOWED: LimitDecision = { allowed: true };

/**
 * Decides a proposed stake against every configured limit.
 *
 * **Every limit is checked and the tightest refusal wins**, rather than
 * returning on the first failure. A player at both their daily and monthly
 * ceiling should be told about the one that leaves them least room, because
 * a message naming the daily limit when the monthly one is also exhausted
 * invites them to come back tomorrow to the same refusal.
 */
export function decideBet(limits: PlayerLimit[], usage: Record<LimitPeriod, PeriodUsage>, stake: number): LimitDecision {
  if (!Number.isInteger(stake) || stake <= 0) {
    // A non-integer or non-positive stake is a caller bug, not a limit
    // decision, and silently allowing it would let a `NaN` stake through
    // every comparison below — every `>` against NaN is false, so an
    // unchecked NaN reads as "within every limit". F22's shape exactly.
    throw new RangeError(`decideBet needs a positive integer stake, got ${stake}`);
  }

  let refusal: LimitDecision | undefined;

  for (const limit of limits) {
    const used = usage[limit.period] ?? { staked: 0, won: 0 };

    if (limit.maxStake !== undefined) {
      const remaining = Math.max(0, limit.maxStake - used.staked);
      if (stake > remaining) {
        refusal = tightest(refusal, {
          allowed: false,
          reason: "stake_limit_reached",
          period: limit.period,
          remaining,
        });
      }
    }

    if (limit.maxLoss !== undefined) {
      // Net loss floors at zero: a player up on the period has lost
      // nothing, and letting the figure go negative would hand them
      // headroom *above* their own limit — the limit would stop meaning
      // "never lose more than this" and start meaning "never lose more
      // than this, plus whatever you are ahead by".
      const lost = Math.max(0, used.staked - used.won);
      const remaining = Math.max(0, limit.maxLoss - lost);
      if (stake > remaining) {
        refusal = tightest(refusal, {
          allowed: false,
          reason: "loss_limit_reached",
          period: limit.period,
          remaining,
        });
      }
    }
  }

  return refusal ?? ALLOWED;
}

/** The refusal leaving the player least room. Ties keep the incumbent, so
 * the order limits are declared in decides — which is stable, unlike
 * whichever happened to be evaluated first. */
function tightest(current: LimitDecision | undefined, candidate: LimitDecision): LimitDecision {
  if (!current) return candidate;
  return (candidate.remaining ?? 0) < (current.remaining ?? 0) ? candidate : current;
}
