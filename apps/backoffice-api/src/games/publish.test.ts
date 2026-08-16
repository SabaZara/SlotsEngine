import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { draftFromPublished, type GameDraft } from "./drafts.js";
import { OFFICIAL_SIM_COUNT, PublishBlockedError, RTP_TOLERANCE, publishDraft } from "./publish.js";

/**
 * Publishing is the only thing that makes a draft edit playable, so the
 * properties worth pinning are about **what happens when it refuses**: a
 * publish that fails at any point must leave players on exactly the version
 * they were already playing.
 *
 * The RTP gate is the most valuable check in the backoffice. `rtpTarget` is
 * an intention; the simulation is a measurement, and the two disagreeing
 * means the paytable does not do what its author believes — a game that
 * quietly returns 130% loses money on every spin, and neither that nor 60%
 * looks wrong in a config file.
 *
 * These run the **real** 100k-spin simulation rather than a stub, which
 * costs about a second per publish. That is affordable and worth it: a
 * stubbed simulation would let the gate pass against numbers no game
 * actually produces, and the gate is the subject.
 *
 * The reference repo's `publish.test.ts` covers only pre-simulate rejection
 * paths, because its `publishDraft` calls out to game-backend and cannot
 * simulate without the live stack. This codebase runs the simulation
 * in-process (deliberately — see `simulateClient.ts`), so the whole path is
 * reachable here. That is a real difference between the two codebases, not
 * an oversight in theirs.
 *
 * What these cannot establish:
 *   - That the two writes are atomic. They are not: `gameVersions` and
 *     `games` are separate writes with no transaction, and `fakeMongo`
 *     models no rollback anyway. The ordering is what is testable, and the
 *     ordering is the mitigation — see the test naming it.
 *   - Behaviour under the real schema validator. F9's blind spot.
 */

const setup = () => {
  const { db } = fakeMongo();
  return db as never as Parameters<typeof publishDraft>[0];
};

/** A draft that publishes cleanly: the reference game, which is tuned to
 * land inside tolerance. */
const goodDraft = (overrides: Partial<GameDraft> = {}): GameDraft => ({
  ...draftFromPublished(REFERENCE_GAME, "designer-1"),
  ...overrides,
});

describe("the RTP gate", () => {
  it("publishes a game whose measured RTP matches its target", async () => {
    // Load-bearing: without a passing case, every refusal below would also
    // pass against a gate that refused everything.
    const db = setup();
    const { gameDef, simulation } = await publishDraft(db, goodDraft(), "designer-1");

    assert.equal(gameDef.status, "published");
    assert.ok(
      Math.abs(simulation.resultRtp - gameDef.rtpTarget) <= RTP_TOLERANCE,
      `measured ${simulation.resultRtp} against target ${gameDef.rtpTarget}`,
    );
  });

  it("refuses a game whose target is nowhere near what it actually returns", async () => {
    // The misconfiguration this gate exists for: a paytable that does not
    // do what its author declared. Claiming 0.50 while the maths returns
    // ~0.96 is a drift of ~0.46, far outside tolerance.
    const db = setup();

    await assert.rejects(
      () => publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1"),
      PublishBlockedError,
    );
  });

  it("refuses a game that returns far MORE than its target, not just less", async () => {
    // The gate compares `Math.abs(drift)`, and the absolute value is the
    // whole point: a game declaring 0.95 that actually returns ~1.30 loses
    // money on every spin. Dropping the `Math.abs` leaves a one-sided gate
    // that catches only the unplayable direction and waves the expensive
    // one through — a mutation that survived until this test existed.
    //
    // Declaring a target far ABOVE what the maths returns makes the drift
    // negative, which is the case a signed comparison misses.
    const db = setup();

    await assert.rejects(
      () => publishDraft(db, goodDraft({ rtpTarget: 1.4 }), "designer-1"),
      PublishBlockedError,
    );
    assert.equal(await db.collection("games").countDocuments({}), 0);
  });

  it("refuses rather than warning, leaving nothing published", async () => {
    // A warning in an admin UI is a warning someone clicks past at 6pm on a
    // Friday. The refusal has to be the whole outcome.
    const db = setup();

    await assert.rejects(() => publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1"));

    const live = await db.collection("games").findOne({ gameId: REFERENCE_GAME.gameId });
    assert.equal(live, null, "a refused publish must write no live game");
    assert.equal(await db.collection("gameVersions").countDocuments({}), 0);
  });

  it("names the measurement, the target and the drift in the refusal", async () => {
    // A designer who is refused needs to know which direction to move the
    // paytable. "Publish failed" sends them to the logs.
    const db = setup();

    const error = await publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1").catch((e) => e as Error);

    assert.match(error.message, /measured RTP/);
    assert.match(error.message, /0\.5/, "the target must appear");
    assert.match(error.message, /tolerance/);
  });

  it("carries the simulation report on the refusal, so the UI can show it", async () => {
    const db = setup();

    const error = (await publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1").catch(
      (e) => e,
    )) as PublishBlockedError;

    assert.ok(error.report, "the blocked error should carry its report");
    assert.equal(error.report.simCount, OFFICIAL_SIM_COUNT);
  });

  it("allows a deliberate override with force", async () => {
    // An escape hatch that is explicit and recorded, rather than a gate
    // someone disables in config.
    const db = setup();

    const { gameDef } = await publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1", { force: true });

    assert.equal(gameDef.status, "published");
    assert.equal(gameDef.rtpTarget, 0.5, "force publishes the target as declared, drift and all");
  });

  it("records that the tolerance was forced past, so the override is auditable", async () => {
    // An override nobody can find afterwards is indistinguishable from the
    // gate never having existed.
    const db = setup();

    await publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1", { force: true });

    const entry = await db.collection("auditLogs").findOne({ action: "game.publish" });
    assert.equal((entry?.diff as Record<string, unknown>)?.forcedPastRtpTolerance, true);
  });

  it("does not mark an ordinary publish as forced", async () => {
    // `force: true` on a game that would have passed anyway is not an
    // override, and logging it as one would make real overrides harder to
    // find.
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1", { force: true });

    const entry = await db.collection("auditLogs").findOne({ action: "game.publish" });
    assert.equal((entry?.diff as Record<string, unknown>)?.forcedPastRtpTolerance, undefined);
  });

  it("simulates at the lowest configured bet, so publishes stay comparable", async () => {
    // Fixed rather than "the first option", so reordering betOptions later
    // does not silently change what the gate measures.
    const db = setup();

    const { simulation } = await publishDraft(
      db,
      goodDraft({ betOptions: [500, 100, 1000] }),
      "designer-1",
    );

    assert.equal(simulation.betPerSpin, 100);
  });

  it("runs the official spin count, not a sample", async () => {
    const db = setup();
    const { simulation } = await publishDraft(db, goodDraft(), "designer-1");
    assert.equal(simulation.simCount, OFFICIAL_SIM_COUNT);
  });
});

