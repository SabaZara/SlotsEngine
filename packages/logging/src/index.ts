import { createRequire } from "node:module";
import pino, { type Logger } from "pino";

/**
 * Pretty output is a development nicety, and `pino-pretty` is a dev
 * dependency — so a container built with production dependencies only will
 * not have it. Deciding by `NODE_ENV` alone is the wrong test: a container
 * can perfectly reasonably run with `NODE_ENV=development` and still lack
 * the package, and pino throws at construction rather than degrading, which
 * takes the whole service down at boot over log formatting.
 *
 * Resolving it is the honest check — is the transport actually there.
 */
function prettyTransportAvailable(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/**
 * One logger factory for every service, so log shape stays consistent
 * across the platform.
 *
 * `redact` is not optional decoration: launch tokens and signatures pass
 * through these services constantly, and a token in a log file is a token
 * an operator's log aggregator now stores indefinitely.
 */
export function createLogger(service: string): Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "token",
        "*.token",
        "sessionToken",
        "*.sessionToken",
        "seed",
        "*.seed",
        "req.headers.authorization",
        "req.headers['x-service-signature']",
      ],
      censor: "[redacted]",
    },
    ...(prettyTransportAvailable()
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
      : {}),
  });
}

export type { Logger };
