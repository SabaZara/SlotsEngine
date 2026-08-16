import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { LaunchTokenAlreadyUsedError, consumeLaunchToken } from "../launch/consume.js";

/**
 * Single-use enforcement for launch tokens. This lives in game-backend
 * rather than in the socket because it needs a database, and the socket is
 * otherwise a stateless relay — adding a database dependency there just to
 * track consumption would be the more expensive shape.
 */
export function registerLaunchTokenRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Body: { jti?: string; expiresAt?: number } }>(
    "/internal/launch-tokens/consume",
    async (request, reply) => {
      const { jti, expiresAt } = request.body ?? {};
      if (!jti || typeof expiresAt !== "number") {
        return reply.code(400).send({ error: "jti and expiresAt are required" });
      }

      try {
        await consumeLaunchToken(db, jti, expiresAt);
        return reply.send({ consumed: true });
      } catch (err) {
        // 409, not 401: the token was perfectly valid, it has simply been
        // spent. A client needs to tell those two apart to know whether
        // retrying with a fresh launch would help.
        if (err instanceof LaunchTokenAlreadyUsedError) {
          return reply.code(409).send({ error: "launch_token_already_used" });
        }
        throw err;
      }
    },
  );
}
