import type { Db } from "mongodb";

/**
 * Starting balance for a player seen for the first time. A development
 * convenience only: in a real deployment a player's balance arrives via a
 * cash-in from the operator, and this default would be zero.
 */
const INITIAL_BALANCE = Number(process.env.INITIAL_PLAYER_BALANCE ?? 100_000);

/**
 * Creates the player document if it doesn't exist yet, leaving an existing
 * balance untouched. `$setOnInsert` rather than a find-then-insert, so two
 * concurrent first spins can't both create the player — the unique
 * `(operatorId, playerId)` index arbitrates and the loser is a no-op.
 */
export async function ensurePlayer(db: Db, operatorId: string, playerId: string): Promise<void> {
  await db.collection("players").updateOne(
    { operatorId, playerId },
    { $setOnInsert: { operatorId, playerId, balance: INITIAL_BALANCE, updatedAt: new Date() } },
    { upsert: true },
  );
}

/** Integer minor units. Returns 0 for an unknown player rather than
 * throwing — a balance query is a read, and "no player" and "no money" are
 * the same answer to a caller. */
export async function getBalance(db: Db, operatorId: string, playerId: string): Promise<number> {
  const player = await db.collection("players").findOne({ operatorId, playerId });
  return (player?.balance as number | undefined) ?? 0;
}
