import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ServiceAuthError, verifyServiceRequest } from "@slots-engine/service-auth";
import type { Logger } from "@slots-engine/logging";

/**
 * Guards every `/internal/*` route.
 *
 * The architecture this engine is modelled on left these routes entirely
 * unauthenticated and relied on network isolation: `/internal/rounds/spin`
 * accepted `operatorId` and `playerId` as plain body fields with no
 * ownership check, so anything able to reach the port could spin as any
 * player. That is a single misconfigured network policy away from being the
 * whole of the system's security.
 *
 * A signed request does not make the body trustworthy on its own — it makes
 * it *attributable*. Combined with the socket taking identity only from a
 * verified token, the result is that no unsigned party can name a player,
 * and every internal call can be traced to a caller.
 */
export function registerServiceAuth(app: FastifyInstance, secret: string, logger: Logger): void {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/internal/")) return;

    try {
      const { caller } = verifyServiceRequest({
        secret,
        method: request.method,
        // The signed path excludes any query string, matching how the
        // caller signs it. These routes take their input from the body.
        path: request.url.split("?")[0],
        rawBody: typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}),
        headers: request.headers as Record<string, string | string[] | undefined>,
      });
      request.serviceCaller = caller;
    } catch (err) {
      if (err instanceof ServiceAuthError) {
        // The specific reason is logged but never returned: a prober should
        // not learn whether it got the timestamp, the body or the secret
        // wrong.
        logger.warn({ reason: err.reason, path: request.url }, "rejected unauthenticated internal request");
        return reply.code(401).send({ error: "unauthorized" });
      }
      throw err;
    }
  });
}

declare module "fastify" {
  interface FastifyRequest {
    serviceCaller?: string;
  }
}
