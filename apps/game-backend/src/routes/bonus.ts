import type { FastifyInstance } from "fastify";
import type { Db, MongoClient } from "mongodb";
import { InvalidBonusActionError } from "@slots-engine/math-engine";
import {
  BonusSessionAbandonedError,
  BonusSessionNotFoundError,
  startBonus,
  stepBonus,
} from "../bonus/session.js";
import { GameNotFoundError, loadGameDefinition } from "../rounds/games.js";

export function registerBonusRoutes(app: FastifyInstance, db: Db, client: MongoClient): void {
  app.post<{
    Body: { operatorId?: string; playerId?: string; gameId?: string; roundId?: string; moduleId?: string; totalBet?: number };
  }>("/internal/bonus/start", async (request, reply) => {
    const { operatorId, playerId, gameId, roundId, moduleId, totalBet } = request.body ?? {};
    if (!operatorId || !playerId || !gameId || !roundId || !moduleId) {
      return reply.code(400).send({ error: "operatorId, playerId, gameId, roundId and moduleId are required" });
    }
    if (!Number.isInteger(totalBet) || (totalBet as number) <= 0) {
      return reply.code(400).send({ error: "totalBet must be a positive integer in minor units" });
    }

    try {
      const gameDef = await loadGameDefinition(db, gameId);
      const result = await startBonus(db, client, gameDef, {
        operatorId,
        playerId,
        gameId,
        roundId,
        moduleId,
        totalBet: totalBet as number,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
      throw err;
    }
  });

  app.post<{
    Body: { operatorId?: string; playerId?: string; gameId?: string; bonusSessionId?: string; action?: string; payload?: Record<string, unknown> };
  }>("/internal/bonus/step", async (request, reply) => {
    const { operatorId, playerId, gameId, bonusSessionId, action, payload } = request.body ?? {};
    if (!operatorId || !playerId || !gameId || !bonusSessionId || !action) {
      return reply.code(400).send({ error: "operatorId, playerId, gameId, bonusSessionId and action are required" });
    }

    try {
      const gameDef = await loadGameDefinition(db, gameId);
      const result = await stepBonus(db, client, gameDef, {
        operatorId,
        playerId,
        bonusSessionId,
        action,
        ...(payload !== undefined ? { payload } : {}),
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
      if (err instanceof BonusSessionNotFoundError) return reply.code(404).send({ error: "bonus_session_not_found" });
      // 410 rather than 404: the session genuinely existed and is now gone,
      // which is a different thing for a client to explain to a player.
      if (err instanceof BonusSessionAbandonedError) return reply.code(410).send({ error: "bonus_session_abandoned" });
      if (err instanceof InvalidBonusActionError) return reply.code(400).send({ error: "invalid_bonus_action", message: err.message });
      throw err;
    }
  });
}
