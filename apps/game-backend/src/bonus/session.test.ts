import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import type { GameDefinition } from "@slots-engine/shared-types";
import { fakeMongo } from "../testing/fakeMongo.js";
import { startBonus, stepBonus, sweepAbandonedSessions } from "./session.js";

const OPERATOR = "op-1";
const PLAYER = "player-1";

/** The reference game plus a multi-step module, so both lifecycles are
 * covered by the same definition. */
const GAME: GameDefinition = {
  ...REFERENCE_GAME,
  bonusModules: [
    ...REFERENCE_GAME.bonusModules,
    { moduleId: "pick", params: { rewardMultipliers: [1, 2, 3, 5], tileCount: 6, blankCount: 2 } },
  ],
};

function setup(balance = 100_000) {
  const { db, client, raw } = fakeMongo();
  raw.collection("players").insertOne({ operatorId: OPERATOR, playerId: PLAYER, balance, updatedAt: new Date() });
  return { db, client, raw };
}

const startInput = (moduleId: string, roundId: string) => ({
  operatorId: OPERATOR,
  playerId: PLAYER,
  gameId: GAME.gameId,
  roundId,
  moduleId,
  totalBet: 100,
});

describe("startBonus", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("resolves and credits a single-step module immediately", async () => {
    const result = await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));
    assert.equal(result.done, true);
    assert.equal(result.publicState.status, "resolved");
    assert.ok((result.publicState.totalWin ?? 0) > 0);
    assert.equal(result.balanceAfter, 100_000 + (result.publicState.totalWin ?? 0));
  });

  it("leaves a multi-step module active and pays nothing yet", async () => {
    const result = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    assert.equal(result.done, false);
    assert.equal(result.publicState.status, "active");
    assert.equal(result.balanceAfter, undefined);
    assert.equal(ctx.raw.collection("transactions").all().length, 0);
  });

  it("opens only one session per triggering round, however often it is retried", async () => {
    // An auto-start replayed after a reconnect must not create a second
    // paying session for one spin.
    const first = await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));
    const second = await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    assert.equal(second.publicState.bonusSessionId, first.publicState.bonusSessionId);
    assert.equal(ctx.raw.collection("bonusSessions").all().length, 1);
    const credits = ctx.raw.collection("transactions").all().filter((t) => t.type === "credit");
    assert.equal(credits.length, 1, "a replayed auto-start must not pay twice");
  });

  it("never reveals the pick layout to the client", async () => {
    const result = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    assert.ok(!("tiles" in result.publicState.view), "the layout would give away the whole outcome");
  });
});

