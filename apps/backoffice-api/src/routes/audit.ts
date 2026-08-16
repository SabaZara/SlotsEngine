import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { requireRole } from "../auth/middleware.js";
import { readAuditLog } from "../audit/log.js";

export function registerAuditRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Read-only, and restricted to operations and above. There is no write
   * route here at all — an audit log with an API for editing it is a log
   * nobody can rely on.
   */
  app.get<{ Querystring: { entityId?: string; entityType?: string; actorUserId?: string; action?: string; limit?: string } }>(
    "/v1/audit",
    { preHandler: [requireRole("operations")] },
    async (request, reply) => {
      const { entityId, entityType, actorUserId, action, limit } = request.query;
      const entries = await readAuditLog(db, {
        ...(entityId ? { entityId } : {}),
        ...(entityType ? { entityType } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        ...(action ? { action } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      return reply.send({ entries });
    },
  );
}
