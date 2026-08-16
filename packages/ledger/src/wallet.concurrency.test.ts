import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { debitWithinSession, withLedgerTransaction } from "./wallet.js";

/**
 * The ledger under **real** concurrency, against a **real** MongoDB.
 *
 * `wallet.test.ts` covers every decision this module makes on its own, but
 * it runs on the in-memory stand-in, which by design does not model
 * rollback or multi-document transactions. So it proves the logic and
 * cannot prove the guarantee — and the ledger's guarantee is specifically
 * about transaction behaviour under contention, which no fake can stand in
 * for.
 *
 * The gap that leaves is precise, and worth naming because it is easy to
 * think it is already covered: idempotency was only ever exercised as a
 * *sequential* replay — call, then call again. Two callers arriving at the
 * same instant is a different thing entirely. Both read "no existing
 * transaction", both proceed, and what stops the double-charge is the
 * unique index plus the driver retrying the whole transaction callback on a
 * write conflict. That is exactly the interaction a stand-in cannot
 * reproduce.
 *
 * This is the same shape as the money-path load check, one level down: that
 * one drives HTTP, this one drives the ledger primitives directly, so a
 * failure here points at the ledger rather than at anything above it.
 *
 * **Skips when Mongo is unreachable**, rather than failing. The unit-test
 * job has no database — only the e2e job does — so a hard failure here
 * would mean `npm test` could not pass on a laptop without Docker running.
 * A skip is reported loudly, with the reason, because a check that quietly
 * does not run is worse than one that is absent.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";
const MONGO_DB = process.env.MONGO_TEST_DB ?? "slots_engine_ledger_test";

/** Scoped to this file so a parallel suite sharing the database cannot
 * delete rows out from under it — a real observed flake in the codebase
 * this pattern comes from. */
const OPERATOR = `op-concurrency-${randomUUID().slice(0, 8)}`;

let client: MongoClient | undefined;
let db: Db | undefined;
let skipReason = "";

before(async () => {
  try {
    // Short timeouts: when there is no database the point is to find out
    // quickly and skip, not to hang the suite for thirty seconds.
    client = new MongoClient(MONGO_URI, {
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
    db = client.db(MONGO_DB);
    await db.command({ ping: 1 });

    // The index the exactly-once guarantee actually rests on. Created here
    // rather than assumed, because this test database is not the one
    // `applySchemas` runs against.
    await db.collection("transactions").createIndex({ operatorId: 1, transactionId: 1 }, { unique: true });

    // A transaction needs a replica set. A standalone mongod accepts the
    // connection and then fails every commit, which would read as a ledger
    // bug rather than a topology one — so check it here and say so.
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db!.collection("transactions").findOne({ _id: "probe" as never }, { session });
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
  if (db) await db.collection("players").deleteMany({ operatorId: OPERATOR }).catch(() => {});
  if (db) await db.collection("transactions").deleteMany({ operatorId: OPERATOR }).catch(() => {});
  await client?.close().catch(() => {});
});

/** Seeds a fresh player and returns their id. */
async function seedPlayer(balance: number): Promise<string> {
  const playerId = randomUUID();
  await db!.collection("players").insertOne({ operatorId: OPERATOR, playerId, balance, updatedAt: new Date() });
  return playerId;
}

describe("ledger under real concurrency", () => {
  it("applies N simultaneous debits sharing one transactionId exactly once", async function () {
    if (!db) return this.skip(skipReason);

    // The sequential retry this replaces — call, then call again — never
    // exercises two callers reading "not yet processed" at the same moment.
    const playerId = await seedPlayer(1000);
    const transactionId = randomUUID();
    const amount = 40;
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        withLedgerTransaction(client!, (session) =>
          debitWithinSession(db!, session, { operatorId: OPERATOR, playerId, transactionId, amount }),
        ),
      ),
    );

    assert.equal(results.length, N, "every concurrent call must resolve, not throw");
    assert.equal(
      results.filter((r) => !r.alreadyProcessed).length,
      1,
      "exactly one caller may apply the debit",
    );
    assert.equal(results.filter((r) => r.alreadyProcessed).length, N - 1);

    // Every caller, winner or replay, must be told the same balance —
    // otherwise a client displays a number that was never true.
    assert.ok(
      results.every((r) => r.balanceAfter === 1000 - amount),
      "all callers must report the same resulting balance",
    );

    const player = await db.collection("players").findOne({ operatorId: OPERATOR, playerId });
    assert.equal(player?.balance, 1000 - amount, "the player must be charged once, not N times");

    const count = await db.collection("transactions").countDocuments({ operatorId: OPERATOR, transactionId });
    assert.equal(count, 1, "exactly one transaction row may exist");
  });

  it("holds for the round-shaped call the spin path actually makes", async function () {
    if (!db) return this.skip(skipReason);

    // Same proof in the shape game-backend uses: a roundId-derived id plus
    // the roundId field. Worth testing separately because the id format is
    // what a retry after a dropped connection replays.
    const playerId = await seedPlayer(1000);
    const roundId = randomUUID();
    const transactionId = `${roundId}:debit`;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        withLedgerTransaction(client!, (session) =>
          debitWithinSession(db!, session, { operatorId: OPERATOR, playerId, roundId, transactionId, amount: 100 }),
        ),
      ),
    );

    assert.equal(results.filter((r) => !r.alreadyProcessed).length, 1);
    const player = await db.collection("players").findOne({ operatorId: OPERATOR, playerId });
    assert.equal(player?.balance, 900);
    assert.equal(await db.collection("transactions").countDocuments({ operatorId: OPERATOR, transactionId }), 1);
  });

  it("never lets concurrent DISTINCT debits overdraw the balance", async function () {
    if (!db) return this.skip(skipReason);

    // The other race, and the one that loses real money: not a replay of
    // one charge but many different charges against a balance that cannot
    // cover them all. The affordability check and the write must not be
    // separable — if they are, every caller reads a sufficient balance
    // before any of them writes.
    const playerId = await seedPlayer(500);
    const amount = 100;

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        withLedgerTransaction(client!, (session) =>
          debitWithinSession(db!, session, {
            operatorId: OPERATOR,
            playerId,
            transactionId: randomUUID(),
            amount,
          }),
        ),
      ),
    );

    const applied = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(applied, 5, `a balance of 500 funds exactly 5 debits of ${amount}, got ${applied}`);

    const player = await db.collection("players").findOne({ operatorId: OPERATOR, playerId });
    assert.equal(player?.balance, 0, "the balance must land on exactly zero");
    assert.ok((player?.balance as number) >= 0, "the balance must never go negative");
  });
});
