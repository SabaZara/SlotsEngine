/**
 * Boot-time refusals, following the pattern established in game-backend:
 * turn a configuration-discipline promise into a code guarantee. "We'll set
 * the encryption key in production" is a promise whose failure mode is a
 * service that looks healthy while being unable to authenticate anyone —
 * or, worse, one that boots and only fails on the first real operator
 * request, hours later, in a way that reads as the operator's fault.
 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];

  if (!env.MONGO_URI) {
    problems.push("MONGO_URI is required.");
  }

  if (!env.LAUNCH_TOKEN_SECRET || env.LAUNCH_TOKEN_SECRET.length < 32) {
    problems.push("LAUNCH_TOKEN_SECRET is required and must be at least 32 characters — this service mints launch tokens.");
  }

  // Checked for hex-ness and length here as well as in the secrets package,
  // and the duplication is deliberate: the package throws at first *use*,
  // which for a decrypt path means the first operator request rather than
  // boot. A key that is 63 characters because of a copy-paste truncation
  // should stop the deploy, not the first player's launch.
  const key = env.SECRETS_ENCRYPTION_KEY;
  if (!key) {
    problems.push("SECRETS_ENCRYPTION_KEY is required — operator credentials are encrypted at rest.");
  } else if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push("SECRETS_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).");
  }

  if (env.NODE_ENV === "production") {
    // Two secrets that are equal are one secret, and the blast radius of a
    // leak doubles. Only meaningful once real money is involved, matching
    // game-backend's treatment of the same pair.
    if (env.LAUNCH_TOKEN_SECRET && env.LAUNCH_TOKEN_SECRET === env.SECRETS_ENCRYPTION_KEY) {
      problems.push("LAUNCH_TOKEN_SECRET and SECRETS_ENCRYPTION_KEY must be different secrets.");
    }

    // A launch URL pointing at localhost in production means every player
    // is handed a link to their own machine. It fails obviously for the
    // player and silently for everyone watching a dashboard, since the
    // launch call itself returns 200.
    if (!env.GAME_FRONTEND_URL) {
      problems.push("GAME_FRONTEND_URL must be set in production — the default localhost value would be sent to real players.");
    }
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start:\n  - ${problems.join("\n  - ")}`);
  }
}