describe("validation runs before anything else", () => {
  it("refuses an invalid draft without simulating or writing", async () => {
    // Order matters: validate, simulate, check, and only then touch the
    // live document. An invalid draft must not cost a 100k-spin run.
    const db = setup();

    await assert.rejects(() => publishDraft(db, goodDraft({ name: "" }), "designer-1"), /name/);

    assert.equal(await db.collection("games").countDocuments({}), 0);
    assert.equal(await db.collection("rtpSimulationRuns").countDocuments({}), 0);
  });

  it("is not bypassed by force", async () => {
    // `force` overrides the RTP judgement, not the structural checks. A
    // draft that cannot produce a coherent game must never publish.
    const db = setup();

    await assert.rejects(() => publishDraft(db, goodDraft({ name: "" }), "designer-1", { force: true }), /name/);
    assert.equal(await db.collection("games").countDocuments({}), 0);
  });
});

describe("versioning", () => {
  it("starts a game that has never been published at version 1", async () => {
    const db = setup();
    const { gameDef } = await publishDraft(db, goodDraft(), "designer-1");
    assert.equal(gameDef.version, 1);
  });

  it("increments from whatever is currently live", async () => {
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");
    const second = await publishDraft(db, goodDraft(), "designer-1");
    const third = await publishDraft(db, goodDraft(), "designer-1");

    assert.equal(second.gameDef.version, 2);
    assert.equal(third.gameDef.version, 3);
  });

  it("does not consume a version number on a refused publish", async () => {
    // A refused publish is not an event in the game's history. Burning a
    // version would leave a gap that looks like a missing snapshot.
    const db = setup();
    await publishDraft(db, goodDraft(), "designer-1");

    await assert.rejects(() => publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1"));

    const next = await publishDraft(db, goodDraft(), "designer-1");
    assert.equal(next.gameDef.version, 2, "the refused attempt must not have taken version 2");
  });

  it("keeps every version as an append-only snapshot", async () => {
    // A round records the gameVersion it ran under, so a version with no
    // snapshot is a round nobody can audit.
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");
    await publishDraft(db, goodDraft(), "designer-1");

    const snapshots = await db.collection("gameVersions").find({ gameId: REFERENCE_GAME.gameId }).toArray();
    assert.deepEqual(
      snapshots.map((s) => s.version).sort(),
      [1, 2],
      "publishing must add a snapshot, never replace one",
    );
  });

  it("leaves exactly one live game document however many times it publishes", async () => {
    // `games` is upserted by gameId: the live table holds the current
    // version, and history lives in gameVersions.
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");
    await publishDraft(db, goodDraft(), "designer-1");

    assert.equal(await db.collection("games").countDocuments({ gameId: REFERENCE_GAME.gameId }), 1);
    const live = await db.collection("games").findOne({ gameId: REFERENCE_GAME.gameId });
    assert.equal(live?.version, 2, "the live document must be the newest version");
  });

  it("writes the snapshot before the live game", async () => {
    // Deliberate ordering, and the only mitigation available without a
    // transaction: a live game whose version has no snapshot is
    // unauditable, whereas a snapshot with no live game is merely unused.
    // If only one of the two writes survives a crash, it must be this one.
    //
    // Asserted by observing the order the collections are first written,
    // which is what the code controls.
    const db = setup();
    const writes: string[] = [];
    const realCollection = db.collection.bind(db);
    (db as unknown as { collection: (name: string) => unknown }).collection = (name: string) => {
      const target = realCollection(name) as Record<string, unknown>;
      return new Proxy(target, {
        get(obj, prop) {
          const value = Reflect.get(obj, prop);
          if (typeof value === "function" && (prop === "insertOne" || prop === "updateOne")) {
            return (...args: unknown[]) => {
              writes.push(name);
              return (value as (...a: unknown[]) => unknown).apply(obj, args);
            };
          }
          return value;
        },
      });
    };

    await publishDraft(db, goodDraft(), "designer-1");

    assert.ok(
      writes.indexOf("gameVersions") < writes.indexOf("games"),
      `the snapshot must be written first, got ${writes.join(" -> ")}`,
    );
  });
});

describe("the published definition", () => {
  it("marks the game published and stamps who and when", async () => {
    const before = Date.now();
    const db = setup();

    const { gameDef } = await publishDraft(db, goodDraft(), "designer-7");

    assert.equal(gameDef.status, "published");
    assert.equal(gameDef.publishedByUserId, "designer-7");
    assert.ok(Date.parse(gameDef.publishedAt) >= before - 1000);
  });

  it("fills the optional fields a draft may omit", async () => {
    // A draft need not name a currency or a win rule; a published
    // definition must, because the evaluator and the UI both read them and
    // neither should be guessing.
    const db = setup();
    const draft = goodDraft();
    delete (draft as Partial<GameDraft>).currency;
    delete (draft as Partial<GameDraft>).mathEngineId;
    delete (draft as Partial<GameDraft>).paylineWinRule;

    const { gameDef } = await publishDraft(db, draft, "designer-1");

    assert.ok(gameDef.currency, "currency must be defaulted");
    assert.ok(gameDef.mathEngineId, "mathEngineId must be defaulted");
    assert.ok(gameDef.paylineWinRule, "paylineWinRule must be defaulted");
  });

  it("carries the draft's configuration through unchanged", async () => {
    const db = setup();
    const draft = goodDraft();

    const { gameDef } = await publishDraft(db, draft, "designer-1");

    assert.deepEqual(gameDef.symbols, draft.symbols);
    assert.deepEqual(gameDef.paylines, draft.paylines);
    assert.deepEqual(gameDef.betOptions, draft.betOptions);
    assert.equal(gameDef.rtpTarget, draft.rtpTarget);
  });
});

describe("the audit trail", () => {
  it("records the publish with both versions, so a change is traceable", async () => {
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");
    await publishDraft(db, goodDraft(), "designer-2");

    const entries = await db.collection("auditLogs").find({ action: "game.publish" }).toArray();
    assert.equal(entries.length, 2);

    const second = entries.find((e) => (e.diff as Record<string, unknown>).toVersion === 2);
    assert.equal((second?.diff as Record<string, unknown>).fromVersion, 1);
    assert.equal(second?.actorUserId, "designer-2");
  });

  it("records a first publish as coming from no previous version", async () => {
    // `null`, not `0` or absent: there genuinely was no prior version, and
    // that reads differently from "we do not know".
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");

    const entry = await db.collection("auditLogs").findOne({ action: "game.publish" });
    assert.equal((entry?.diff as Record<string, unknown>).fromVersion, null);
  });

  it("records the measured RTP alongside the target", async () => {
    // The pair is the point: either number alone cannot answer "was this
    // game shipped honestly".
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");

    const entry = await db.collection("auditLogs").findOne({ action: "game.publish" });
    const diff = entry?.diff as Record<string, unknown>;
    assert.equal(typeof diff.resultRtp, "number");
    assert.equal(diff.rtpTarget, REFERENCE_GAME.rtpTarget);
  });

  it("stores each simulation run against the version it justified", async () => {
    // The evidence for a publish decision has to be findable from the
    // version a player actually played. Two publishes rather than one:
    // hardcoding `gameVersion: 1` passes a single-publish test, and the
    // mutation survived until this covered a second version.
    const db = setup();

    await publishDraft(db, goodDraft(), "designer-1");
    await publishDraft(db, goodDraft(), "designer-1");

    const runs = await db.collection("rtpSimulationRuns").find({ gameId: REFERENCE_GAME.gameId }).toArray();

    assert.deepEqual(
      runs.map((r) => r.gameVersion).sort(),
      [1, 2],
      "each run must record the version it was run for",
    );
    assert.ok(runs.every((r) => r.simCount === OFFICIAL_SIM_COUNT));
  });

  it("writes no audit entry and no simulation run for a refused publish", async () => {
    const db = setup();

    await assert.rejects(() => publishDraft(db, goodDraft({ rtpTarget: 0.5 }), "designer-1"));

    assert.equal(await db.collection("auditLogs").countDocuments({}), 0);
    assert.equal(await db.collection("rtpSimulationRuns").countDocuments({}), 0);
  });
});