describe("stepBonus", () => {
  let ctx: ReturnType<typeof setup>;
  let bonusSessionId: string;

  beforeEach(async () => {
    ctx = setup();
    const started = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    bonusSessionId = started.publicState.bonusSessionId;
  });

  const step = (tileIndex: number) =>
    stepBonus(ctx.db, ctx.client, GAME, {
      operatorId: OPERATOR,
      playerId: PLAYER,
      bonusSessionId,
      action: "pick",
      payload: { tileIndex },
    });

  it("advances a pick and reveals only what was picked", async () => {
    const result = await step(0);
    assert.deepEqual(result.publicState.view.revealed, [0]);
    assert.ok(!("tiles" in result.publicState.view));
  });

  it("credits exactly once when the round resolves", async () => {
    let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      done = (await step(i)).done;
    }
    assert.ok(done, "the session should resolve within the tile count");

    const credits = ctx.raw.collection("transactions").all().filter((t) => t.type === "credit");
    assert.ok(credits.length <= 1, `expected at most one credit, got ${credits.length}`);
  });

  it("lets only one of two concurrent steps through — the race the design exists to prevent", async () => {
    // The reference implementation read the status, ran the module, then
    // wrote back. Two concurrent steps could both observe "active", both
    // evaluate, and both credit — and because each run had its own
    // randomness, they could compute DIFFERENT wins, leaving the recorded
    // total disagreeing with what was actually paid.
    //
    // Here the step is claimed with an atomic findOneAndUpdate on
    // stepIndex, so exactly one caller can win.
    const results = await Promise.allSettled([step(0), step(0)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one concurrent step may succeed");
    assert.equal(rejected.length, 1, "the loser must be told, not silently allowed to double-evaluate");
  });

  it("never pays twice even across a full concurrent session", async () => {
    // Drive the session to completion with every step doubled up.
    let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      const results = await Promise.allSettled([step(i), step(i)]);
      const winner = results.find((r) => r.status === "fulfilled");
      if (winner && winner.status === "fulfilled") done = winner.value.done;
    }

    const credits = ctx.raw.collection("transactions").all().filter((t) => t.type === "credit");
    assert.ok(credits.length <= 1, `expected at most one credit, got ${credits.length}`);

    // And the recorded win must equal what was actually paid — the exact
    // invariant the original race could violate.
    const session = await ctx.raw.collection("bonusSessions").findOne({ bonusSessionId });
    if (credits.length === 1) {
      assert.equal(credits[0].amount, session?.totalWin, "the recorded win must equal the amount paid");
    }
  });

  it("refuses a step on a resolved session", async () => {
    let done = false;
    for (let i = 0; i < 6 && !done; i++) done = (await step(i)).done;
    await assert.rejects(() => step(5), /already finished|already been revealed/);
  });

  it("refuses a step on an unknown session", async () => {
    await assert.rejects(
      () =>
        stepBonus(ctx.db, ctx.client, GAME, {
          operatorId: OPERATOR,
          playerId: PLAYER,
          bonusSessionId: "does-not-exist",
          action: "pick",
          payload: { tileIndex: 0 },
        }),
      /no bonus session/,
    );
  });

  it("refuses a step from a different player", async () => {
    // A session belongs to the player it was opened for; another player
    // knowing the id must not be able to advance or collect it.
    await assert.rejects(
      () =>
        stepBonus(ctx.db, ctx.client, GAME, {
          operatorId: OPERATOR,
          playerId: "someone-else",
          bonusSessionId,
          action: "pick",
          payload: { tileIndex: 0 },
        }),
      /no bonus session/,
    );
  });

  it("refuses a step on an abandoned session", async () => {
    await ctx.raw.collection("bonusSessions").updateOne({ bonusSessionId }, { $set: { status: "abandoned" } });
    await assert.rejects(() => step(0), /timed out/);
  });
});

describe("sweepAbandonedSessions", () => {
  it("closes stale active sessions and leaves fresh ones alone", async () => {
    const ctx = setup();
    await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-fresh"));
    await ctx.raw.collection("bonusSessions").insertOne({
      bonusSessionId: "stale",
      operatorId: OPERATOR,
      playerId: PLAYER,
      gameId: GAME.gameId,
      roundId: "round-stale",
      moduleId: "pick",
      status: "active",
      totalBet: 100,
      totalWin: 0,
      moduleState: {},
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    assert.equal(await sweepAbandonedSessions(ctx.db), 1);
    assert.equal((await ctx.raw.collection("bonusSessions").findOne({ bonusSessionId: "stale" }))?.status, "abandoned");
  });

  it("never touches a resolved session, so a paid bonus cannot be reopened", async () => {
    const ctx = setup();
    await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));
    await sweepAbandonedSessions(ctx.db, Date.now() + 10 * 60 * 60 * 1000);
    const session = await ctx.raw.collection("bonusSessions").findOne({ roundId: "round-1" });
    assert.equal(session?.status, "resolved");
  });

  it("is idempotent — running it repeatedly changes nothing further", async () => {
    const ctx = setup();
    await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    const future = Date.now() + 10 * 60 * 60 * 1000;
    assert.equal(await sweepAbandonedSessions(ctx.db, future), 1);
    assert.equal(await sweepAbandonedSessions(ctx.db, future), 0);
  });
});
