import Fastify from "fastify";
import cors from "@fastify/cors";
import { createLogger } from "@slots-engine/logging";
import { applySchemas, connectMongo } from "@slots-engine/mongo-schemas";
import { loadServiceSecret } from "@slots-engine/service-auth";
import { assertStartupConfig } from "./startupGuards.js";
import { registerServiceAuth } from "./routes/serviceAuth.js";
import { registerRoundRoutes } from "./routes/rounds.js";
import { registerBonusRoutes } from "./routes/bonus.js";
import { registerLaunchTokenRoutes } from "./routes/launchTokens.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerSimulateRoutes } from "./routes/simulate.js";
import { registerHealthRoutes } from "./routes/health.js";
import { seedReferenceGame } from "./rounds/games.js";
import { sweepAbandonedSessions } from "./bonus/session.js";

const logger = createLogger("game-backend");
const PORT = Number(process.env.PORT ?? 9002);
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  // Guards first: refuse to start misconfigured, before anything binds a
  // port or touches data.
  assertStartupConfig();
  const serviceSecret = loadServiceSecret();

  const { client, db } = await connectMongo();
  await applySchemas(db);
  await seedReferenceGame(db);

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // CORS exists for exactly one route: `/public/games/:gameId`, which a
  // player's browser reads directly. It is scoped by a `hook`-time origin
  // check rather than applied blanket, because the internal API must never
  // become reachable from a page — those routes are signed, but a browser
  // being able to *attempt* them is a step closer than necessary.
  //
  // The allowed origins are explicit, never "*": this is the surface a real
  // player's browser talks to.
  const gameOrigins = (process.env.GAME_CORS_ORIGINS ?? "http://localhost:9104")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
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
      callback(null, { origin: gameOrigins, methods: ["GET"] });
    },
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
    // Log the detail, return nothing revealing: an internal error message
    // can disclose schema and code structure to a caller.
    logger.error({ err }, "unhandled request error");
    reply.code(500).send({ error: "internal_error" });
  });

  // In-process interval, appropriate at this scale: the sweep is a
  // conditional updateMany, so it is idempotent and harmless to run on
  // several instances at once.
  const sweep = setInterval(() => {
    sweepAbandonedSessions(db)
      .then((count) => {
        if (count > 0) logger.info({ count }, "swept abandoned bonus sessions");
      })
      .catch((err) => logger.error({ err }, "bonus sweep failed"));
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweep);
    // Close the server before the database: a request already in flight
    // still needs its transaction to finish.
    await app.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info(`game-backend listening on :${PORT}`);
}

main().catch((err) => {
  logger.error({ err }, "game-backend failed to start");
  process.exit(1);
});
