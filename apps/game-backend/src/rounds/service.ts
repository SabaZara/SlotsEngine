import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { generateSeed } from "@slots-engine/rng";
import { DEFAULT_MATH_ENGINE_ID, type GameDefinition, type Round } from "@slots-engine/shared-types";
import {
  creditWithinSession,
  debitWithinSession,
  ensurePlayer,
  getBalance,
  withLedgerTransaction,
} from "@slots-engine/ledger";
import { getMathEngine } from "@slots-engine/math-engine";

export interface SpinRoundInput {
  operatorId: string;
  playerId: string;
  /** Integer minor units. The only client-controlled value on this path. */
  totalBet: number;
  /** Echoes the socket protocol's `SPIN_REQUEST.clientRequestId`. A retry
   * carrying the same id must return the original round, not spin again. */
  clientRequestId?: string;
}

export interface SpinRoundOutput {
  round: Round;
  balanceAfter: number;
}

/**
 * Thrown before any money moves. `betAmount` is player-variable, so an
 * out-of-range value is an ordinary occurrence to reject cleanly, not an
 * exceptional one.
 */
export class InvalidBetAmountError extends Error {}

function stripMongoId<T>(doc: Record<string, unknown>): T {
  const { _id, ...rest } = doc;
  return rest as T;
}

/**
 * The single entry point for turning a bet into a fully-resolved round:
 * validate -> debit -> evaluate -> credit -> persist, with everything after
 * validation inside one transaction.
 *
 * Order is not incidental here:
 *
 * - **The bet is checked against the game's own allowlist first**, before a
 *   player is even touched. The client can name an amount; it cannot name
 *   an amount this game doesn't offer.
 * - **The debit precedes evaluation.** There is no state in which a spin
 *   happened but wasn't paid for.
 * - **The RNG lives inside the transaction but is pure.** `evaluateSpin`
 *   does no I/O, which is what makes the transaction safe to retry and the
 *   round replayable from its stored seed afterwards.
 * - **The round is inserted in the same transaction as the money.** A crash
 *   anywhere rolls the whole thing back; money never leaves a balance for a
 *   round that doesn't exist.
 */
export async function spinRound(
  db: Db,
  client: MongoClient,
  gameDef: GameDefinition,
  input: SpinRoundInput,
): Promise<SpinRoundOutput> {
  if (!gameDef.betOptions.includes(input.totalBet)) {
    throw new InvalidBetAmountError(`totalBet ${input.totalBet} is not one of this game's configured betOptions`);
  }

  await ensurePlayer(db, input.operatorId, input.playerId);

  // Fast path for an ordinary retry. This is a convenience, not the
  // guarantee: the unique (operatorId, playerId, clientRequestId) index is
  // what actually makes a concurrent double-submit impossible — see the
  // duplicate-key recovery below.
  if (input.clientRequestId) {
    const existing = await db.collection("rounds").findOne({
      operatorId: input.operatorId,
      playerId: input.playerId,
      clientRequestId: input.clientRequestId,
    });
    if (existing) {
      return {
        round: stripMongoId<Round>(existing),
        balanceAfter: await getBalance(db, input.operatorId, input.playerId),
      };
    }
  }

  const roundId = randomUUID();

  try {
    return await withLedgerTransaction(client, async (session) => {
      const debit = await debitWithinSession(db, session, {
        operatorId: input.operatorId,
        playerId: input.playerId,
        roundId,
        transactionId: `${roundId}:debit`,
        amount: input.totalBet,
      });
      let balanceAfter = debit.balanceAfter;

      const seed = generateSeed();
      const mathEngine = getMathEngine(gameDef.mathEngineId ?? DEFAULT_MATH_ENGINE_ID);
      const spin = mathEngine.evaluateSpin(gameDef, seed, input.totalBet);

      if (spin.evaluation.totalWin > 0) {
        const credit = await creditWithinSession(db, session, {
          operatorId: input.operatorId,
          playerId: input.playerId,
          roundId,
          transactionId: `${roundId}:credit`,
          amount: spin.evaluation.totalWin,
        });
        balanceAfter = credit.balanceAfter;
      }

      const now = new Date().toISOString();
      const round: Round = {
        roundId,
        operatorId: input.operatorId,
        playerId: input.playerId,
        gameId: gameDef.gameId,
        gameVersion: gameDef.version,
        totalBet: input.totalBet,
        seed,
        rngAlgorithm: spin.rngAlgorithm,
        resultMatrix: spin.finalMatrix,
        expandedReels: spin.expandedReels,
        evaluation: spin.evaluation,
        status: "resolved",
        createdAt: now,
        resolvedAt: now,
        // Conditionally spread rather than assigning `undefined` — see the
        // matching note in math-engine's spin.ts.
        ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}),
      };

      // Insert a copy: the driver injects a generated `_id` into whatever
      // object it is handed, and the round returned to the caller should be
      // exactly the declared shape with no driver internals leaking in.
      await db.collection("rounds").insertOne({ ...round }, { session });
      return { round, balanceAfter };
    });
  } catch (err) {
    // Two concurrent spins with the same clientRequestId: one commits, the
    // other loses the unique index race. The loser's whole transaction
    // rolled back — including its debit — so the correct response is the
    // round that actually won, not an error. This is the case the
    // read-then-check above cannot cover on its own.
    if (isDuplicateKeyError(err) && input.clientRequestId) {
      const winner = await db.collection("rounds").findOne({
        operatorId: input.operatorId,
        playerId: input.playerId,
        clientRequestId: input.clientRequestId,
      });
      if (winner) {
        return {
          round: stripMongoId<Round>(winner),
          balanceAfter: await getBalance(db, input.operatorId, input.playerId),
        };
      }
    }
    throw err;
  }
}

/** Mongo reports a unique-index violation as error code 11000, including
 * when it surfaces from inside a transaction. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Fetches a specific round, or the player's most recent one — used to
 * replay an already-decided outcome to a client that missed it. A round is
 * never re-rolled on recovery, only re-read.
 *
 * Sorting by `_id` after `createdAt` is not redundant. `createdAt` is an
 * ISO string with millisecond resolution, and a player can easily produce
 * two rounds inside one millisecond (an autoplay loop, or a fast retry), at
 * which point "most recent" is genuinely ambiguous and the database may
 * return either. `_id` is monotonically increasing within a process, so it
 * breaks the tie in true insertion order — otherwise a reconnecting client
 * could be shown the older of two simultaneous rounds.
 */
export async function recoverRound(
  db: Db,
  operatorId: string,
  playerId: string,
  roundId?: string,
): Promise<Round | null> {
  const query = roundId ? { operatorId, playerId, roundId } : { operatorId, playerId };
  const doc = await db.collection("rounds").find(query).sort({ createdAt: -1, _id: -1 }).limit(1).next();
  return doc ? stripMongoId<Round>(doc) : null;
}
