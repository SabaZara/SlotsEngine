import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { generateSeed } from "@slots-engine/rng";
import type { BonusPublicState, BonusSession, GameDefinition } from "@slots-engine/shared-types";
import { creditWithinSession, getBalance, withLedgerTransaction } from "@slots-engine/ledger";
import { deriveStepRng, getBonusModule, InvalidBonusActionError } from "@slots-engine/math-engine";

export class BonusSessionNotFoundError extends Error {}
export class BonusSessionAbandonedError extends Error {}

/** How long an untouched active session survives before the sweep closes
 * it. Long enough for a player to reconnect after a dropped connection,
 * short enough that a stuck session doesn't block them forever. */
const ABANDON_AFTER_MS = 15 * 60 * 1000;

/**
 * How long a session row is KEPT after it is created, before the TTL index
 * on `archiveAfter` removes it. TODO item 5.
 *
 * Deliberately not the same thing as `ABANDON_AFTER_MS`, and the gap between
 * them is the point. Abandonment is a *status change* fifteen minutes in —
 * the row stays, so a player returning to a timed-out bonus gets a precise
 * 410 ("that bonus round timed out") rather than "no such session". Archival
 * is the row finally going away, and it must not happen while anyone could
 * still ask about it.
 *
 * Two years is chosen to sit beyond the retention periods gambling
 * regulators typically require for player-dispute records, which are
 * commonly one year or less. It is a *retention* decision rather than a
 * technical one, so it is a named constant with this comment attached and
 * overridable per deployment — an operator whose licence demands longer sets
 * `BONUS_SESSION_RETENTION_DAYS` rather than patching code.
 *
 * The direction of the default matters: too long merely costs storage, while
 * too short destroys the evidence for a dispute about money that was or was
 * not paid.
 */
function retentionMs(): number {
  const days = Number(process.env.BONUS_SESSION_RETENTION_DAYS ?? 730);
  // A misconfigured value must not shorten retention to nothing — deleting
  // dispute evidence early is the failure that cannot be undone.
  if (!Number.isFinite(days) || days <= 0) return 730 * 24 * 60 * 60 * 1000;
  return days * 24 * 60 * 60 * 1000;
}

export interface StartBonusInput {
  operatorId: string;
  playerId: string;
  gameId: string;
  roundId: string;
  moduleId: string;
  /** Integer minor units — the bet that triggered this bonus. */
  totalBet: number;
}

export interface BonusStepResult {
  publicState: BonusPublicState;
  done: boolean;
  /** Integer minor units. Present once resolved. */
  balanceAfter?: number;
}

function publicState(session: BonusSession, view: Record<string, unknown>): BonusPublicState {
  return {
    bonusSessionId: session.bonusSessionId,
    moduleId: session.moduleId,
    status: session.status,
    ...(session.status === "resolved" ? { totalWin: session.totalWin } : {}),
    view,
  };
}

/**
 * Opens a bonus session for a triggering round.
 *
 * The session carries its own seed, and every step's randomness is derived
 * from `(seed, stepIndex)` rather than drawn fresh — so a bonus round is
 * replayable to exactly the same standard as a spin, and a repeated request
 * for the same step sees an identical stream.
 *
 * A unique index on `roundId` means one triggering spin can only ever open
 * one paying session, however many times an auto-start is retried after a
 * reconnect.
 */
