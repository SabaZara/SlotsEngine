import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { blankDraft, draftFromPublished, getDraft, listDrafts, saveDraft, type GameDraft } from "./drafts.js";

/**
 * The structural promise this file pins: **a draft is not a
 * `GameDefinition`.** It carries no `version` and no `status`, because those
 * are facts about a publish rather than about an edit, and leaving them off
 * makes it impossible to edit a version number. Every test below that checks
 * for an absent field is checking that promise, not being pedantic.
 *
 * The second promise: editing a draft never changes what a player sees.
 * Publishing is the only thing that does.
 *
 * The reference repo's `drafts.test.ts` runs against real Mongo and covers
 * save-history and snapshot restore — neither of which exists here, since
 * this codebase has no draft history. What transfers is its shape: exercise
 * the real read/write path rather than the object in isolation.
 *
 * What these cannot establish: behaviour under the real schema validator.
 * `fakeMongo` models none, which is exactly the F9 blind spot.
 */

const setup = () => {
  const { db } = fakeMongo();
  return db as never as Parameters<typeof getDraft>[0];
};

describe("blankDraft", () => {
  it("produces a draft that is already valid, not an empty shell", () => {
    // A designer's first action should be editing something that works, not
    // discovering which twelve fields are mandatory.
    const draft = blankDraft("new-game", "New Game", "user-1");

    assert.equal(draft.gameId, "new-game");
    assert.equal(draft.name, "New Game");
    assert.ok(draft.symbols.length > 0, "a blank draft needs symbols to be playable");
    assert.ok(draft.paylines.length > 0, "a blank draft needs paylines");
    assert.ok(draft.betOptions.length > 0, "a blank draft needs bet options");
  });

  it("carries no version and no status", () => {
    // The structural promise. A draft that could hold a version would let
    // someone edit one.
    const draft = blankDraft("new-game", "New Game", "user-1") as unknown as Record<string, unknown>;

    assert.equal("version" in draft, false);
    assert.equal("status" in draft, false);
  });

  it("gives every reel a strip matching the declared grid", () => {
    // A grid claiming five reels with four strips is a game that cannot
    // spin, and the skeleton must not ship that.
    const draft = blankDraft("new-game", "New Game", "user-1");

    assert.equal(draft.reelStrips?.length, draft.grid.reels);
    for (const [index, strip] of (draft.reelStrips ?? []).entries()) {
      assert.equal(strip.reelIndex, index, "strips must be indexed in order");
      assert.ok(strip.symbols.length > 0);
    }
  });

  it("only uses symbols it has defined", () => {
    // A strip naming a symbol with no rule evaluates to nothing — a silent
    // dead position on the reel.
    const draft = blankDraft("new-game", "New Game", "user-1");
    const defined = new Set(draft.symbols.map((s) => s.symbol));

    for (const strip of draft.reelStrips ?? []) {
      for (const symbol of strip.symbols) {
        assert.ok(defined.has(symbol), `strip symbol ${symbol} has no rule`);
      }
    }
  });

  it("keeps every payline inside the grid", () => {
    const draft = blankDraft("new-game", "New Game", "user-1");

    for (const line of draft.paylines) {
      assert.equal(line.length, draft.grid.reels, "a payline must cover every reel");
      for (const row of line) {
        assert.ok(row >= 0 && row < draft.grid.rows, `row ${row} is outside a ${draft.grid.rows}-row grid`);
      }
    }
  });

  it("states bet options in integer minor units", () => {
    // Money is always integer minor units. A float here would propagate
    // into every bet the game ever offers.
    const draft = blankDraft("new-game", "New Game", "user-1");

    for (const bet of draft.betOptions) {
      assert.ok(Number.isInteger(bet), `bet option ${bet} is not an integer`);
      assert.ok(bet > 0, "a bet option must be positive");
    }
  });

  it("records who created it and when", () => {
    const before = Date.now();
    const draft = blankDraft("new-game", "New Game", "user-1");

    assert.equal(draft.updatedByUserId, "user-1");
    assert.ok(Number.isFinite(Date.parse(draft.updatedAt)));
    assert.ok(Date.parse(draft.updatedAt) >= before - 1000);
  });

  it("sets an RTP target inside a believable range", () => {
    // A skeleton that starts at 0 or 2.0 would be refused by the publish
    // gate for a reason the designer did not choose.
    const draft = blankDraft("new-game", "New Game", "user-1");
    assert.ok(draft.rtpTarget > 0.5 && draft.rtpTarget < 1, `rtpTarget ${draft.rtpTarget}`);
  });
});

