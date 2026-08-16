import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Db } from "mongodb";
import type { Logger } from "@slots-engine/logging";
import { registerAuthHook } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerHealthRoutes } from "./routes/health.js";

/**
 * Builds the app without binding a port, so tests can drive it through
 * `app.inject()` against a real route table rather than by calling handlers
 * directly — the auth hook and role guards are part of what needs testing,
 * and calling a handler in isolation skips exactly those.
 */
export function buildApp(db: Db, logger: Logger): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 4_000_000 });

  // Fastify rejects a JSON content-type with an empty body as a 400 before
  // any handler runs. Several routes here legitimately take no body
  // (logout, publish with no options), and an ordinary client that sets a
  // JSON content-type by default would have those calls fail with a
  // confusing parse error rather than doing anything. An empty body on such
  // a route means "no fields", so it is parsed as exactly that.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const raw = (body as string).trim();
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      // A malformed body is still a client error — only *absent* is benign.
      // Both `statusCode` and Fastify's own `FST_ERR_CTP_INVALID_JSON_BODY`
      // code are set: the custom error handler below would otherwise
      // flatten this to a 500 and report a client's typo as a server fault.
      done(
        Object.assign(new Error("invalid JSON body"), {
          statusCode: 400,
          code: "FST_ERR_CTP_INVALID_JSON_BODY",
        }),
        undefined,
      );
    }
  });

  // The browser origin the admin UI is served from. Defaulted for local
  // development, but never `*`: these routes carry a bearer token, and a
  // wildcard origin on an authenticated admin API invites any page the
  // user visits to call it on their behalf.
  const origins = (process.env.BACKOFFICE_CORS_ORIGINS ?? "http://localhost:9104")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  void app.register(cors, { origin: origins, credentials: true });

  // Registered before the routes, so a route added later cannot
  // accidentally be public — it has to opt out via PUBLIC_PATHS.
  registerAuthHook(app, db);

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, db);
  registerGameRoutes(app, db);
  registerUserRoutes(app, db);
  registerAuditRoutes(app, db);

  app.setErrorHandler((rawError, _request, reply) => {
    // A client error is the client's to fix — reporting a malformed body or
    // an oversized payload as a 500 sends someone hunting a server fault
    // that doesn't exist.
    const err = rawError as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.code ?? "bad_request", message: err.message });
    }
    logger.error({ err }, "unhandled request error");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
