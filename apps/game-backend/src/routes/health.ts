import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";

export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  /** Liveness: the process is up. Deliberately does not touch the database
   * — a liveness probe that fails on a database blip restarts a healthy
   * process and makes an outage worse. */
  app.get("/health", async () => ({ service: "game-backend", status: "ok" }));

  /** Readiness: this instance can actually serve a round, which means the
   * database must answer. */
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.command({ ping: 1 });
      return reply.send({ service: "game-backend", status: "ready" });
    } catch {
      return reply.code(503).send({ service: "game-backend", status: "not_ready" });
    }
  });
}