export async function startBonus(
  db: Db,
  client: MongoClient,
  gameDef: GameDefinition,
  input: StartBonusInput,
): Promise<BonusStepResult> {
  const existing = await db.collection("bonusSessions").findOne({ roundId: input.roundId });
  if (existing) {
    // An auto-start replayed after a reconnect. Return what already exists
    // rather than opening — and eventually paying — a second session.
    const session = existing as unknown as BonusSession;
    return {
      publicState: publicState(session, (session.moduleState.view as Record<string, unknown>) ?? {}),
      done: session.status !== "active",
    };
  }

  const module = getBonusModule(input.moduleId);
  const params = gameDef.bonusModules.find((m) => m.moduleId === input.moduleId)?.params ?? {};
  const seed = generateSeed();

  const started = module.start({
    totalBet: input.totalBet,
    state: {},
    params,
    rng: deriveStepRng(seed, 0),
    // Passed to every module; only free spins reads them. See the note on
    // `BonusStepInput.gameDef` for why they are optional rather than
    // required — a self-contained module must not be able to reach the game
    // definition, or its expected value stops being computable from params.
    gameDef,
    sessionSeed: seed,
  });

  const session: BonusSession & { seed: string; stepIndex: number } = {
    bonusSessionId: randomUUID(),
    operatorId: input.operatorId,
    playerId: input.playerId,
    gameId: input.gameId,
    roundId: input.roundId,
    moduleId: input.moduleId,
    // A module that resolves on start (a wheel) is written straight to
    // `resolved`; the credit below is what makes that real.
    status: started.done ? "resolved" : "active",
    totalBet: input.totalBet,
    totalWin: started.done ? started.totalWin : 0,
    moduleState: { ...started.state, view: started.view },
    seed,
    stepIndex: 1,
    createdAt: new Date().toISOString(),
    ...(started.done ? { resolvedAt: new Date().toISOString() } : {}),
  };

  // The row and the payment commit together or not at all.
  //
  // These were two separate operations until item 25: the row was inserted,
  // and a `creditBonus` helper then opened its OWN transaction to pay. That
  // helper was a correct exactly-once credit, and owning its own
  // transaction is exactly what stopped it sharing this one — so it is gone
  // rather than fixed, while the idempotent
  // `${bonusSessionId}:bonus-credit` key it established is unchanged and
  // still the ledger's backstop against a double payment.
  //
  // A crash in that window left a session durably `resolved` with a
  // positive `totalWin` and no ledger entry — a bonus recorded as won and
  // never paid. Nothing repaired it either: the reconnect branch above
  // returns the existing row and pays nothing, and the sweep only moves
  // `active` rows, so the loss was permanent and silent.
  //
  // `spinRound` holds exactly this invariant one module over, and the
  // reasoning transfers unchanged: money must never be owed by a row that
  // committed without it.
  //
  // The module ran ABOVE this block, not inside it, and that is deliberate
  // — `module.start` is pure, so keeping it outside keeps the transaction
  // short and makes it safe to retry, the same argument `spinRound` makes
  // for `evaluateSpin` being pure inside its own.
  //
  // The result is wrapped in an object rather than returned as a bare
  // number: `withLedgerTransaction` throws on an `undefined` result, so
  // returning nothing for the common "nothing to pay yet" case — a
  // multi-step bonus that has only just opened — would turn every one of
  // those into an error.
  const { balanceAfter } = await withLedgerTransaction(client, async (mongoSession) => {
    await db.collection("bonusSessions").insertOne(
      {
        ...session,
        // Drives the TTL index. A Date rather than an ISO string, because
        // Mongo only reaps a TTL field that is a genuine BSON date — a
        // string here would be silently ignored and the row would live
        // forever, which is a failure nobody would notice for two years.
        archiveAfter: new Date(Date.now() + retentionMs()),
      },
      { session: mongoSession },
    );

    if (!(started.done && started.totalWin > 0)) return {};

    const credit = await creditWithinSession(db, mongoSession, {
      operatorId: session.operatorId,
      playerId: session.playerId,
      roundId: session.roundId,
      transactionId: `${session.bonusSessionId}:bonus-credit`,
      amount: started.totalWin,
    });
    return { balanceAfter: credit.balanceAfter };
  });

  return {
    publicState: publicState(session, started.view),
    done: started.done,
    // Only present when money actually moved, which is what it has always
    // meant to a caller.
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  };
}

