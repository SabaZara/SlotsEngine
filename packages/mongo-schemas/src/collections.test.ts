import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { applySchemas } from "./collections.js";

/**
 * Tests for schema and index application, against a real MongoDB.
 *
 * This function is the origin of three of the worst bugs in
 * `docs/TODO.md`, and none of them could have been caught anywhere else:
 *
 *   F1 — an index declared `sparse` on a compound key indexed every round,
 *        so a player's second ordinary spin collided with their first.
 *   F2 — Mongo refuses to change an existing index in place, so the F1 fix
 *        would have prevented boot on every database that already existed.
 *   F9 — a validator specifying `long`/`int` rejected every write, because
 *        JavaScript numbers serialise to BSON `double`.
 *
 * Every one is a disagreement between the schema we *declared* and what
 * Mongo actually *built*, which is exactly the class of thing an in-memory
 * stand-in cannot model. So these run against the real database or they do
 * not run at all.
 *
 * Skips when Mongo is unreachable, so the unit CI job and a laptop without
 * Docker still pass; the e2e job runs it for real.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";

let client: MongoClient | undefined;
let skipReason = "";

/** A fresh, uniquely named database per test, dropped afterwards — schema
 * application is global to a database, so sharing one would let cases
 * interfere in ways that look like real failures. */
const created: Db[] = [];