describe("saveDraft and getDraft", () => {
  it("round-trips a draft through the database", async () => {
    const db = setup();
    const draft = blankDraft("game-1", "Game One", "user-1");

    await saveDraft(db, draft);
    const loaded = await getDraft(db, "game-1");

    assert.equal(loaded?.gameId, "game-1");
    assert.equal(loaded?.name, "Game One");
    assert.deepEqual(loaded?.symbols, draft.symbols);
  });

  it("returns null for a game with no draft", async () => {
    assert.equal(await getDraft(setup(), "no-such-game"), null);
  });

  it("stamps updatedAt on every save, so it reflects the write not the object", async () => {
    // The caller's `updatedAt` is deliberately overwritten: it records when
    // the draft was *stored*, and trusting a client-supplied timestamp
    // would let a stale editor claim to be current.
    const db = setup();
    const draft = { ...blankDraft("game-1", "Game One", "user-1"), updatedAt: "2020-01-01T00:00:00.000Z" };

    const saved = await saveDraft(db, draft);

    assert.notEqual(saved.updatedAt, "2020-01-01T00:00:00.000Z");
    assert.ok(Date.parse(saved.updatedAt) > Date.parse("2020-01-01T00:00:00.000Z"));
  });

  it("returns the draft as stored, not as handed in", async () => {
    const db = setup();
    const draft = blankDraft("game-1", "Game One", "user-1");

    const saved = await saveDraft(db, draft);
    const loaded = await getDraft(db, "game-1");

    assert.equal(loaded?.updatedAt, saved.updatedAt);
  });

  it("overwrites an existing draft rather than creating a second", async () => {
    // Upsert keyed on gameId. Two drafts for one game would make "the
    // draft" ambiguous, and whichever the read happened to return would win.
    const db = setup();
    await saveDraft(db, blankDraft("game-1", "First Name", "user-1"));
    await saveDraft(db, { ...blankDraft("game-1", "Second Name", "user-2") });

    assert.equal((await getDraft(db, "game-1"))?.name, "Second Name");
    assert.equal((await listDrafts(db)).length, 1);
  });

  it("keeps drafts for different games separate", async () => {
    const db = setup();
    await saveDraft(db, blankDraft("game-1", "Game One", "user-1"));
    await saveDraft(db, blankDraft("game-2", "Game Two", "user-1"));

    assert.equal((await getDraft(db, "game-1"))?.name, "Game One");
    assert.equal((await getDraft(db, "game-2"))?.name, "Game Two");
  });

  it("does not leak _id into the returned draft", async () => {
    // Same class as F16 — and worth checking here because a draft is round
    // -tripped through the editor, so a stray `_id` would be sent back on
    // the next save.
    const db = setup();
    await saveDraft(db, blankDraft("game-1", "Game One", "user-1"));

    const loaded = (await getDraft(db, "game-1")) as unknown as Record<string, unknown>;
    assert.equal(loaded._id, undefined);
  });
});

describe("listDrafts", () => {
  it("returns an empty list rather than throwing when there are none", async () => {
    assert.deepEqual(await listDrafts(setup()), []);
  });

  it("returns a summary only, not the whole draft", async () => {
    // The list view needs three fields; sending entire reel strips for
    // every game is a payload nobody reads.
    const db = setup();
    await saveDraft(db, blankDraft("game-1", "Game One", "user-1"));

    const [summary] = await listDrafts(db);

    assert.deepEqual(Object.keys(summary).sort(), ["gameId", "name", "updatedAt"]);
  });

  it("lists most recently updated first", async () => {
    const db = setup();
    await saveDraft(db, blankDraft("game-1", "Game One", "user-1"));
    await saveDraft(db, blankDraft("game-2", "Game Two", "user-1"));
    // Distinct timestamps forced rather than relying on the clock ticking
    // between two writes.
    await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
      .collection("gameDrafts")
      .updateOne({ gameId: "game-1" }, { $set: { updatedAt: "2026-01-01T00:00:00.000Z" } });

    const listed = await listDrafts(db);

    assert.deepEqual(
      listed.map((d) => d.gameId),
      ["game-2", "game-1"],
    );
  });
});

