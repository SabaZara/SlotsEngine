import type { ClientSession, Db } from "mongodb";
import {
  LIMIT_PERIODS,
  decideBet,
  effectiveLimits,
  periodKey,
  type LimitDecision,
  type LimitPeriod,
  type PendingLimitChange,
  type PeriodUsage,
  type PlayerLimit,
} from "@slots-engine/player-limits";

/**
 * Enforcing player protection limits on the money path.
 *
 * **Everything here runs inside the spin's transaction, and that is the
 * whole design.** The obvious implementation — check the limits, then spin
 * — is wrong in the way this repo has been bitten by twice already: two
 * concurrent spins both read "900 of 1,000 staked", both decide 200 fits,
 * and both commit, so a 1,000 limit passes 1,300. It is the reference's
 * bonus-credit race and F32's tie-break, one layer up, and no amount of
 * checking *before* the transaction fixes it.
 *
 * What makes it safe is that the counter is advanced **inside** the same
 * transaction as the debit. Mongo's snapshot isolation then does the
 * arbitration: a concurrent spin either serialises behind this one and sees
 * the raised counter, or hits a write conflict and is retried by the driver
 * — which `withLedgerTransaction` already handles for the ledger.
 *
 * **The transaction is the guarantee; the atomic `$inc` is not.** Measured
 * rather than argued, because the reverse is the intuitive answer: a
 * read-then-`$inc` pair *inside* a transaction was probed at 20 concurrent
 * callers against a ceiling of 10 and let exactly 10 through, because
 * snapshot isolation refuses the interleaving that would break it. So
 * mutating this to read-then-write is an equivalent mutant and is recorded
 * as one. What is **not** equivalent is dropping the session: the same code
 * outside the transaction lets the ceiling be exceeded, and that mutation
 * is caught. `$inc` is kept anyway — it needs no prior read, so it is one
 * round trip rather than two on the money path, and it stays correct if
 * this is ever called outside a transaction.
 *
 * **The counter is advanced before the decision, not after.** Incrementing
 * first and refunding on refusal reads as wasteful, and it is the only
 * order that cannot double-spend: incrementing afterwards leaves a window
 * in which the decision was made against a counter that another spin is
 * concurrently raising.
 */

/** Thrown when a limit refuses the bet. Carries the decision so the route
 * can tell the player which limit and how much room is left — "no" alone
 * is the answer that generates a support ticket. */
export class LimitExceededError extends Error {
  constructor(readonly decision: LimitDecision) {
    super(decision.reason ?? "limit_exceeded");
    this.name = "LimitExceededError";
  }
}

interface LimitsDoc {
  limits?: PlayerLimit[];
  pending?: PendingLimitChange;
}

/**
 * Reads the limits a player is actually held to right now.
 *
 * Absent means unlimited — a player with no document must be able to play,
 * so this is the one place where "no data" is a permissive answer rather
 * than a suspicious one.
 *
 * **A matured loosening is honoured here, not when someone next writes.**
 * A raise takes 24 hours to come into force, and nothing runs at the moment
 * it does; if this read used the stored set alone, the player would stay
 * held to the old ceiling until some unrelated request happened to persist
 * the change. That is a limit still binding after it expired, which is the
 * failure a player notices and reports. `effectiveLimits` is the single
 * place that answers "which ceilings apply", so the money path and the
 * screens cannot disagree about it.
 */
export async function readLimits(
  db: Db,
  operatorId: string,
  playerId: string,
  at: Date,
  session?: ClientSession,
): Promise<PlayerLimit[]> {
  const doc = await db
    .collection("playerLimits")
    .findOne<LimitsDoc>(
      { operatorId, playerId },
      { projection: { _id: 0, limits: 1, pending: 1 }, ...(session ? { session } : {}) },
    );

  return effectiveLimits(doc?.limits ?? [], doc?.pending, at.getTime());
}

/**
 * Stakes against every period's counter and decides whether the bet stands.
 *
 * Returns the decision rather than throwing, so the caller controls what a
 * refusal means at its own layer — the spin path turns it into a thrown
 * `LimitExceededError` because it needs the transaction to abort, but a
 * "can I afford this" preview would want the value.
 */
