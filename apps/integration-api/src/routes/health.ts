import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";

/**
 * The only unauthenticated routes, matching game-backend's split for the
 * same reasons recorded there: liveness must not touch the database,
 * because a probe that fails on a database blip restarts a healthy process
 * and turns a blip into an outage.
 */
export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  app.get("/health", async () => ({ service: "integration-api", status: "ok" }));

  /** Readiness: this instance can actually serve an operator, which needs
   * the database — every route here authenticates against it, so an
   * instance that cannot reach Mongo can serve nothing at all. */
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.command({ ping: 1 });
      return reply.send({ service: "integration-api", status: "ready" });
    } catch {
      return reply.code(503).send({ service: "integration-api", status: "not_ready" });
    }
  });
}