describe("draftFromPublished", () => {
  it("copies the published game's playable configuration", () => {
    // The natural way to edit a live game is to start from what is actually
    // live, not from a blank.
    const draft = draftFromPublished(REFERENCE_GAME, "user-1");

    assert.equal(draft.gameId, REFERENCE_GAME.gameId);
    assert.equal(draft.name, REFERENCE_GAME.name);
    assert.deepEqual(draft.grid, REFERENCE_GAME.grid);
    assert.deepEqual(draft.symbols, REFERENCE_GAME.symbols);
    assert.deepEqual(draft.paylines, REFERENCE_GAME.paylines);
    assert.equal(draft.rtpTarget, REFERENCE_GAME.rtpTarget);
    assert.deepEqual(draft.betOptions, REFERENCE_GAME.betOptions);
  });

  it("drops version and status, so neither can be edited", () => {
    // The structural promise again, and the direction that matters most:
    // this is the one path where a `GameDefinition` — which HAS both fields
    // — becomes a draft. A spread would carry them straight through.
    const draft = draftFromPublished(REFERENCE_GAME, "user-1") as unknown as Record<string, unknown>;

    assert.equal("version" in draft, false, "a draft must not carry a version");
    assert.equal("status" in draft, false, "a draft must not carry a status");
  });

  it("records the editor rather than whoever published it", () => {
    const draft = draftFromPublished(REFERENCE_GAME, "editor-7");
    assert.equal(draft.updatedByUserId, "editor-7");
  });

  it("stamps updatedAt as now, not as the publish time", () => {
    const before = Date.now();
    const draft = draftFromPublished(REFERENCE_GAME, "user-1");
    assert.ok(Date.parse(draft.updatedAt) >= before - 1000);
  });

  it("omits optional fields the published game does not have", () => {
    // Written as conditional spreads so an absent field stays absent rather
    // than becoming an explicit `undefined` — which survives into the
    // database as a stored null and reads as "deliberately cleared".
    const withoutOptionals = {
      ...REFERENCE_GAME,
      currency: undefined,
      mathEngineId: undefined,
      paylineWinRule: undefined,
      symbolWeights: undefined,
    } as unknown as typeof REFERENCE_GAME;

    const draft = draftFromPublished(withoutOptionals, "user-1") as unknown as Record<string, unknown>;

    assert.equal("currency" in draft, false);
    assert.equal("mathEngineId" in draft, false);
    assert.equal("paylineWinRule" in draft, false);
    assert.equal("symbolWeights" in draft, false);
  });

  it("keeps optional fields the published game does have", () => {
    const draft = draftFromPublished(REFERENCE_GAME, "user-1");

    if (REFERENCE_GAME.currency !== undefined) assert.equal(draft.currency, REFERENCE_GAME.currency);
    if (REFERENCE_GAME.paylineWinRule !== undefined) {
      assert.equal(draft.paylineWinRule, REFERENCE_GAME.paylineWinRule);
    }
  });

  it("round-trips through the database unchanged", async () => {
    // The realistic flow: edit a live game, save, reload. Anything the
    // conversion produces that Mongo cannot store round-trips wrong here.
    const db = setup();
    const draft = draftFromPublished(REFERENCE_GAME, "user-1");

    await saveDraft(db, draft);
    const loaded = await getDraft(db, REFERENCE_GAME.gameId);

    assert.deepEqual(loaded?.symbols, draft.symbols);
    assert.deepEqual(loaded?.paylines, draft.paylines);
    assert.equal((loaded as unknown as Record<string, unknown>).version, undefined);
  });
});
