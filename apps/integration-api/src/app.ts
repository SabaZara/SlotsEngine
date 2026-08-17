import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Db, MongoClient } from "mongodb";
import type { Logger } from "@slots-engine/logging";
import { registerAuthHook } from "./auth/middleware.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWalletRoutes } from "./routes/wallet.js";
import { registerLimitRoutes } from "./routes/limits.js";
import { registerLaunchRoute } from "./routes/launch.js";
import { registerGamesRoute } from "./routes/games.js";

export interface BuildAppOptions {
  db: Db;
  client: MongoClient;
  logger: Logger;
  /** Requests per minute, per operator key. */
  rateLimitMax: number;
  /** Where a launch URL points the player's browser. */
  gameFrontendUrl: string;
}

/**
 * The service's composition, separated from `index.ts` so it can be built
 * without binding a port or connecting to Mongo.
 *
 * The assembly hazards here are the same ones that produced **F6 and F7**
 * in game-backend's equivalent file, and they are worth naming because both
 * were composition bugs in code whose individual pieces were all correct:
 *
 *   - F6 — `void app.register(rateLimit, …)` in a synchronous factory left
 *     every route unlimited, because the plugin's `onRoute` hook had not
 *     installed by the time routes registered. No error; requests simply
 *     returned 200 with no protection. Hence `await`, and hence this
 *     function being async.
 *   - F7 — an error handler that flattened the limiter's 429 into a 500,
 *     destroying the one signal a limited client has to back off.
 *
 * There is a third hazard unique to this service: the **raw body parser**
 * must be installed before any route can be reached, or HMAC verification
 * silently compares against an empty body.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, client, logger, rateLimitMax, gameFrontendUrl } = options;

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  /**
   * Captures the exact bytes alongside parsing them.
   *
   * HMAC verification must run against what the operator actually signed.
   * Fastify's default JSON parser hands the route a parsed object and
   * discards the original text, and re-serialising that object is **not**
   * the identity function — key order, whitespace and number formatting
   * all differ — so a correctly-signed request would fail verification for
   * reasons no log would explain.
   *
   * The empty-body case is explicit: a POST with no body must parse to `{}`
   * rather than error, because route-level validation should be what
   * rejects it, with a message naming the missing field.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = body as string;
    if (!body) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /**
   * Rate limiting, keyed by the *claimed* `x-api-key-id` rather than by IP.
   *
   * The key is unverified at this point and that is unavoidable: the
   * limiter runs at `onRequest`, the auth hook is a `preHandler`, so no
   * verified `operatorId` exists yet. Using `request.operatorId` here would
   * read `undefined` on every request and silently key everything by IP —
   * the same class of mistake as game-backend's internal limiter, which was
   * measured rather than assumed.
   *
   * Keying on the claimed header still achieves the actual goal. Operators
   * commonly share an address — behind one aggregator's NAT, or a cloud
   * egress range — and an IP-keyed bucket lets one operator's traffic
   * starve another's. Bucketing by claimed key separates them. A forged
   * key-id gets its own bucket and then fails authentication moments later
   * regardless; the header is being used to *partition* traffic, not to
   * make a trust decision.
   *
   * Health is exempt: a limiter that can fail a readiness probe will
   * eventually take a healthy instance out of rotation for being busy.
   */
  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const claimed = request.headers["x-api-key-id"];
      const keyId = Array.isArray(claimed) ? claimed[0] : claimed;
      return keyId ? `op:${keyId}` : `ip:${request.ip}`;
    },
    allowList: (request) => (request.url ?? "").split("?")[0]?.startsWith("/health") ?? false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Too many requests. Retry in ${context.after}.`,
    }),
  });

  // Registered before the routes so that no route can ever be reached
  // unauthenticated — including one added later by someone who does not
  // know this hook exists. Both health paths are public: `/health/ready` as
  // well as `/health`, because a readiness probe cannot hold an operator
  // credential and an unauthenticated 401 would read to an orchestrator as
  // a permanently unready instance.
  registerAuthHook(app, { db, logger, publicPaths: ["/health", "/health/ready"] });

  registerHealthRoutes(app, db);
  registerWalletRoutes(app, db, client);
  registerLimitRoutes(app, db);
  registerLaunchRoute(app, db, { gameFrontendUrl });
  registerGamesRoute(app, db);

  app.setErrorHandler((err, _request, reply) => {
    // F7: a 4xx belongs to the client and flattening it to 500 destroys the
    // only signal they have to act on. The limiter is the case that proved
    // it — a 429 carrying a Retry-After was being rewritten to an opaque
    // internal error, so a limited client learned nothing and had no reason
    // to slow down.
    const clientError = err as { statusCode?: number; code?: string; message?: string };
    const status = clientError.statusCode ?? 500;

    if (status >= 400 && status < 500) {
      const code = clientError.code ?? (status === 429 ? "rate_limited" : "bad_request");
      return reply.code(status).send({ error: code, message: clientError.message });
    }

    // Log the detail, return nothing revealing: an internal error message
    // can disclose schema and code structure to a caller — and this
    // caller is outside the trust boundary entirely.
    logger.error({ err }, "unhandled request error");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
