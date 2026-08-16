import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";

export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  /** Liveness: the process is up. Deliberately does not touch the database
   * — a liveness probe that fails on a database blip restarts a healthy
   * process and makes an outage worse. */
  app.get("/health", async () => ({ service: "backoffice-api", status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.command({ ping: 1 });
      return reply.send({ service: "backoffice-api", status: "ready" });
    } catch {
      return reply.code(503).send({ service: "backoffice-api", status: "not_ready" });
    }
  });
}
