import { createLogger } from "@slots-engine/logging";
import { applySchemas, connectMongo } from "@slots-engine/mongo-schemas";
import { ensureBucket, isStorageConfigured } from "@slots-engine/asset-storage";
import { buildApp } from "./app.js";
import { seedInitialAdmin } from "./auth/users.js";

const logger = createLogger("backoffice-api");
const PORT = Number(process.env.PORT ?? 9005);

/**
 * Boot-time refusals, same posture as game-backend: turn a configuration
 * promise into a code guarantee. A backoffice that starts with an unsigned
 * session secret is an admin panel anyone can mint a token for.
 */
function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  if (!env.MONGO_URI) problems.push("MONGO_URI is required.");
  if (!env.BACKOFFICE_JWT_SECRET || env.BACKOFFICE_JWT_SECRET.length < 32) {
    problems.push("BACKOFFICE_JWT_SECRET is required and must be at least 32 characters.");
  }
  if (env.NODE_ENV === "production" && !env.BACKOFFICE_CORS_ORIGINS) {
    problems.push("BACKOFFICE_CORS_ORIGINS must be set explicitly in production.");
  }
  if (problems.length > 0) {
    throw new Error(`backoffice-api refusing to start:\n  - ${problems.join("\n  - ")}`);
  }
}

async function main(): Promise<void> {
  assertStartupConfig();

  const { client, db } = await connectMongo();
  await applySchemas(db);

  /*
   * Created on every boot, not once — and the policy is cleared every time
   * rather than only at creation. A bucket that already exists from an
   * earlier deployment would otherwise keep whatever policy it had,
   * including a public-read one, forever: the "create if missing" branch
   * never runs again. That is the reference repo's own recorded mistake,
   * inherited as a fix rather than rediscovered.
   *
   * Non-fatal when storage is unconfigured or unreachable. Uploads are one
   * feature of this service, and refusing to boot over them would take the
   * whole backoffice down — the upload route reports `storage_not_configured`
   * on its own instead.
   */
  if (isStorageConfigured()) {
    try {
      await ensureBucket();
    } catch (err) {
      // `logger` rather than `app.log`: this runs before the Fastify
      // instance exists, and reaching for it here was a compile error.
      logger.error({ err }, "asset storage is configured but unreachable — uploads will fail");
    }
  }

  const seeded = await seedInitialAdmin(db);
  if (seeded.created) {
    logger.warn(
      { email: seeded.email },
      "seeded the initial administrator — change this password before exposing the backoffice",
    );
  }

  const app = await buildApp(db, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info(`backoffice-api listening on :${PORT}`);
}

main().catch((err) => {
  logger.error({ err }, "backoffice-api failed to start");
  process.exit(1);
});
