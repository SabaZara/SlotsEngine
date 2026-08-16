import { createLogger } from "@slots-engine/logging";
import { applySchemas, connectMongo } from "@slots-engine/mongo-schemas";
import { loadServiceSecret } from "@slots-engine/service-auth";
import { assertStartupConfig } from "./startupGuards.js";
import { buildApp } from "./app.js";
import { seedReferenceGame } from "./rounds/games.js";
import { sweepAbandonedSessions } from "./bonus/session.js";

/**
 * Entry point: guards, connections, the sweep interval and shutdown. The
 * route and plugin composition lives in `app.ts` so it can be built without
 * binding a port — see the note there about F6 and F7 both being assembly
 * bugs in this file.
 */
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

  const app = await buildApp({
    db,
    client,
    serviceSecret,
    logger,
    corsOrigins: (process.env.GAME_CORS_ORIGINS ?? "http://localhost:9104")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    rateLimitMax: Number(process.env.GAME_RATE_LIMIT ?? 600),
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
