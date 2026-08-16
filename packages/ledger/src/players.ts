import type { Db } from "mongodb";

/**
 * Starting balance for a player seen for the first time.
 *
 * **Defaults to zero.** In a real deployment a player's balance arrives via
 * a cash-in from the operator, so granting anything by default is granting
 * free money — and the safe direction for a money-path default is the one
 * where forgetting to configure it costs nothing.
 *
 * This used to default to 100_000, which quietly contradicted the comment
 * sitting above it and defeated the boot guard next door:
 * `assertStartupConfig` refuses `INITIAL_PLAYER_BALANCE` in production when
 * it is set to a positive value, so the one configuration it pushed an
 * operator toward — leaving it unset — was the one that still handed out
 * 100,000 minor units to every new player. Recorded as item H in
 * docs/TODO.md when the guard's tests were written.
 *
 * Local development is unaffected: `infra/docker-compose.yml` already passes
 * `${INITIAL_PLAYER_BALANCE:-100000}` explicitly.
 *
 * Read per call rather than captured at module load, so a test can set it
 * without controlling import order.
 */
function initialBalance(): number {
  const configured = Number(process.env.INITIAL_PLAYER_BALANCE ?? 0);
  // A non-numeric value must not become NaN in a `$setOnInsert` — that
  // writes a NaN balance, and every later comparison against it is false, so
  // the player can neither bet nor be seen to have nothing.
  //
  // `isFinite` is redundant against `> 0` alone (NaN > 0 is false, so junk
  // already falls through to 0) and removing it survives every test here.
  // Kept deliberately: it states the intent at the point of the check rather
  // than relying on a NaN comparison rule, on a line where the failure mode
  // is a corrupted balance.
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0;
}

/**
 * Creates the player document if it doesn't exist yet, leaving an existing
 * balance untouched. `$setOnInsert` rather than a find-then-insert, so two
 * concurrent first spins can't both create the player — the unique
 * `(operatorId, playerId)` index arbitrates and the loser is a no-op.
 */
export async function ensurePlayer(db: Db, operatorId: string, playerId: string): Promise<void> {
  await db.collection("players").updateOne(
    { operatorId, playerId },
    { $setOnInsert: { operatorId, playerId, balance: initialBalance(), updatedAt: new Date() } },
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
