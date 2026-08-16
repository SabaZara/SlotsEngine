import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { runSimulation } from "@slots-engine/math-engine";
import { GameNotFoundError, loadGameDefinition } from "../rounds/games.js";

/**
 * Upper bound on a single simulation request.
 *
 * The reference implementation accepted a caller-supplied game definition
 * and up to a million synchronous spins on the same single-threaded process
 * that serves live rounds — so one authoring request could stall real
 * players' spins. Two changes here: the definition is loaded from the
 * database by id (never accepted from the caller, so this endpoint can't be
 * used to evaluate arbitrary math), and the count is capped.
 *
 * A cap is a mitigation, not a fix. The real fix is running simulations in
 * a worker process; this keeps the blast radius small until then.
 */
const MAX_SIM_COUNT = 100_000;

export function registerSimulateRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Body: { gameId?: string; simCount?: number; betPerSpin?: number; bonusReturnMultiplier?: number } }>(
    "/internal/simulate",
    async (request, reply) => {
      const { gameId, simCount, betPerSpin, bonusReturnMultiplier } = request.body ?? {};
      if (!gameId) return reply.code(400).send({ error: "gameId is required" });
      if (!Number.isInteger(simCount) || (simCount as number) <= 0) {
        return reply.code(400).send({ error: "simCount must be a positive integer" });
      }
      if ((simCount as number) > MAX_SIM_COUNT) {
        return reply.code(400).send({ error: "sim_count_too_large", max: MAX_SIM_COUNT });
      }

      try {
        const gameDef = await loadGameDefinition(db, gameId);
        const report = runSimulation(gameDef, {
          simCount: simCount as number,
          ...(betPerSpin !== undefined ? { betPerSpin } : {}),
          ...(bonusReturnMultiplier !== undefined ? { bonusReturnMultiplier } : {}),
        });

        const runId = randomUUID();
        await db.collection("rtpSimulationRuns").insertOne({ runId, ...report, createdAt: new Date() });
        return reply.send({ runId, ...report });
      } catch (err) {
        if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
        throw err;
      }
    },
  );
}
