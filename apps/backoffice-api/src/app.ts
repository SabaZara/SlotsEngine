import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "mongodb";
import type { Logger } from "@slots-engine/logging";
import { registerAuthHook } from "./auth/middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerOperatorRoutes } from "./routes/operators.js";
import { registerReportRoutes } from "./reports/routes.js";
import { registerHealthRoutes } from "./routes/health.js";

/**
 * Builds the app without binding a port, so tests can drive it through
 * `app.inject()` against a real route table rather than by calling handlers
 * directly — the auth hook and role guards are part of what needs testing,
 * and calling a handler in isolation skips exactly those.
 */
export async function buildApp(db: Db, logger: Logger): Promise<FastifyInstance> {
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

  // A global ceiling, generous enough that ordinary admin work never
  // notices it. The point is not to shape traffic — it is that an
  // authenticated admin API with no ceiling at all can be walked by a
  // script at whatever rate the network allows.
  //
  // Keyed by IP, which is the right key HERE (unlike the internal API,
  // where every request legitimately arrives from one service) because
  // these routes are reached directly by a browser.
  //
  // AWAITED, not fire-and-forget. The limiter installs an `onRoute` hook,
  // so any route registered before it finishes is silently left unlimited
  // — and "silently" is the problem: `void app.register(...)` here produced
  // an app where neither the global nor the per-route limit applied at all,
  // while every request still returned 200. Nothing failed; the protection
  // simply was not there. That is why this function is async.
  //
  // Disabled when DISABLE_RATE_LIMIT is set, which the test suite does:
  // it drives hundreds of requests through app.inject() from one synthetic
  // address, and a limiter tripping mid-suite would look exactly like a
  // broken route. An explicit flag rather than a NODE_ENV check, because
  // the suite does not set NODE_ENV and a limit that happens to stay
  // untripped is luck, not a decision.
  if (process.env.DISABLE_RATE_LIMIT !== "true") {
    await app.register(rateLimit, {
      global: true,
      max: Number(process.env.BACKOFFICE_RATE_LIMIT ?? 300),
      timeWindow: "1 minute",
      // 429 with a Retry-After, rather than the default 500-shaped error.
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: "rate_limited",
        message: `Too many requests. Retry in ${context.after}.`,
      }),
    });
  }

  // Registered before the routes, so a route added later cannot
  // accidentally be public — it has to opt out via PUBLIC_PATHS.
  registerAuthHook(app, db);

  registerHealthRoutes(app, db);
  registerAuthRoutes(app, db);
  registerGameRoutes(app, db);
  registerUserRoutes(app, db);
  registerAuditRoutes(app, db);
  registerOperatorRoutes(app, db);
  registerReportRoutes(app, db);

  app.setErrorHandler((rawError, _request, reply) => {
    // A client error is the client's to fix — reporting a malformed body or
    // an oversized payload as a 500 sends someone hunting a server fault
    // that doesn't exist.
    const err = rawError as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // 429 named explicitly: the limiter's error carries no `code`, and
      // reporting it as `bad_request` tells a client to fix its request
      // when what it needs to do is wait.
      const code = err.code ?? (status === 429 ? "rate_limited" : "bad_request");
      return reply.code(status).send({ error: code, message: err.message });
    }
    logger.error({ err }, "unhandled request error");
    return reply.code(500).send({ error: "internal_error" });
  });

  return app;
}