export interface StepBonusInput {
  operatorId: string;
  playerId: string;
  bonusSessionId: string;
  action: string;
  payload?: Record<string, unknown>;
}

/**
 * Advances a multi-step bonus round.
 *
 * **This is where the reference implementation had a real defect, and the
 * shape of the fix is the point.** There, the status was read, the module
 * was stepped, and the result was written back — a read-then-write. Two
 * concurrent steps could both observe `active`, both run the module, and
 * both credit. Ledger idempotency kept the *amount* from being paid twice,
 * but the two runs could compute *different* wins, so the session's
 * recorded total could disagree with what was actually paid — the worst
 * kind of money bug, because it reconciles to nothing.
 *
 * Two changes close it:
 *
 * 1. **The step is claimed atomically.** The `findOneAndUpdate` below
 *    matches on the current `stepIndex` and advances it in the same
 *    operation, so exactly one concurrent caller can ever claim a given
 *    step. The loser gets a clear error instead of a second evaluation.
 * 2. **The module is deterministic per step anyway.** Randomness comes from
 *    `deriveStepRng(seed, stepIndex)`, so even a retry that somehow reached
 *    the module twice would compute the identical result.
 *
 * Belt and braces, the same way the ledger pairs an in-flight check with a
 * unique index.
 */
export async function stepBonus(
  db: Db,
  client: MongoClient,
  gameDef: GameDefinition,
  input: StepBonusInput,
): Promise<BonusStepResult> {
  const current = (await db.collection("bonusSessions").findOne({
    bonusSessionId: input.bonusSessionId,
    operatorId: input.operatorId,
    playerId: input.playerId,
  })) as (BonusSession & { seed: string; stepIndex: number }) | null;

  if (!current) throw new BonusSessionNotFoundError(`no bonus session '${input.bonusSessionId}'`);
  if (current.status === "abandoned" || isExpired(current, Date.now())) {
    // The deadline is enforced HERE, on the read, not only by the sweep.
    //
    // `sweepAbandonedSessions` runs on an interval inside this process, so
    // relying on it alone makes expiry a property of a process being
    // alive: if every instance is down for twenty minutes, or the interval
    // is simply missed, a session that timed out long ago is still
    // `active` in the database and would be playable on the next request.
    // That is a money path deciding correctness from a timer.
    //
    // Checking the timestamp on the way past costs a comparison and makes
    // the deadline a property of the DATA. The sweep is then what it
    // should have been all along — bookkeeping that tidies rows, not the
    // thing standing between a stale session and a payout.
    //
    // Deliberately NOT a Mongo TTL index, which is where docs/TODO.md
    // pointed: a TTL deletes the row, and this branch is exactly why the
    // row is worth keeping. A deleted session is indistinguishable from
    // one that never existed, so a player returning to a bonus that timed
    // out would get "no such session" instead of "that bonus round timed
    // out" — strictly worse information, on the path where it matters
    // most.
    throw new BonusSessionAbandonedError("this bonus session timed out and can no longer be played");
  }
  if (current.status === "resolved") {
    throw new InvalidBonusActionError("this bonus session is already finished");
  }

  // Claim this specific step. Matching on `stepIndex` is what makes the
  // claim exclusive — a second concurrent caller finds the index already
  // advanced and matches nothing.
  const claimed = await db.collection("bonusSessions").findOneAndUpdate(
    { bonusSessionId: input.bonusSessionId, status: "active", stepIndex: current.stepIndex },
    { $inc: { stepIndex: 1 } },
    { returnDocument: "before" },
  );
  if (!claimed) {
    throw new InvalidBonusActionError("another step for this bonus session is already in progress");
  }

  const session = claimed as unknown as BonusSession & { seed: string; stepIndex: number };
  const module = getBonusModule(session.moduleId);
  const params = gameDef.bonusModules.find((m) => m.moduleId === session.moduleId)?.params ?? {};

  const result = module.step({
    totalBet: session.totalBet,
    state: session.moduleState,
    params,
    action: input.action,
    payload: input.payload,
    rng: deriveStepRng(session.seed, session.stepIndex),
    gameDef,
    // The session's own seed, NOT the per-step rng. Free spins derives one
    // seed per spin from it, so the whole round replays from this single
    // stored value regardless of how the step calls interleaved.
    sessionSeed: session.seed,
  });

  const resolvedAt = new Date().toISOString();

  // One transaction over the state write and the payment, for the reason
  // spelled out in `startBonus` — this is the second half of item 25 and
  // the same defect: a resolving step wrote `status: "resolved"` with a
  // `totalWin`, then paid in a separate transaction, so a crash between
  // them left the final step of a bonus recorded as won and unpaid.
  //
  // The step claim above stays OUTSIDE this transaction deliberately. It is
  // an atomic `findOneAndUpdate` on `stepIndex` and is what makes a step
  // exclusive; pulling it inside would change what a concurrent loser
  // observes, and the claim must hold even for a step that pays nothing.
  const { balanceAfter } = await withLedgerTransaction(client, async (mongoSession) => {
    await db.collection("bonusSessions").updateOne(
      { bonusSessionId: input.bonusSessionId },
      {
        $set: {
          moduleState: { ...result.state, view: result.view },
          ...(result.done ? { status: "resolved", totalWin: result.totalWin, resolvedAt } : {}),
        },
      },
      { session: mongoSession },
    );

    if (!(result.done && result.totalWin > 0)) return {};

    const credit = await creditWithinSession(db, mongoSession, {
      operatorId: session.operatorId,
      playerId: session.playerId,
      roundId: session.roundId,
      transactionId: `${session.bonusSessionId}:bonus-credit`,
      amount: result.totalWin,
    });
    return { balanceAfter: credit.balanceAfter };
  });

  const updated: BonusSession = {
    ...session,
    status: result.done ? "resolved" : "active",
    totalWin: result.done ? result.totalWin : 0,
    moduleState: result.state,
  };

  return {
    publicState: publicState(updated, result.view),
    done: result.done,
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  };
}

