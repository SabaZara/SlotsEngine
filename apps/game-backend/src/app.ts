import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Db, MongoClient } from "mongodb";
import type { Logger } from "@slots-engine/logging";
import { registerServiceAuth } from "./routes/serviceAuth.js";
import { registerRoundRoutes } from "./routes/rounds.js";
import { registerBonusRoutes } from "./routes/bonus.js";
import { registerLaunchTokenRoutes } from "./routes/launchTokens.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerSimulateRoutes } from "./routes/simulate.js";
import { registerHealthRoutes } from "./routes/health.js";

/**
 * The service's composition, separated from `index.ts` so it can be built
 * without binding a port, connecting to Mongo, or starting an interval.
 *
 * This split matters more here than anywhere else in the repo: **F6 and F7
 * both happened in this file**, and both were composition bugs rather than
 * logic bugs. F6 was `void app.register(rateLimit, …)` in a synchronous
 * factory, which left every route unlimited because the plugin's `onRoute`
 * hook had not installed yet — no error, just requests returning 200 with no
 * protection. F7 was this error handler flattening the limiter's 429 into a
 * 500. Each individual piece was correct; the way they were assembled was
 * not, and nothing was positioned to notice.
 */
export interface BuildAppOptions {
  db: Db;
  client: MongoClient;
  serviceSecret: string;
  logger: Logger;
  /** Allowed origins for the one browser-facing route. */
  corsOrigins: string[];
  /** Requests per minute per key. */
  rateLimitMax: number;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, client, serviceSecret, logger, corsOrigins, rateLimitMax } = options;

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // CORS exists for exactly one route: `/public/games/:gameId`, which a
  // player's browser reads directly. It is scoped by a `hook`-time origin
  // check rather than applied blanket, because the internal API must never
  // become reachable from a page — those routes are signed, but a browser
  // being able to *attempt* them is a step closer than necessary.
  //
  // The allowed origins are explicit, never "*": this is the surface a real
  // player's browser talks to.
  await app.register(cors, {
    // Resolved per request against the path, so ONLY `/public/*` ever
    // receives an allow-origin header. Registering CORS globally would put
    // one on `/internal/*` responses too: those calls are still rejected
    // without a signature, but a page would then be able to *read* their
    // error bodies cross-origin, which hands a prober information for no
    // benefit. Delegating keeps the browser-reachable surface exactly the
    // one route that is meant to be browser-reachable.
    delegator: (request, callback) => {
      if (!request.url.startsWith("/public/")) {
        callback(null, { origin: false });
        return;
      }
      callback(null, { origin: corsOrigins, methods: ["GET"] });
    },
  });

  // Rate limiting, keyed by SURFACE rather than uniformly by IP.
  //
  // The two surfaces here need opposite treatment, and applying one policy
  // to both would be worse than applying none:
  //
  // `/public/*` is read by player browsers, so the client IP is a real
  // key and a per-IP ceiling is meaningful.
  //
  // `/internal/*` is reached only by game-socket, so EVERY request shares
  // one source address. An IP-keyed limit there does not throttle an
  // abuser — it throttles the entire platform the moment traffic is
  // healthy, turning a defence into an outage.
  //
  // So internal traffic is keyed by the CALLER HEADER, read straight off
  // the request. Note it is deliberately not `request.serviceCaller`, the
  // value the service-auth hook sets: the limiter runs at `onRequest` and
  // that hook is a `preHandler`, so the field is always still unset here.
  // Measured, not assumed — the first version of this used it and would
  // have silently keyed every internal call by IP, which is precisely the
  // outage described above.
  //
  // An unsigned request can of course put anything in that header, but it
  // is refused by service-auth moments later regardless; the header is
  // being used to separate healthy internal traffic into its own bucket,
  // not to make a trust decision. The per-player ceiling that would stop
  // one abusive account belongs in the socket, where identity is known.
  //
  // Health is exempt outright: a limiter that can fail a readiness probe
  // will eventually take a service out of rotation for being busy.
  //
  // `await`, not `void` — see F6. A synchronous factory that fires this off
  // without waiting leaves every route unlimited, silently.
  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const caller = request.headers["x-service-caller"];
      const name = Array.isArray(caller) ? caller[0] : caller;
      return name ? `svc:${name}` : `ip:${request.ip}`;
    },
    allowList: (request) => (request.url ?? "").startsWith("/health"),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Too many requests. Retry in ${context.after}.`,
    }),
  });

  // Registered before the routes so no internal route can ever be reached
  // unsigned, including one added later by someone who forgets this exists.
  registerServiceAuth(app, serviceSecret, logger);

  registerHealthRoutes(app, db);
  registerPublicRoutes(app, db);
  registerRoundRoutes(app, db, client);
  registerBonusRoutes(app, db, client);
  registerLaunchTokenRoutes(app, db);
  registerSimulateRoutes(app, db);

  app.setErrorHandler((err, _request, reply) => {
    // A client error is the client's to act on, and flattening it to 500
    // destroys the only signal it has. The rate limiter is the case that
    // proved this: it raises a 429 carrying a Retry-After, and this handler
    // was rewriting it into an opaque `internal_error` — so a limited
    // client learned nothing and had no reason to back off, which is most
    // of the point of limiting it.
    const clientError = err as { statusCode?: number; code?: string; message?: string };
    const status = clientError.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // 429 is named explicitly: the limiter raises an error carrying no
      // `code`, so it would otherwise be reported as a generic
      // `bad_request` — technically a 4xx, but it tells a client to fix its
      // request rather than to slow down, which is the opposite of useful.
      const code = clientError.code ?? (status === 429 ? "rate_limited" : "bad_request");
      return reply.code(status).send({ error: code, message: clientError.message });
    }

    // Log the detail, return nothing revealing: an internal error message
    // can disclose schema and code structure to a caller.
    logger.error({ err }, "unhandled request error");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
