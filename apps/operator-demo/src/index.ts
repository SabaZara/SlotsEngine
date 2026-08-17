import { createIntegrationClient } from "./client.js";
import { buildApp } from "./app.js";

/**
 * Entry point.
 *
 * **The credentials come from the backoffice, not from a seed.** There is
 * deliberately no fallback default here: the reference repo defaults its
 * demo operator's secret to a fixed string and boot-seeds a matching
 * operator, which is convenient until that seed runs somewhere real. This
 * refuses to start instead, and the error says where to get the values.
 *
 * That refusal is the same posture as every other service in this repo:
 * turn a configuration promise into a code guarantee. A demo that starts
 * with placeholder credentials and fails on the first click teaches nothing
 * about why it failed.
 */
const PORT = Number(process.env.PORT ?? 9008);
const INTEGRATION_API_URL = process.env.INTEGRATION_API_URL ?? "http://localhost:9107";
const OPERATOR_ID = process.env.OPERATOR_ID ?? "demo";
const TOP_UP_AMOUNT = Number(process.env.DEMO_TOPUP_AMOUNT ?? 100_000);

function requireCredentials(): { apiKeyId: string; apiSecret: string } {
  const apiKeyId = process.env.OPERATOR_API_KEY_ID;
  const apiSecret = process.env.OPERATOR_API_SECRET;

  if (!apiKeyId || !apiSecret) {
    throw new Error(
      "operator-demo refusing to start: OPERATOR_API_KEY_ID and OPERATOR_API_SECRET are required.\n" +
        "  Create an operator in the backoffice (Operators → Add an operator). The secret is shown\n" +
        "  exactly once, on creation — copy it then. Grant it at least one PUBLISHED game before\n" +
        "  launching, or /v1/launch will refuse with game_not_enabled_for_operator.",
    );
  }
  return { apiKeyId, apiSecret };
}

async function main(): Promise<void> {
  const credentials = requireCredentials();

  if (!Number.isInteger(TOP_UP_AMOUNT) || TOP_UP_AMOUNT <= 0) {
    // Money is always integer minor units in this codebase. A float here
    // would be refused by the wallet route with a 400 that reads as a demo
    // bug rather than as a misconfiguration.
    throw new Error(`operator-demo refusing to start: DEMO_TOPUP_AMOUNT must be a positive integer, got ${TOP_UP_AMOUNT}`);
  }

  const client = createIntegrationClient({ baseUrl: INTEGRATION_API_URL, credentials });
  const app = buildApp({ client, operatorId: OPERATOR_ID, topUpAmount: TOP_UP_AMOUNT });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`operator-demo listening on :${PORT}, signing as ${OPERATOR_ID} against ${INTEGRATION_API_URL}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