async function freshDb(): Promise<Db> {
  const db = client!.db(`schema_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  created.push(db);
  return db;
}

before(async () => {
  try {
    client = new MongoClient(MONGO_URI, {
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    skipReason = `no usable MongoDB at ${MONGO_URI} (${(err as Error).message.split("\n")[0]})`;
    await client?.close().catch(() => {});
    client = undefined;
  }
});

after(async () => {
  for (const db of created) await db.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
});

describe("applySchemas", () => {
  it("creates every declared collection and index on an empty database", async function () {
    if (!client) return this.skip(skipReason);

    const db = await freshDb();
    await applySchemas(db);

    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    // Spot-checked against the collections the money path actually needs,
    // rather than a count that would drift with every schema addition.
    for (const required of ["rounds", "transactions", "players", "bonusSessions", "users", "auditLogs"]) {
      assert.ok(names.includes(required), `${required} should have been created`);
    }
  });

  it("is safe to run twice — the boot path runs it on every start", async function () {
    if (!client) return this.skip(skipReason);

    // Every service calls this at startup. If a second run threw, the
    // second deploy of an existing environment would fail to boot.
    const db = await freshDb();
    await applySchemas(db);
    await assert.doesNotReject(() => applySchemas(db), "a second run must be a no-op, not an error");

    const indexes = await db.collection("transactions").indexes();
    const names = indexes.map((i) => i.name);
    assert.equal(new Set(names).size, names.length, "a re-run must not duplicate indexes");
  });

  it("builds the transactions idempotency index as unique on the PAIR", async function () {
    if (!client) return this.skip(skipReason);

    // Directly the shape of F1. `operatorId` alone repeats constantly; the
    // pair is what must be unique, and getting that wrong made 119 of 120
    // concurrent spins fail.
    const db = await freshDb();
    await applySchemas(db);

    const index = (await db.collection("transactions").indexes()).find(
      (i) => i.name === "operator_transaction_idempotency",
    );

    assert.ok(index, "the idempotency index must exist");
    assert.equal(index.unique, true, "and be unique");
    assert.deepEqual(index.key, { operatorId: 1, transactionId: 1 }, "on the compound key, not one field");
    assert.notEqual(index.sparse, true, "sparse on a compound key is the F1 bug — every doc gets indexed");
  });

  it("enforces that idempotency index in practice, not just on paper", async function () {
    if (!client) return this.skip(skipReason);

    // Asserting the index's declared shape is not the same as asserting
    // Mongo honours it. A second identical pair must be refused, and a
    // different pair must be allowed.
    const db = await freshDb();
    await applySchemas(db);

    const doc = {
      transactionId: "t-1",
      operatorId: "op-1",
      playerId: "p-1",
      type: "debit",
      amount: 100,
      balanceAfter: 900,
      status: "completed",
      createdAt: new Date(),
    };

    await db.collection("transactions").insertOne({ ...doc });
    await assert.rejects(
      () => db.collection("transactions").insertOne({ ...doc }),
      (err: { code?: number }) => err.code === 11000,
      "the same (operator, transaction) pair must be refused",
    );
    await assert.doesNotReject(
      () => db.collection("transactions").insertOne({ ...doc, operatorId: "op-2" }),
      "a different operator reusing the id is a different transaction",
    );
  });

  it("rebuilds an index whose definition changed, rather than refusing to boot", async function () {
    if (!client) return this.skip(skipReason);

    // Exactly F2. Mongo answers `createIndexes` with IndexOptionsConflict
    // (85) when the name exists with different options — it will not update
    // in place. Unhandled, that turns any corrected index into a service
    // that cannot start on any pre-existing database.
    //
    // Simulated by planting a WRONG index under a name the schema also
    // uses, then applying the schema over it.
    const db = await freshDb();
    await db.createCollection("transactions");
    await db
      .collection("transactions")
      .createIndex({ operatorId: 1 }, { name: "operator_transaction_idempotency", unique: false });

    await assert.doesNotReject(() => applySchemas(db), "a changed index must be rebuilt, not fatal");

    const index = (await db.collection("transactions").indexes()).find(
      (i) => i.name === "operator_transaction_idempotency",
    );
    assert.deepEqual(index?.key, { operatorId: 1, transactionId: 1 }, "and rebuilt to the CURRENT definition");
    assert.equal(index?.unique, true);
  });

  it("applies a validator that accepts what the application actually writes", async function () {
    if (!client) return this.skip(skipReason);

    // The F9 class of bug, generalised. A validator is only useful if the
    // documents this codebase produces satisfy it — and JS numbers reach
    // BSON as `double`, which is what F9's `long`/`int` spec rejected.
    const db = await freshDb();
    await applySchemas(db);

    await assert.doesNotReject(
      () =>
        db.collection("loginAttempts").updateOne(
          { key: "someone@example.com" },
          { $set: { attempts: 1, lastAttemptAt: Date.now(), lockedUntil: null, expiresAt: new Date() } },
          { upsert: true },
        ),
      "a plain JS number must satisfy the loginAttempts validator",
    );

    await assert.doesNotReject(
      () =>
        db.collection("players").insertOne({
          operatorId: "op-1",
          playerId: "p-1",
          balance: 10_000,
          updatedAt: new Date(),
        }),
      "an integer balance must satisfy the players validator",
    );
  });

  it("still rejects a document that violates a validator", async function () {
    if (!client) return this.skip(skipReason);

    // The other direction: a validator that accepts everything is not a
    // validator. `players.balance` is declared a number, so a string must
    // be refused — otherwise a balance could become unarithmetic.
    const db = await freshDb();
    await applySchemas(db);

    await assert.rejects(
      () =>
        db.collection("players").insertOne({
          operatorId: "op-1",
          playerId: "p-bad",
          balance: "not-a-number",
          updatedAt: new Date(),
        }),
      (err: { code?: number }) => err.code === 121,
      "a non-numeric balance must fail validation",
    );
  });

  it("updates a validator on a collection that already exists", async function () {
    if (!client) return this.skip(skipReason);

    // The other half of F2: a collection created before a validator was
    // declared, or with an older one, must be brought up to date by
    // `collMod` rather than left on the stale rules forever.
    const db = await freshDb();
    await db.createCollection("players");
    await db.collection("players").insertOne({ operatorId: "op-1", playerId: "p-1", balance: 1 });

    await applySchemas(db);

    await assert.rejects(
      () => db.collection("players").insertOne({ operatorId: "op-2", playerId: "p-2", balance: "bad" }),
      (err: { code?: number }) => err.code === 121,
      "the validator must now be enforced on the pre-existing collection",
    );
  });

  it("preserves existing documents when applying a schema over them", async function () {
    if (!client) return this.skip(skipReason);

    // A boot-time migration that dropped data would be catastrophic and
    // entirely silent — the service would come up looking healthy.
    const db = await freshDb();
    await applySchemas(db);
    await db.collection("players").insertOne({
      operatorId: "op-1",
      playerId: "keep-me",
      balance: 5_000,
      updatedAt: new Date(),
    });

    await applySchemas(db);

    const player = await db.collection("players").findOne({ playerId: "keep-me" });
    assert.equal(player?.balance, 5_000, "re-applying the schema must not touch data");
  });

  it("declares the rounds idempotency index as partial, not sparse", async function () {
    if (!client) return this.skip(skipReason);

    // The precise correction F1 made. A partial index with a filter only
    // indexes rounds that actually carry a clientRequestId; `sparse` on a
    // compound key indexes everything, which is what caused the collision.
    const db = await freshDb();
    await applySchemas(db);

    const rounds = await db.collection("rounds").indexes();
    const idempotency = rounds.find((i) => i.name === "operator_player_clientRequest_idempotency");

    // Named exactly, and asserted to exist. An earlier version of this test
    // searched by substring and only checked the index `if` it was found —
    // which would have passed silently had the index been renamed or
    // dropped, i.e. in precisely the situation worth catching.
    assert.ok(idempotency, "the rounds idempotency index must exist");
    assert.notEqual(
      idempotency.sparse,
      true,
      "must not be sparse on a compound key — that is the F1 bug, which indexed every round",
    );
    assert.deepEqual(
      idempotency.partialFilterExpression,
      { clientRequestId: { $type: "string" } },
      "a partial filter is what limits the index to rounds that carry a client request id",
    );
    assert.equal(idempotency.unique, true);
  });

  it("lets two ordinary spins coexist while still catching a real retry", async function () {
    if (!client) return this.skip(skipReason);

    // The behavioural consequence of the partial filter, and the exact
    // failure F1 produced: two ordinary spins by one player carry NO
    // clientRequestId, and must not collide. A retry carrying the same id
    // must still be refused.
    const db = await freshDb();
    await applySchemas(db);

    const round = (extra: Record<string, unknown>) => ({
      roundId: randomUUID(),
      operatorId: "op-1",
      playerId: "p-1",
      gameId: "g-1",
      status: "resolved",
      gameVersion: 1,
      totalBet: 100,
      totalWin: 0,
      seed: "s",
      rngAlgorithm: "xoshiro256ss-d16",
      createdAt: new Date(),
      ...extra,
    });

    await db.collection("rounds").insertOne(round({}));
    await assert.doesNotReject(
      () => db.collection("rounds").insertOne(round({})),
      "two ordinary spins with no clientRequestId must both be allowed — this is F1",
    );

    await db.collection("rounds").insertOne(round({ clientRequestId: "retry-1" }));
    await assert.rejects(
      () => db.collection("rounds").insertOne(round({ clientRequestId: "retry-1" })),
      (err: { code?: number }) => err.code === 11000,
      "but a genuine retry must still be caught",
    );
  });
});