export async function stakeAgainstLimits(
  db: Db,
  session: ClientSession,
  input: { operatorId: string; playerId: string; stake: number; at: Date },
): Promise<LimitDecision> {
  const limits = await readLimits(db, input.operatorId, input.playerId, input.at, session);

  // Nothing configured: no counters to advance and nothing to decide. The
  // early return matters on a hot path — the overwhelming majority of
  // players have no limits set, and they should pay nothing for the
  // feature beyond one indexed lookup.
  if (limits.length === 0) return { allowed: true };

  const usage = await advanceCounters(db, session, input);

  return decideBet(limits, usage, input.stake);
}

/**
 * Adds the stake to each period's counter and returns what the totals were
 * **before** this bet.
 *
 * The subtraction at the end is not a quirk — it is the join between the
 * two halves of this design. The write has to happen first, because that
 * is what makes it atomic; the decision has to be made against prior usage,
 * because `decideBet` asks "does this stake fit in what is left". Handing
 * back the post-increment figure would count the bet twice and refuse the
 * bet that exactly fills a limit. Reading the counter *before* incrementing
 * would be the read-then-write race this whole module exists to avoid, so
 * the increment's own return value is the only safe source: it is the one
 * number guaranteed to include this bet and every bet that beat it.
 *
 * Every period is advanced, not only the ones with a limit configured.
 * Counters would otherwise be wrong the moment a limit is added — a player
 * given a weekly limit on Friday would start from zero, having staked all
 * week, and the first genuinely-over-limit bet would be allowed.
 */
async function advanceCounters(
  db: Db,
  session: ClientSession,
  input: { operatorId: string; playerId: string; stake: number; at: Date },
): Promise<Record<LimitPeriod, PeriodUsage>> {
  const usage = {} as Record<LimitPeriod, PeriodUsage>;

  // Sequential rather than `Promise.all`. Concurrent writes on one
  // transaction session are not safe — a `ClientSession` carries the
  // transaction state and is not designed for parallel operations — and
  // three indexed upserts are not the cost worth taking that risk for.
  for (const period of LIMIT_PERIODS) {
    const key = periodKey(period, input.at);

    const updated = await db.collection("playerLimitUsage").findOneAndUpdate(
      { operatorId: input.operatorId, playerId: input.playerId, period, periodKey: key },
      {
        $inc: { staked: input.stake },
        // `won` is set only on insert. Incrementing it here would zero a
        // running total on every bet.
        $setOnInsert: { won: 0 },
      },
      { upsert: true, returnDocument: "after", session, projection: { _id: 0, staked: 1, won: 1 } },
    );

    // Net of this bet: the counter now includes it, and the decision is
    // about whether it fits in what was left beforehand.
    const stakedIncludingThisBet = (updated?.staked as number | undefined) ?? input.stake;
    usage[period] = {
      staked: stakedIncludingThisBet - input.stake,
      won: (updated?.won as number | undefined) ?? 0,
    };
  }

  return usage;
}

/**
 * Records a win against the same period counters the stake went to.
 *
 * Separate from `stakeAgainstLimits` because it happens later in the spin —
 * the win is not known until after evaluation — and because a losing spin
 * never calls it at all.
 *
 * **Uses the same `at` as the stake.** A spin that begins at 23:59:59.998
 * and resolves after midnight must credit the day it was staked against,
 * or a loss limit sees the stake without the win and refuses bets the
 * player has already won back.
 */
export async function recordWinAgainstLimits(
  db: Db,
  session: ClientSession,
  input: { operatorId: string; playerId: string; won: number; at: Date },
): Promise<void> {
  if (input.won <= 0) return;

  for (const period of LIMIT_PERIODS) {
    await db.collection("playerLimitUsage").updateOne(
      { operatorId: input.operatorId, playerId: input.playerId, period, periodKey: periodKey(period, input.at) },
      { $inc: { won: input.won } },
      // **No upsert, deliberately** — and this is the half that matters.
      // `stakeAgainstLimits` skips an unlimited player entirely, so an
      // upsert here would create a counter holding a win with no matching
      // stake. The moment a limit was later added to that player, their
      // net loss would read as negative and the floor-at-zero would hand
      // them their full allowance on top of winnings the counter never
      // saw the cost of.
      //
      // Updating only a row the stake already created keeps the two halves
      // symmetric: a counter exists if and only if this player is limited,
      // and it always holds both sides of the same rounds.
      { session },
    );
  }
}
