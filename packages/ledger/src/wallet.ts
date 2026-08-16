import type { ClientSession, Db, MongoClient } from "mongodb";

export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient funds");
    this.name = "InsufficientFundsError";
  }
}

/**
 * Every ledger amount is an integer minor-unit count (see shared-types'
 * money.ts). A caller passing a float would silently corrupt the ledger via
 * a fractional `$inc` — with no error raised anywhere — so this is checked
 * before any write happens.
 */
export class InvalidAmountError extends Error {
  constructor(amount: number) {
    super(`ledger amount must be a positive integer (minor units), got ${amount}`);
    this.name = "InvalidAmountError";
  }
}

export interface LedgerOpInput {
  operatorId: string;
  playerId: string;
  /**
   * The idempotency key, unique per operator. For round-scoped ops the
   * convention is `${roundId}:debit` / `${roundId}:credit`; for a bonus
   * payout, `${bonusSessionId}:bonus-credit`.
   */
  transactionId: string;
  /** Integer minor units. Validated below — a float or non-positive value
   * throws before any write. */
  amount: number;
  /** Only present for ops tied to a game round. */
  roundId?: string;
}

export interface LedgerOpResult {
  /** Integer minor units. */
  balanceAfter: number;
  /** True if this call found an existing transaction and did NOT re-apply
   * the balance change — the idempotency guarantee in action. */
  alreadyProcessed: boolean;
}

/**
 * Applies one ledger operation as part of an already-open transaction — the
 * caller owns the transaction boundary. For a spin that boundary spans the
 * whole round (debit -> evaluate -> credit -> insert), so a crash partway
 * through rolls back cleanly and never leaves money debited for a round
 * that doesn't exist.
 *
 * A duplicate `transactionId` is caught twice over: by the in-flight check
 * here for the common case, and by a unique index at the storage layer as
 * the backstop that makes a lost race impossible. The check alone is a
 * read-then-write and would not survive concurrency; the index alone would
 * turn every ordinary retry into an error. Both together is the house
 * idiom for exactly-once throughout this codebase.
 */
async function applyLedgerOp(
  db: Db,
  session: ClientSession,
  type: "debit" | "credit",
  input: LedgerOpInput,
): Promise<LedgerOpResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new InvalidAmountError(input.amount);
  }

  const existing = await db
    .collection("transactions")
    .findOne({ operatorId: input.operatorId, transactionId: input.transactionId }, { session });
  if (existing) {
    return { balanceAfter: (existing.balanceAfter as number | undefined) ?? 0, alreadyProcessed: true };
  }

  const delta = type === "debit" ? -input.amount : input.amount;

  if (type === "debit") {
    const player = await db
      .collection("players")
      .findOne({ operatorId: input.operatorId, playerId: input.playerId }, { session });
    if (!player || (player.balance as number) < input.amount) {
      throw new InsufficientFundsError();
    }
  }

  // Only a credit may implicitly create the player document. A first
  // cash-in is a legitimate way for a player to come into existence; a
  // debit never upserts, because the check above already requires an
  // existing player with sufficient funds.
  //
  // That makes `type === "credit"` unobservable today rather than
  // load-bearing: flipping it to `upsert: true` breaks no test, because a
  // debit can never reach here without a player. It is kept as a second
  // statement of the same rule — if the funds check above is ever narrowed
  // or moved, this is what stops a debit quietly conjuring a player with a
  // negative balance. Deliberately not "simplified" away.
  const updated = await db.collection("players").findOneAndUpdate(
    { operatorId: input.operatorId, playerId: input.playerId },
    { $inc: { balance: delta }, $set: { updatedAt: new Date() } },
    { returnDocument: "after", session, upsert: type === "credit" },
  );
  const balanceAfter = (updated?.balance as number | undefined) ?? 0;

  await db.collection("transactions").insertOne(
    {
      transactionId: input.transactionId,
      operatorId: input.operatorId,
      ...(input.roundId !== undefined ? { roundId: input.roundId } : {}),
      playerId: input.playerId,
      type,
      amount: input.amount,
      balanceAfter,
      status: "completed",
      createdAt: new Date(),
    },
    { session },
  );

  return { balanceAfter, alreadyProcessed: false };
}

export function debitWithinSession(db: Db, session: ClientSession, input: LedgerOpInput): Promise<LedgerOpResult> {
  return applyLedgerOp(db, session, "debit", input);
}

export function creditWithinSession(db: Db, session: ClientSession, input: LedgerOpInput): Promise<LedgerOpResult> {
  return applyLedgerOp(db, session, "credit", input);
}

/**
 * Opens a session, runs `fn` inside a transaction, always ends the session.
 * Used wherever a caller has no larger transaction to attach to.
 */
export async function withLedgerTransaction<T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = client.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await fn(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) throw new Error("transaction committed without producing a result");
  return result;
}
