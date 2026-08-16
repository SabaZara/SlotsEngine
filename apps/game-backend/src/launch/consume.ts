import type { Db } from "mongodb";

export class LaunchTokenAlreadyUsedError extends Error {}

/**
 * Marks a launch token consumed, exactly once.
 *
 * The insert IS the check. A read-then-insert would let two simultaneous
 * JOINs both observe an unused token and both proceed — the unique index on
 * `jti` decides the race instead, and the loser is told the token is spent.
 * This is the same "insert and let a unique index arbitrate" idiom the
 * ledger uses for money.
 *
 * `expireAt` drives a TTL index: there is no point remembering a token past
 * the moment it would fail its own expiry check anyway.
 */
export async function consumeLaunchToken(db: Db, jti: string, expiresAt: number): Promise<void> {
  try {
    await db.collection("usedLaunchTokens").insertOne({ jti, expireAt: new Date(expiresAt) });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
      throw new LaunchTokenAlreadyUsedError(`launch token '${jti}' has already been used`);
    }
    throw err;
  }
}
