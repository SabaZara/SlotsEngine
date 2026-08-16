import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { GameNotFoundError, loadGameDefinition } from "../rounds/games.js";
import { toPublicView } from "../rounds/publicView.js";

/**
 * The only route a browser hits directly, and therefore the only place an
 * information-disclosure mistake reaches a player. Everything it returns
 * goes through `toPublicView`'s explicit allowlist — see that file for what
 * is withheld and why.
 */
export function registerPublicRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { gameId: string } }>("/public/games/:gameId", async (request, reply) => {
    try {
      const gameDef = await loadGameDefinition(db, request.params.gameId);
      return reply.send(toPublicView(gameDef));
    } catch (err) {
      if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
      throw err;
    }
  });
}
