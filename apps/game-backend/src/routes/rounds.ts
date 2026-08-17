import type { FastifyInstance } from "fastify";
import type { Db, MongoClient } from "mongodb";
import { InsufficientFundsError, InvalidAmountError, ensurePlayer, getBalance } from "@slots-engine/ledger";
import { GameNotFoundError, loadGameDefinition } from "../rounds/games.js";
import { InvalidBetAmountError, recoverRound, spinRound } from "../rounds/service.js";
import { LimitExceededError } from "../rounds/limits.js";

interface SpinBody {
  operatorId?: string;
  playerId?: string;
  gameId?: string;
  totalBet?: number;
  clientRequestId?: string;
}

/**
 * The HTTP boundary: validate the shape, call the domain, map typed errors
 * to status codes. No business logic and no direct database access lives
 * here — that separation is what keeps the money path readable in one file.
 */
export function registerRoundRoutes(app: FastifyInstance, db: Db, client: MongoClient): void {
  app.post<{ Body: SpinBody }>("/internal/rounds/spin", async (request, reply) => {
    const { operatorId, playerId, gameId, totalBet, clientRequestId } = request.body ?? {};

    if (!operatorId || !playerId || !gameId) {
      return reply.code(400).send({ error: "operatorId, playerId and gameId are required" });
    }
    // Checked here as well as in the domain: a float would corrupt the
    // ledger via a fractional increment, and rejecting it at the boundary
    // keeps the bad value from travelling any further into the system.
    if (!Number.isInteger(totalBet) || (totalBet as number) <= 0) {
      return reply.code(400).send({ error: "totalBet must be a positive integer in minor units" });
    }

    try {
      const gameDef = await loadGameDefinition(db, gameId);
      const result = await spinRound(db, client, gameDef, {
        operatorId,
        playerId,
        totalBet: totalBet as number,
        ...(clientRequestId !== undefined ? { clientRequestId } : {}),
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
      if (err instanceof InvalidBetAmountError) return reply.code(400).send({ error: "invalid_bet_amount" });
      if (err instanceof InvalidAmountError) return reply.code(400).send({ error: "invalid_amount" });
      if (err instanceof InsufficientFundsError) return reply.code(402).send({ error: "insufficient_funds" });
      if (err instanceof LimitExceededError) {
        // 403, not 402. "Insufficient funds" means top up and try again;
        // this means the player set (or was set) a ceiling and has reached
        // it, and topping up changes nothing. Conflating the two would have
        // a client offer a deposit prompt against a limit — the single
        // worst response a responsible-gambling control can produce.
        //
        // The decision is echoed so the player can be told which limit and
        // how much room is left, rather than only "no".
        return reply.code(403).send({
          error: err.decision.reason ?? "limit_exceeded",
          period: err.decision.period,
          remaining: err.decision.remaining,
        });
      }
      throw err;
    }
  });

  app.post<{ Body: { operatorId?: string; playerId?: string; roundId?: string } }>(
    "/internal/rounds/recover",
    async (request, reply) => {
      const { operatorId, playerId, roundId } = request.body ?? {};
      if (!operatorId || !playerId) {
        return reply.code(400).send({ error: "operatorId and playerId are required" });
      }
      const round = await recoverRound(db, operatorId, playerId, roundId);
      if (!round) return reply.code(404).send({ error: "no_round_found" });
      return reply.send({ round });
    },
  );

  app.post<{ Body: { operatorId?: string; playerId?: string } }>(
    "/internal/players/balance",
    async (request, reply) => {
      const { operatorId, playerId } = request.body ?? {};
      if (!operatorId || !playerId) {
        return reply.code(400).send({ error: "operatorId and playerId are required" });
      }
      // Ensure the player exists before reading, exactly as the spin path
      // does. Without this a first-time player is told their balance is 0
      // at JOIN, then sees their first spin debit from a funded balance —
      // the number on screen would disagree with the number that pays.
      // `ensurePlayer` is an upsert that never touches an existing balance,
      // so this is safe to call on every read.
      await ensurePlayer(db, operatorId, playerId);
      return reply.send({ balance: await getBalance(db, operatorId, playerId) });
    },
  );
}
