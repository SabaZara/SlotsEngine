import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import type { RoleId } from "@slots-engine/shared-types";
import { verifySession, type SessionPayload } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
  }
}

const PUBLIC_PATHS = new Set(["/health", "/health/ready", "/v1/auth/login"]);

/**
 * Requires `Authorization: Bearer <token>` on every route except the health
 * checks and login.
 *
 * The extra database lookup per request is the point, not an oversight. A
 * signed token is stateless, so without re-checking `tokenVersion` a
 * deactivated user keeps full access until their token expires on its own —
 * up to eight hours during which revoking access does nothing. For an
 * internal admin surface handling a few requests a second, one indexed
 * lookup is a trivial price for actually being able to revoke a session.
 * This would be the wrong trade on the player-facing money path, which is
 * why that path doesn't make it.
 */
export function registerAuthHook(app: FastifyInstance, db: Db): void {
  app.addHook("preHandler", async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split("?")[0])) return;

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_auth" });
    }

    const session = verifySession(header.slice("Bearer ".length));
    if (!session) {
      return reply.code(401).send({ error: "invalid_or_expired_session" });
    }

    const user = await db
      .collection("users")
      .findOne({ userId: session.userId }, { projection: { tokenVersion: 1, active: 1 } });

    const currentTokenVersion = (user?.tokenVersion as number | undefined) ?? 0;
    if (!user || user.active === false || currentTokenVersion !== session.tokenVersion) {
      return reply.code(401).send({ error: "session_revoked" });
    }

    request.user = session;
  });
}

/**
 * Route-level guard: `preHandler: [requireRole("game_designer")]`.
 *
 * `super_admin` always passes. That is a deliberate simplification — it
 * means a role list never has to enumerate the admin, and there is exactly
 * one answer to "who can always get in".
 */
export function requireRole(...allowed: RoleId[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const roles = request.user?.roles ?? [];
    if (roles.includes("super_admin")) return;
    if (!roles.some((role) => allowed.includes(role))) {
      return reply.code(403).send({ error: "forbidden", requiredRoles: allowed });
    }
  };
}
