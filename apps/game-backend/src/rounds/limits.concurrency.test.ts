import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { withLedgerTransaction } from "@slots-engine/ledger";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { spinRound } from "./service.js";
import { LimitExceededError, stakeAgainstLimits } from "./limits.js";

/**
 * Player limits under **real** concurrency, against a **real** MongoDB.
 *
 * `decide.test.ts` proves the arithmetic and cannot prove the guarantee.
 * The guarantee here is specifically that **two simultaneous bets cannot
 * both pass one ceiling**, and that rests on the counter being advanced
 * atomically inside a transaction — which no in-memory stand-in models.
 * This repo has been bitten by exactly this gap twice (F1, F9), both times
 * with a fully green suite.
 *
 * The bug this file exists to refuse is the obvious implementation: read
 * the usage, decide, then spin. Two callers both read "900 of 1,000
 * staked", both decide 200 fits, and both commit — a 1,000 limit passing
 * 1,300. It is the same shape as the reference's bonus-credit race.
 *
 * What this cannot establish: that the limits are the *right* limits, or
 * that a regulator would accept these periods. Those are product and
 * compliance questions. What is pinned is that a declared ceiling holds
 * under contention.
 *
 * **Skips when Mongo is unreachable**, loudly and with a reason, so a
 * laptop without Docker still passes `npm test`.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";
const MONGO_DB = process.env.MONGO_TEST_DB ?? "slots_engine_limits_test";

const OPERATOR = `op-limits-${randomUUID().slice(0, 8)}`;

let client: MongoClient | undefined;
let db: Db | undefined;
let skipReason = "";

before(async () => {
  try {
    client = new MongoClient(MONGO_URI, {
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
    db = client.db(MONGO_DB);
    await db.command({ ping: 1 });

    // The index the upsert's correctness rests on: without it two
    // concurrent first-bets of a period each insert their own row and each
    // see only half the usage. Created here because this test database is
    // not the one `applySchemas` runs against.
    await db
      .collection("playerLimitUsage")
      .createIndex({ operatorId: 1, playerId: 1, period: 1, periodKey: 1 }, { unique: true });

    // Transactions need a replica set; a standalone accepts the connection
    // and fails every commit, which would read as a limits bug.
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db!.collection("playerLimitUsage").findOne({ _id: "probe" as never }, { session });
      });
    } finally {
      await session.endSession();
    }
  } catch (err) {
    skipReason = `no usable MongoDB at ${MONGO_URI} (${(err as Error).message.split("\n")[0]})`;
    await client?.close().catch(() => {});
    client = undefined;
    db = undefined;
  }
});

after(async () => {
  if (db) {
    await db.collection("playerLimits").deleteMany({ operatorId: OPERATOR }).catch(() => {});
    await db.collection("playerLimitUsage").deleteMany({ operatorId: OPERATOR }).catch(() => {});
  }
  await client?.close().catch(() => {});
});

async function seedLimit(maxStake: number): Promise<string> {
  const playerId = randomUUID();
  await db!
    .collection("playerLimits")
    .insertOne({ operatorId: OPERATOR, playerId, limits: [{ period: "daily", maxStake }] });
  return playerId;
}

/** One bet, taken through the same transaction shape the spin path uses:
 * stake against the limits, throw on refusal so the transaction aborts. */
async function attemptBet(playerId: string, stake: number, at: Date): Promise<"allowed" | "refused"> {
  try {
    // Returns a value because `withLedgerTransaction` refuses an
    // `undefined` result — a deliberate guard there against a callback that
    // silently did nothing, not something to work around.
    await withLedgerTransaction(client!, async (session) => {
      const decision = await stakeAgainstLimits(db!, session, {
        operatorId: OPERATOR,
        playerId,
        stake,
        at,
      });
      if (!decision.allowed) throw new LimitExceededError(decision);
      return decision;
    });
    return "allowed";
  } catch (err) {
    if (err instanceof LimitExceededError) return "refused";
    throw err;
  }
}

