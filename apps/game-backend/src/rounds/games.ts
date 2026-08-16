import type { Db } from "mongodb";
import type { GameDefinition } from "@slots-engine/shared-types";
import { REFERENCE_GAME } from "@slots-engine/math-engine";

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
 * Seeds the reference game on first boot.
 *
 * Strictly non-overwriting: `$setOnInsert` means a real publish that has
 * advanced the version is never clobbered by a later restart. An
 * unconditional re-seed would fight the `gameId_version_unique` index the
 * moment anyone published a second version.
 */
export async function seedReferenceGame(db: Db): Promise<void> {
  await db.collection("games").updateOne(
    { gameId: REFERENCE_GAME.gameId },
    { $setOnInsert: { ...REFERENCE_GAME } },
    { upsert: true },
  );
  await db.collection("gameVersions").updateOne(
    { gameId: REFERENCE_GAME.gameId, version: REFERENCE_GAME.version },
    { $setOnInsert: { ...REFERENCE_GAME } },
    { upsert: true },
  );
}
