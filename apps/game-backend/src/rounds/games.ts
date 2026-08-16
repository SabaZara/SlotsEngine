import type { Db } from "mongodb";
import type { GameDefinition } from "@slots-engine/shared-types";
import { FREE_SPINS_GAME, PICK_BONUS_GAME, REFERENCE_GAME } from "@slots-engine/math-engine";

export class GameNotFoundError extends Error {}

/**
 * Loads a game's definition from the database.
 *
 * Deliberately reads from Mongo rather than from the imported fixture, even
 * for the reference game. That is what keeps "config over code" honest: if
 * round logic could fall back to a compiled-in constant, the running system
 * would have a special path for one game and the claim that games are pure
 * data would quietly stop being true.
 */
export async function loadGameDefinition(db: Db, gameId: string): Promise<GameDefinition> {
  const doc = await db.collection("games").findOne({ gameId, status: "published" });
  if (!doc) throw new GameNotFoundError(`no published game '${gameId}'`);
  const { _id, ...definition } = doc;
  return definition as unknown as GameDefinition;
}

/**
 * Seeds the reference game on first boot, plus test fixtures when asked.
 *
 * Strictly non-overwriting: `$setOnInsert` means a real publish that has
 * advanced the version is never clobbered by a later restart. An
 * unconditional re-seed would fight the `gameId_version_unique` index the
 * moment anyone published a second version.
 */
export async function seedReferenceGame(db: Db): Promise<void> {
  await seedGame(db, REFERENCE_GAME);

  // Seeded unconditionally, unlike the pick fixture below, because it is a
  // real game rather than an instrument: tuned to a believable 0.95 and
  // fitted by simulation, so it passes the publish gate on its merits.
  // `free-spins-game.test.ts` is that gate run against the fixture itself.
  await seedGame(db, FREE_SPINS_GAME);

  // The pick-bonus fixture is a TEST INSTRUMENT, not a game: its bonus is
  // tuned to trigger constantly so the multi-step step race is reachable in
  // a few spins rather than a few hundred. That makes its return
  // meaningless, so it is seeded only behind an explicit flag and never in
  // production — a house with a permanently-triggering bonus on the shelf
  // is exactly the kind of thing that escapes into a real environment.
  if (process.env.SEED_TEST_FIXTURES === "true" && process.env.NODE_ENV !== "production") {
    await seedGame(db, PICK_BONUS_GAME);
  }
}

/**
 * Strictly non-overwriting: `$setOnInsert` means a real publish that has
 * advanced the version is never clobbered by a later restart. An
 * unconditional re-seed would fight the `gameId_version_unique` index the
 * moment anyone published a second version.
 */
async function seedGame(db: Db, game: GameDefinition): Promise<void> {
  await db.collection("games").updateOne(
    { gameId: game.gameId },
    { $setOnInsert: { ...game } },
    { upsert: true },
  );
  await db.collection("gameVersions").updateOne(
    { gameId: game.gameId, version: game.version },
    { $setOnInsert: { ...game } },
    { upsert: true },
  );
}
