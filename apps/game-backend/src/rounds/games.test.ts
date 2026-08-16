import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PICK_BONUS_GAME, REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../testing/fakeMongo.js";
import { GameNotFoundError, loadGameDefinition, seedReferenceGame } from "./games.js";

/**
 * Loading and seeding the game definitions a round is evaluated against.
 *
 * Two claims here are load-bearing and were reachable only through route
 * tests, so a failure named a route rather than the rule that broke.
 *
 * 1. **`loadGameDefinition` reads Mongo, never the compiled-in fixture.**
 *    That is what keeps "config over code" honest. If round logic could
 *    fall back to the imported constant, the running system would have a
 *    special path for one game and the claim that games are pure data would
 *    quietly stop being true — while every test still passed, because the
 *    fixture and the seeded document agree today.
 * 2. **`seedReferenceGame` never overwrites.** `$setOnInsert` means a real
 *    publish that advanced the version survives a restart. An unconditional
 *    re-seed would fight the `gameId_version_unique` index the moment
 *    anyone published a second version — and would silently revert a live
 *    game to its shipped defaults, which is a money-affecting change
 *    disguised as a restart.
 *
 * And one guard with a real blast radius: `pick-bonus-5x3` is a **test
 * instrument** with a 100% bonus trigger rate. Seeding it into production
 * would put a permanently-triggering bonus on the shelf. It is refused
 * there by two independent conditions, and both are tested separately
 * because either one alone would be a single point of failure.
 *
 * ## What these cannot establish
 *
 * That the seeded document satisfies the real collection's schema
 * validator — `fakeMongo` models none, which is F9's blind spot exactly.
 * Nor that `$setOnInsert` behaves as assumed under a real unique index;
 * that agreement is `fakeMongo.conformance.test.ts`'s territory.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Both guards read process.env at call time, so a leaked variable would
  // silently change a later test's meaning.
  process.env = { ...ORIGINAL_ENV };
});

describe("loadGameDefinition", () => {
  it("returns a published game's definition", async () => {
    const { db } = fakeMongo();
    await db.collection("games").insertOne({ ...REFERENCE_GAME, status: "published" });

    const definition = await loadGameDefinition(db, REFERENCE_GAME.gameId);

    assert.equal(definition.gameId, REFERENCE_GAME.gameId);
    assert.equal(definition.version, REFERENCE_GAME.version);
  });

  it("strips _id, which is Mongo's key and not part of a game definition", async () => {
    // The same shape as F16/F21. A leaked `_id` would ride along into the
    // evaluator and into anything that re-serialises the definition.
    const { db } = fakeMongo();
    await db.collection("games").insertOne({ ...REFERENCE_GAME, status: "published" });

    const definition = await loadGameDefinition(db, REFERENCE_GAME.gameId);

    assert.ok(!("_id" in definition), `_id leaked into the definition: ${Object.keys(definition)}`);
  });

  it("reads from the database, NOT from the compiled-in fixture", async () => {
    // The config-over-code claim, pinned. A document deliberately differing
    // from the shipped constant must come back as stored — if the loader
    // ever fell back to the import, this returns the fixture's value and
    // the difference is invisible everywhere else.
    const { db } = fakeMongo();
    await db.collection("games").insertOne({
      ...REFERENCE_GAME,
      status: "published",
      rtpTarget: 0.42,
    });

    const definition = await loadGameDefinition(db, REFERENCE_GAME.gameId);

    assert.equal(definition.rtpTarget, 0.42, "the stored value must win over the imported fixture");
    assert.notEqual(definition.rtpTarget, REFERENCE_GAME.rtpTarget);
  });

  it("refuses a game that exists but is not published", async () => {
    // A draft is not playable. Without the status filter, an in-progress
    // draft — deliberately un-simulated and un-gated — would be spinnable
    // for real money.
    const { db } = fakeMongo();
    await db.collection("games").insertOne({ ...REFERENCE_GAME, status: "draft" });

    await assert.rejects(
      () => loadGameDefinition(db, REFERENCE_GAME.gameId),
      GameNotFoundError,
    );
  });

  it("refuses a game id that does not exist at all", async () => {
    const { db } = fakeMongo();

    await assert.rejects(() => loadGameDefinition(db, "no-such-game"), GameNotFoundError);
  });

  it("throws a typed error, so the route can map it to 404 rather than 500", async () => {
    // The distinction the money path depends on: a missing game is the
    // caller's mistake, not the server's. A bare Error here becomes a 500
    // and tells a player nothing.
    const { db } = fakeMongo();

    await assert.rejects(
      () => loadGameDefinition(db, "no-such-game"),
      (err: unknown) => {
        assert.ok(err instanceof GameNotFoundError, "must be GameNotFoundError");
        assert.match((err as Error).message, /no-such-game/, "and must name the game");
        return true;
      },
    );
  });
});

describe("seedReferenceGame", () => {
  it("seeds the reference game into both games and gameVersions", async () => {
    const { db } = fakeMongo();

    await seedReferenceGame(db);

    const game = await db.collection("games").findOne({ gameId: REFERENCE_GAME.gameId });
    const version = await db
      .collection("gameVersions")
      .findOne({ gameId: REFERENCE_GAME.gameId, version: REFERENCE_GAME.version });

    assert.ok(game, "the game must be seeded");
    assert.ok(version, "and its version row alongside it, or rollback has nothing to return to");
  });

  it("never overwrites a game that has already been published past the fixture", async () => {
    // The property `$setOnInsert` exists for. A restart must not revert a
    // live game to its shipped defaults — that is a silent, money-affecting
    // change triggered by an operation nobody thinks of as a change.
    const { db } = fakeMongo();
    await db.collection("games").insertOne({
      ...REFERENCE_GAME,
      version: 7,
      rtpTarget: 0.42,
      status: "published",
    });

    await seedReferenceGame(db);

    const game = await db.collection("games").findOne({ gameId: REFERENCE_GAME.gameId });
    assert.equal(game?.version, 7, "a published version must survive a re-seed");
    assert.equal(game?.rtpTarget, 0.42, "and so must its tuned values");
  });

  it("is idempotent across repeated boots", async () => {
    // Every restart calls this. Running it twice must not duplicate a row,
    // or the `gameId_version_unique` index turns a restart into a crash.
    const { db } = fakeMongo();

    await seedReferenceGame(db);
    await seedReferenceGame(db);

    const games = await db.collection("games").find({ gameId: REFERENCE_GAME.gameId }).toArray();
    assert.equal(games.length, 1, "seeding twice must not create a second document");
  });

  describe("the pick-bonus test instrument", () => {
    it("is not seeded by default", async () => {
      // The safe default. `pick-bonus-5x3` triggers its bonus on every
      // spin, so its return is meaningless — it must never appear anywhere
      // it was not explicitly asked for.
      const { db } = fakeMongo();
      delete process.env.SEED_TEST_FIXTURES;

      await seedReferenceGame(db);

      const fixture = await db.collection("games").findOne({ gameId: PICK_BONUS_GAME.gameId });
      assert.equal(fixture, null, "a 100%-trigger bonus game must not seed itself by default");
    });

    it("is seeded when explicitly requested outside production", async () => {
      // The load check's bonus race needs it (item 6), so the flag must
      // actually work — a guard that refused everything would be safe and
      // useless.
      const { db } = fakeMongo();
      process.env.SEED_TEST_FIXTURES = "true";
      process.env.NODE_ENV = "test";

      await seedReferenceGame(db);

      const fixture = await db.collection("games").findOne({ gameId: PICK_BONUS_GAME.gameId });
      assert.ok(fixture, "the flag must enable the fixture where it is legitimate");
    });

    it("is refused in production even when the flag is set", async () => {
      // The second, independent condition. Someone setting
      // SEED_TEST_FIXTURES in a production environment — by copying a
      // compose file, say — must not get a permanently-triggering bonus.
      const { db } = fakeMongo();
      process.env.SEED_TEST_FIXTURES = "true";
      process.env.NODE_ENV = "production";

      await seedReferenceGame(db);

      const fixture = await db.collection("games").findOne({ gameId: PICK_BONUS_GAME.gameId });
      assert.equal(fixture, null, "production must refuse the instrument regardless of the flag");
    });

    it("still seeds the real reference game in production", async () => {
      // The guard must be narrow. Refusing the fixture must not also refuse
      // the game the platform actually ships.
      const { db } = fakeMongo();
      process.env.NODE_ENV = "production";

      await seedReferenceGame(db);

      const game = await db.collection("games").findOne({ gameId: REFERENCE_GAME.gameId });
      assert.ok(game, "the reference game must seed in every environment");
    });

    it("treats any value other than the exact string 'true' as off", async () => {
      // `SEED_TEST_FIXTURES=1` and `=yes` read as enabled to a human and
      // are not. Pinned so the comparison stays strict rather than being
      // "helpfully" loosened to a truthiness check, which would make the
      // flag fire on the string "false".
      const { db } = fakeMongo();
      process.env.NODE_ENV = "test";

      for (const value of ["1", "yes", "TRUE", "false", ""]) {
        process.env.SEED_TEST_FIXTURES = value;
        await seedReferenceGame(db);

        const fixture = await db.collection("games").findOne({ gameId: PICK_BONUS_GAME.gameId });
        assert.equal(fixture, null, `SEED_TEST_FIXTURES=${JSON.stringify(value)} must not enable the fixture`);
      }
    });
  });
});
