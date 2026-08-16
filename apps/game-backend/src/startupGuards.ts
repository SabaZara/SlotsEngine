/**
 * Boot-time refusals.
 *
 * The pattern here is worth stating explicitly, because it is applied
 * throughout this codebase: turn a configuration-discipline promise into a
 * code guarantee. "We'll set the secret in production" is a promise; a
 * process that will not start without one is a guarantee. The failure mode
 * of the promise is a service that looks perfectly healthy while being
 * wide open, and nobody notices until it is exploited.
 *
 * Every check below therefore throws rather than warning. A service that
 * refuses to boot gets fixed in minutes; a service that boots insecurely
 * can stay that way for months.
 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];

  if (!env.MONGO_URI) {
    problems.push("MONGO_URI is required.");
  }

  if (!env.SERVICE_AUTH_SECRET || env.SERVICE_AUTH_SECRET.length < 32) {
    problems.push("SERVICE_AUTH_SECRET is required and must be at least 32 characters — internal routes are authenticated.");
  }

  if (!env.LAUNCH_TOKEN_SECRET || env.LAUNCH_TOKEN_SECRET.length < 32) {
    problems.push("LAUNCH_TOKEN_SECRET is required and must be at least 32 characters.");
  }

  if (env.NODE_ENV === "production") {
    // Guards that only matter once real money is involved.
    if (env.SERVICE_AUTH_SECRET === env.LAUNCH_TOKEN_SECRET) {
      problems.push("SERVICE_AUTH_SECRET and LAUNCH_TOKEN_SECRET must be different secrets.");
    }
    // Both directions are refused, and the pair is the point.
    //
    // A positive value grants free money to every new player. But refusing
    // only that left the guard satisfied by an UNSET variable, which used to
    // mean the ledger's own 100_000 default — so the one configuration this
    // guard pushed an operator toward was the one that still handed out free
    // money (item H). The ledger now defaults to 0, and requiring the value
    // explicitly means nobody has to know that to be safe: the starting
    // balance in production is a decision someone wrote down.
    if (env.INITIAL_PLAYER_BALANCE === undefined || env.INITIAL_PLAYER_BALANCE === "") {
      problems.push(
        "INITIAL_PLAYER_BALANCE must be set explicitly in production — use 0 unless new players are " +
          "deliberately funded, so the starting balance is a recorded decision rather than a default.",
      );
    } else if (Number(env.INITIAL_PLAYER_BALANCE) > 0) {
      problems.push(
        "INITIAL_PLAYER_BALANCE grants free balance to every new player and must not be positive in production.",
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`game-backend refusing to start:\n  - ${problems.join("\n  - ")}`);
  }
}