describe("a stake ceiling under contention", () => {
  it("lets exactly as many simultaneous bets through as the limit affords", async function () {
    if (!db) return this.skip(skipReason);

    // Twenty bets of 100 fired at once against a ceiling of 1,000. Exactly
    // ten may pass. A read-then-write implementation passes far more,
    // because every caller reads the same starting counter.
    const playerId = await seedLimit(1_000);
    const at = new Date("2026-08-18T12:00:00.000Z");

    const outcomes = await Promise.all(Array.from({ length: 20 }, () => attemptBet(playerId, 100, at)));
    const allowed = outcomes.filter((o) => o === "allowed").length;

    assert.equal(allowed, 10, `exactly ten bets of 100 fit under a 1,000 ceiling, got ${allowed}`);
  });

  it("never accumulates more stake than the ceiling, whatever the interleaving", async function () {
    if (!db) return this.skip(skipReason);

    // The property that actually matters, asserted on the stored counter
    // rather than on the responses: the ledger equivalent of reconciling.
    // A refused bet must leave no trace, so the total must land exactly on
    // the ceiling and never above it.
    const playerId = await seedLimit(1_000);
    const at = new Date("2026-08-18T12:00:00.000Z");

    await Promise.all(Array.from({ length: 30 }, () => attemptBet(playerId, 250, at)));

    const usage = await db.collection("playerLimitUsage").findOne({
      operatorId: OPERATOR,
      playerId,
      period: "daily",
      periodKey: "2026-08-18",
    });

    assert.ok(usage, "the counter must exist after bets were placed");
    assert.ok(
      (usage.staked as number) <= 1_000,
      `accumulated stake ${usage.staked} exceeded the 1,000 ceiling — a limit that does not hold is not a limit`,
    );
    assert.equal(usage.staked, 1_000, "and four bets of 250 should have filled it exactly");
  });

  it("rolls the counter back when the surrounding transaction aborts", async function () {
    if (!db) return this.skip(skipReason);

    // The half that makes a refusal safe. The counter is advanced *before*
    // the decision, so a refused bet has already incremented — and only the
    // rollback stops that phantom stake from permanently consuming the
    // player's allowance. Without it, a player refused ten times would have
    // their limit silently exhausted by bets that never happened.
    const playerId = await seedLimit(1_000);
    const at = new Date("2026-08-18T12:00:00.000Z");

    await attemptBet(playerId, 400, at);

    // This one is refused: 400 + 900 > 1,000.
    assert.equal(await attemptBet(playerId, 900, at), "refused");

    const usage = await db.collection("playerLimitUsage").findOne({
      operatorId: OPERATOR,
      playerId,
      period: "daily",
      periodKey: "2026-08-18",
    });

    assert.equal(usage?.staked, 400, "the refused bet's increment must have rolled back with its transaction");

    // And the allowance it did not consume is still spendable.
    assert.equal(await attemptBet(playerId, 600, at), "allowed");
  });

  it("keeps separate periods on separate counters", async function () {
    if (!db) return this.skip(skipReason);

    // A player at their daily ceiling must start tomorrow with a full
    // allowance — the counter key is what makes that automatic, with no
    // sweep to reset anything.
    const playerId = await seedLimit(1_000);

    assert.equal(await attemptBet(playerId, 1_000, new Date("2026-08-18T12:00:00.000Z")), "allowed");
    assert.equal(await attemptBet(playerId, 100, new Date("2026-08-18T23:00:00.000Z")), "refused");
    assert.equal(await attemptBet(playerId, 1_000, new Date("2026-08-19T00:00:00.000Z")), "allowed");
  });

  it("charges an unlimited player nothing but a lookup", async function () {
    if (!db) return this.skip(skipReason);

    // A player with no limits configured must be allowed, and must not
    // accumulate counters — the overwhelming majority of players are in
    // this state and should not pay for the feature.
    const playerId = randomUUID();

    assert.equal(await attemptBet(playerId, 5_000, new Date("2026-08-18T12:00:00.000Z")), "allowed");

    const count = await db.collection("playerLimitUsage").countDocuments({ operatorId: OPERATOR, playerId });
    assert.equal(count, 0, "no limits configured means no counters written");
  });
});