export async function getPlayerBalance(db: Db, operatorId: string, playerId: string): Promise<number> {
  return getBalance(db, operatorId, playerId);
}

/** Whether a session is past its deadline, whatever its stored status says.
 *
 * One definition of "too old", used by both the read path and the sweep, so
 * the two can never disagree about which sessions are expired. */
function isExpired(session: { status: string; createdAt: string }, now: number): boolean {
  return session.status === "active" && Date.parse(session.createdAt) < now - ABANDON_AFTER_MS;
}

/**
 * Closes sessions a player never came back to.
 *
 * A conditional `updateMany`, so it is idempotent and cheap to run
 * repeatedly, and it only ever moves `active` sessions — a resolved session
 * that already paid can never be reopened or swept.
 *
 * Note this is now *bookkeeping*, not a guard: `stepBonusSession` checks the
 * deadline itself on every read, so an expired session is refused whether or
 * not this has run. What the sweep still buys is that the stored status
 * matches reality — queries and future reporting see `abandoned` rather
 * than a row that only looks active until someone touches it.
 */
export async function sweepAbandonedSessions(db: Db, now = Date.now()): Promise<number> {
  // Same deadline as `isExpired`, expressed as a query rather than a
  // predicate because it has to run inside Mongo. `createdAt` is an ISO
  // string and ISO-8601 sorts lexicographically in UTC, which is what makes
  // this string comparison correct rather than a coincidence.
  const cutoff = new Date(now - ABANDON_AFTER_MS).toISOString();
  const result = await db.collection("bonusSessions").updateMany(
    { status: "active", createdAt: { $lt: cutoff } },
    { $set: { status: "abandoned" } },
  );
  return result.modifiedCount;
}
