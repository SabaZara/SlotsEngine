import { createLogger } from "@slots-engine/logging";
import { applySchemas, connectMongo } from "@slots-engine/mongo-schemas";
import { assertStartupConfig } from "./startupGuards.js";
import { buildApp } from "./app.js";

/**
 * Entry point: guards, connections, shutdown. The route and plugin
 * composition lives in `app.ts` so it can be built without binding a port —
 * see the note there about F6 and F7.
 *
 * Deliberately absent: **any demo-operator seeding.** The reference repo
 * boot-seeds one from environment variables, which is convenient locally
 * and was the source of a real defect there — until late in its life the
 * seed ran in every environment, so a production deployment silently gained
 * a live operator whose secret was regenerated and logged in plaintext on
 * every restart. Operators are created through the backoffice, which is
 * where credential issuance belongs and where it is audited. A local
 * developer who needs one runs the same API a real integrator would.
 */
const logger = createLogger("integration-api");
const PORT = Number(process.env.PORT ?? 9006);

async function main(): Promise<void> {
  // Guards first: refuse to start misconfigured, before anything binds a
  // port or touches data.
  assertStartupConfig();

  const { client, db } = await connectMongo();
  await applySchemas(db);

  const app = await buildApp({
    db,
    client,
    logger,
    rateLimitMax: Number(process.env.INTEGRATION_RATE_LIMIT ?? 300),
    gameFrontendUrl: process.env.GAME_FRONTEND_URL ?? "http://localhost:9104",
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    // Close the server before the database: a cash-in already in flight
    // still needs its transaction to finish.
    await app.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "integration-api listening");
}

main().catch((err) => {
  logger.error({ err }, "integration-api failed to start");
  process.exit(1);
});