describe("a real spin against a limit", () => {
  it("refuses the spin and leaves the balance untouched", async function () {
    if (!db) return this.skip(skipReason);

    // The claim that matters to a player, driven through the real
    // `spinRound` rather than through the limit primitives: a refused bet
    // must cost nothing. The limit check runs before the debit and throws,
    // which aborts the transaction — so if the ordering were ever changed,
    // the balance would move for a round that never happened.
    const playerId = randomUUID();
    const bet = REFERENCE_GAME.betOptions[0]!;

    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId, balance: 1_000_000 });
    await db
      .collection("playerLimits")
      .insertOne({ operatorId: OPERATOR, playerId, limits: [{ period: "daily", maxStake: bet }] });

    // The first spin fits exactly.
    await spinRound(db, client!, REFERENCE_GAME, { operatorId: OPERATOR, playerId, totalBet: bet });
    const afterFirst = await db.collection("players").findOne({ operatorId: OPERATOR, playerId });

    // The second exhausts it.
    await assert.rejects(
      () => spinRound(db!, client!, REFERENCE_GAME, { operatorId: OPERATOR, playerId, totalBet: bet }),
      (err: Error) => err.name === "LimitExceededError",
      "a spin past the ceiling must be refused, not merely logged",
    );

    const afterRefusal = await db.collection("players").findOne({ operatorId: OPERATOR, playerId });
    assert.equal(
      afterRefusal?.balance,
      afterFirst?.balance,
      "a refused spin must not move money — the debit is inside the aborted transaction",
    );

    // And no round was recorded for it.
    const rounds = await db.collection("rounds").countDocuments({ operatorId: OPERATOR, playerId });
    assert.equal(rounds, 1, "the refused spin must leave no round behind");
  });

  it("counts a win back against a loss limit, so a break-even player keeps playing", async function () {
    if (!db) return this.skip(skipReason);

    // A loss limit measures net. Without `recordWinAgainstLimits` the
    // counter would only ever grow, and a player winning everything back
    // would still be locked out — a limit that is wrong in the direction
    // that generates complaints.
    const playerId = randomUUID();
    const bet = REFERENCE_GAME.betOptions[0]!;

    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId, balance: 1_000_000 });
    // Limited, because counters only exist for limited players — an
    // unlimited one writes none at all, which is the asymmetry the `won`
    // update deliberately does not break by upserting.
    await db
      .collection("playerLimits")
      .insertOne({ operatorId: OPERATOR, playerId, limits: [{ period: "daily", maxLoss: 10_000_000 }] });

    let totalWon = 0;
    for (let i = 0; i < 12; i += 1) {
      const { round } = await spinRound(db, client!, REFERENCE_GAME, {
        operatorId: OPERATOR,
        playerId,
        totalBet: bet,
      });
      totalWon += round.evaluation.totalWin;
    }

    const usage = await db
      .collection("playerLimitUsage")
      .findOne({ operatorId: OPERATOR, playerId, period: "daily" });

    assert.equal(usage?.staked, bet * 12, "every stake is counted");
    assert.equal(usage?.won, totalWon, "and every win is counted back against it");
  });
});

describe("the stake and win halves stay symmetric", () => {
  it("writes no counter for an unlimited player who wins", async function () {
    if (!db) return this.skip(skipReason);

    // Found by writing the test above and watching it fail. Recording a win
    // for a player with no limits creates a counter holding a credit with
    // no matching stake — and the moment a limit is added to that player,
    // their net loss reads as negative and the floor-at-zero hands them a
    // full allowance on top of winnings whose cost the counter never saw.
    //
    // Spins until one wins, because a losing spin never reaches the win
    // path at all and would prove nothing.
    const playerId = randomUUID();
    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId, balance: 1_000_000 });

    let won = 0;
    for (let i = 0; i < 60 && won === 0; i += 1) {
      const { round } = await spinRound(db, client!, REFERENCE_GAME, {
        operatorId: OPERATOR,
        playerId,
        totalBet: REFERENCE_GAME.betOptions[0]!,
      });
      won = round.evaluation.totalWin;
    }

    assert.ok(won > 0, "the fixture must actually win at least once, or this proves nothing");

    const counters = await db.collection("playerLimitUsage").countDocuments({ operatorId: OPERATOR, playerId });
    assert.equal(counters, 0, "an unlimited player's win must not create a counter");
  });
});

describe("a loosening that has waited out its delay", () => {
  it("holds the player to the old ceiling while the raise is pending", async function () {
    if (!db) return this.skip(skipReason);

    // The control's whole purpose: a player who raises a limit mid-session
    // must not get the benefit of it in that session.
    const playerId = randomUUID();
    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR,
      playerId,
      limits: [{ period: "daily", maxStake: 100 }],
      pending: {
        limits: [{ period: "daily", maxStake: 100_000 }],
        effectiveAt: Date.now() + 60_000,
        requestedAt: Date.now(),
      },
    });

    const at = new Date();
    assert.equal(await attemptBet(playerId, 100, at), "allowed");
    assert.equal(await attemptBet(playerId, 100, at), "refused", "the pending raise must not apply yet");
  });

  it("honours the raise once due, without anything having rewritten it", async function () {
    if (!db) return this.skip(skipReason);

    // Nothing runs at the moment a change matures — there is no sweep and
    // no job. If the money path read only the stored set, the player would
    // stay held to a ceiling that expired until some unrelated request
    // happened to persist the change.
    const playerId = randomUUID();
    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR,
      playerId,
      limits: [{ period: "daily", maxStake: 100 }],
      pending: {
        limits: [{ period: "daily", maxStake: 100_000 }],
        effectiveAt: Date.now() - 1_000,
        requestedAt: Date.now() - 90_000_000,
      },
    });

    const at = new Date();
    assert.equal(await attemptBet(playerId, 5_000, at), "allowed", "a matured raise applies on read");
  });
});
