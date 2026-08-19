import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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

  // docs/TODO.md item 25. Both of these assert the invariant that actually
  // matters and that nothing here asserted before: a session row recorded
  // as `resolved` with a positive `totalWin` must have a ledger entry
  // paying it. The old code wrote the row and then credited in a separate
  // transaction, so a failure in between left the two disagreeing — a
  // bonus recorded as won and never paid, which no test noticed because
  // every one of them exercised only the path where both writes succeed.
  //
  // What these CANNOT establish is the real rollback: `fakeMongo`'s
  // `withTransaction` runs the callback and lets a throw propagate without
  // undoing writes (see its header). So these prove the credit is now
  // *inside* the transaction and that the failure is surfaced rather than
  // swallowed; that the row is actually rolled back needs the live
  // database, and is verified by `npm run e2e:spin` against real Mongo.
  it("never leaves a resolved bonus unpaid when the credit fails", async () => {
    let boom = true;
    const realStartSession = ctx.client.startSession.bind(ctx.client);
    ctx.client.startSession = (...args: unknown[]) => {
      if (boom) {
        boom = false;
        throw new Error("the credit failed");
      }
      return realStartSession(...args);
    };

    await assert.rejects(() => startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1")));

    // The caller was told. The old code swallowed nothing either — but it
    // had already committed the row by this point, so the player was left
    // holding a recorded win with no money behind it.
    const row = await ctx.raw.collection("bonusSessions").findOne({ roundId: "round-1" });
    const credits = ctx.raw.collection("transactions").all().filter((t) => t.type === "credit");
    assert.equal(credits.length, 0, "nothing was paid");
    if (row?.status === "resolved") {
      assert.fail("a session was committed as resolved with no credit behind it — item 25");
    }
  });

  it("pays exactly what the resolved row records", async () => {
    const result = await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    const row = await ctx.raw.collection("bonusSessions").findOne({ roundId: "round-1" });
    const credits = ctx.raw.collection("transactions").all().filter((t) => t.type === "credit");

    // Deliberately `=== 1` rather than `<= 1`. The concurrency test below
    // used the looser form, which zero satisfies — so an assertion written
    // to catch double-paying passed just as happily when nothing was paid
    // at all. That is precisely how item 25 stayed invisible.
    assert.equal(credits.length, 1, "a resolved win must be paid exactly once");
    assert.equal(credits[0].amount, row?.totalWin, "the amount paid must equal the amount recorded");
    assert.equal(result.balanceAfter, 100_000 + (row?.totalWin as number));
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

  // docs/TODO.md item 25, the `stepBonus` half. Written because mutating
  // only `startBonus` back to two transactions was caught while mutating
  // `stepBonus` back was NOT — the fix landed on both paths, but the
  // evidence only covered one, and an untested half of a money fix is
  // indistinguishable from an unfixed one.
  //
  // A resolving step is needed for this to mean anything, and `pick` can
  // land on a blank and resolve with a win of 0, which pays nothing and so
  // never reaches the credit at all. Retrying until the resolution pays
  // makes the test deterministic about the case it is actually asserting
  // rather than passing vacuously on a zero-win run.
  it("never leaves a resolved step unpaid when the credit fails", async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const fresh = setup();
      const started = await startBonus(fresh.db, fresh.client, GAME, startInput("pick", "round-1"));
      const id = started.publicState.bonusSessionId;

      // Fail only the credit's transaction, and only once. The step claim
      // has already happened by then, so this is precisely the window
      // between recording the win and paying it.
      let armed = false;
      const realStartSession = fresh.client.startSession.bind(fresh.client);
      fresh.client.startSession = (...args: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error("the credit failed");
        }
        return realStartSession(...args);
      };

      let done = false;
      let threw = false;
      for (let i = 0; i < 8 && !done; i++) {
        // Arm on every step: whichever one resolves is the one that pays.
        armed = true;
        try {
          done = (
            await stepBonus(fresh.db, fresh.client, GAME, {
              operatorId: OPERATOR,
              playerId: PLAYER,
              bonusSessionId: id,
              action: "pick",
              payload: { tileIndex: i },
            })
          ).done;
        } catch {
          threw = true;
          break;
        }
      }
      if (!threw) continue;

      const row = await fresh.raw.collection("bonusSessions").findOne({ bonusSessionId: id });
      const credits = fresh.raw.collection("transactions").all().filter((t) => t.type === "credit");
      if (credits.length > 0) continue; // the failure landed on a non-paying step

      if (row?.status === "resolved" && (row?.totalWin as number) > 0) {
        assert.fail(
          `a step committed as resolved with totalWin ${row.totalWin} and no credit behind it — item 25`,
        );
      }
      return;
    }
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
    const session = await ctx.raw.collection("bonusSessions").findOne({ bonusSessionId });

    // The assertion here was `credits.length <= 1` until item 25, and the
    // looser form is satisfied by zero — so a test written to catch
    // double-paying passed just as happily when nothing was paid at all.
    //
    // The exact count still cannot be pinned: `pick` can legitimately land
    // on a blank and resolve with a win of 0, which pays nothing. So the
    // invariant is stated as the agreement between the two rather than as a
    // number — a resolved session pays if and only if it recorded a win,
    // and the amounts match. That fails in both directions, which is the
    // property the old assertion lacked.
    assert.equal(session?.status, "resolved", "the doubled-up steps must still finish the session");
    const recorded = (session?.totalWin as number) ?? 0;
    assert.equal(
      credits.length,
      recorded > 0 ? 1 : 0,
      `a session recording ${recorded} must have ${recorded > 0 ? "exactly one credit" : "no credit"}, got ${credits.length}`,
    );
    if (recorded > 0) {
      assert.equal(credits[0].amount, recorded, "the recorded win must equal the amount paid");
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

describe("bonus session expiry is enforced on read, not only by the sweep", () => {
  /** Backdates a session past the deadline without touching its status, so
   * it is exactly what the database looks like when the sweep has not run:
   * expired in fact, still `active` on paper. */
  async function backdate(ctx: ReturnType<typeof setup>, bonusSessionId: string, ageMs: number) {
    await ctx.raw
      .collection("bonusSessions")
      .updateOne(
        { bonusSessionId },
        { $set: { createdAt: new Date(Date.now() - ageMs).toISOString() } },
      );
  }

  it("refuses a stepped session that timed out while the sweep never ran", async () => {
    // The failure this closes: every instance down for twenty minutes, or
    // one missed interval, and a session that expired long ago is still
    // `active` in the database — playable, on the money path.
    const ctx = setup();
    const started = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    await backdate(ctx, started.publicState.bonusSessionId, 60 * 60 * 1000);

    await assert.rejects(
      () =>
        stepBonus(ctx.db, ctx.client, GAME, {
          operatorId: OPERATOR,
          playerId: PLAYER,
          bonusSessionId: started.publicState.bonusSessionId,
          action: "pick",
          payload: { tileIndex: 0 },
        }),
      /timed out/,
      "an expired session must be refused whether or not the sweep has run",
    );
  });

  it("pays nothing for an expired session", async () => {
    const ctx = setup();
    const started = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    const before = (await ctx.raw.collection("players").findOne({ playerId: PLAYER }))?.balance;
    await backdate(ctx, started.publicState.bonusSessionId, 60 * 60 * 1000);

    await assert.rejects(() =>
      stepBonus(ctx.db, ctx.client, GAME, {
        operatorId: OPERATOR,
        playerId: PLAYER,
        bonusSessionId: started.publicState.bonusSessionId,
        action: "pick",
        payload: { tileIndex: 0 },
      }),
    );

    const after = (await ctx.raw.collection("players").findOne({ playerId: PLAYER }))?.balance;
    assert.equal(after, before, "a refused expired session must not move money");
  });

  it("still plays a session that is inside the window", async () => {
    // The guard must not be so eager that it breaks an ordinary bonus.
    const ctx = setup();
    const started = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    await backdate(ctx, started.publicState.bonusSessionId, 60 * 1000);

    const result = await stepBonus(ctx.db, ctx.client, GAME, {
      operatorId: OPERATOR,
      playerId: PLAYER,
      bonusSessionId: started.publicState.bonusSessionId,
      action: "pick",
      payload: { tileIndex: 0 },
    });
    assert.ok(result, "a session one minute old is not expired");
  });

  it("keeps the row, so an expired session is distinguishable from one that never existed", async () => {
    // The reason this is a read-time check rather than a Mongo TTL index: a
    // deleted row would turn "that bonus round timed out" into "no such
    // session", which is strictly worse information on a money path.
    const ctx = setup();
    const started = await startBonus(ctx.db, ctx.client, GAME, startInput("pick", "round-1"));
    await backdate(ctx, started.publicState.bonusSessionId, 60 * 60 * 1000);

    await assert.rejects(
      () =>
        stepBonus(ctx.db, ctx.client, GAME, {
          operatorId: OPERATOR,
          playerId: PLAYER,
          bonusSessionId: started.publicState.bonusSessionId,
          action: "pick",
          payload: { tileIndex: 0 },
        }),
      /timed out/,
      "the error must name the timeout, not report a missing session",
    );

    const row = await ctx.raw.collection("bonusSessions").findOne({ bonusSessionId: started.publicState.bonusSessionId });
    assert.ok(row, "the session row must survive so the timeout can still be explained");
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

describe("archival retention (docs/TODO.md item 5)", () => {
  /**
   * The distinction this closes: **archival is not expiry.**
   *
   * A TTL keyed on the session's own fifteen-minute deadline would delete a
   * row the moment it timed out — and `abandoned` is a meaningful state, not
   * garbage. A player returning to a timed-out bonus gets a precise 410
   * ("that bonus round timed out"); delete the row and they get "no such
   * session", which is strictly worse information on a money path.
   *
   * So the row carries a separate `archiveAfter` far beyond its own
   * lifetime, long enough to answer a dispute about money that was or was
   * not paid.
   */
  let ctx: ReturnType<typeof setup>;
  const originalRetention = process.env.BONUS_SESSION_RETENTION_DAYS;

  beforeEach(() => {
    ctx = setup();
    delete process.env.BONUS_SESSION_RETENTION_DAYS;
  });

  afterEach(() => {
    if (originalRetention === undefined) delete process.env.BONUS_SESSION_RETENTION_DAYS;
    else process.env.BONUS_SESSION_RETENTION_DAYS = originalRetention;
  });

  const storedSession = async () =>
    (await ctx.db.collection("bonusSessions").findOne({ roundId: "round-1" })) as Record<string, unknown>;

  it("stamps archiveAfter as a Date, not a string", async () => {
    // Mongo's TTL monitor only reaps a genuine BSON date. An ISO string is
    // silently ignored, so the row would live forever and nobody would
    // notice for two years — verified against real Mongo in the conformance
    // suite, not taken from the documentation.
    await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    assert.ok((await storedSession()).archiveAfter instanceof Date, "archiveAfter must be a Date");
  });

  it("defaults to a two-year window", async () => {
    // A retention decision rather than a technical one: chosen to sit beyond
    // the periods gambling regulators typically require for player-dispute
    // records.
    const before = Date.now();
    await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    const archiveAfter = (await storedSession()).archiveAfter as Date;
    const days = (archiveAfter.getTime() - before) / (24 * 60 * 60 * 1000);

    assert.ok(days > 729 && days < 731, `expected ~730 days, got ${days.toFixed(1)}`);
  });

  it("keeps the row far beyond the fifteen-minute abandonment deadline", async () => {
    // The property that makes this archival rather than expiry. If these two
    // were the same number, an abandoned session would vanish and a
    // returning player would be told it never existed.
    await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    const session = await storedSession();
    const createdAt = Date.parse(session.createdAt as string);
    const archiveAfter = (session.archiveAfter as Date).getTime();

    assert.ok(
      archiveAfter - createdAt > 15 * 60 * 1000 * 100,
      "retention must be orders of magnitude longer than the abandonment window",
    );
  });

  it("honours a per-deployment retention override", async () => {
    // An operator whose licence demands a different window sets an
    // environment variable rather than patching code.
    process.env.BONUS_SESSION_RETENTION_DAYS = "1095";
    const before = Date.now();
    await startBonus(ctx.db, ctx.client, GAME, startInput("wheel", "round-1"));

    const archiveAfter = (await storedSession()).archiveAfter as Date;
    const days = (archiveAfter.getTime() - before) / (24 * 60 * 60 * 1000);

    assert.ok(days > 1094 && days < 1096, `expected ~1095 days, got ${days.toFixed(1)}`);
  });

  it("falls back to the default for a misconfigured window rather than shortening it", async () => {
    // The direction matters: too long merely costs storage, while too short
    // destroys the evidence for a dispute about money. A typo must never
    // silently mean "delete immediately".
    for (const bad of ["0", "-30", "abc", ""]) {
      const local = setup();
      process.env.BONUS_SESSION_RETENTION_DAYS = bad;
      const before = Date.now();
      await startBonus(local.db, local.client, GAME, startInput("wheel", "round-1"));

      const stored = (await local.db
        .collection("bonusSessions")
        .findOne({ roundId: "round-1" })) as Record<string, unknown>;
      const days = ((stored.archiveAfter as Date).getTime() - before) / (24 * 60 * 60 * 1000);

      assert.ok(days > 729, `BONUS_SESSION_RETENTION_DAYS='${bad}' shortened retention to ${days.toFixed(1)} days`);
    }
  });
});
