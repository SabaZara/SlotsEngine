import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { fakeMongo } from "./fakeMongo.js";

/**
 * Does the in-memory stand-in actually behave like MongoDB?
 *
 * Every unit test in this repo that touches persistence trusts `fakeMongo`,
 * so a place where it *disagrees* with the real database is a place where a
 * green suite proves nothing. That is not hypothetical here — it is how two
 * of the worst bugs in `docs/TODO.md` got in:
 *
 *   F1 — the fake modelled the index we *intended*, not the one Mongo
 *        builds, so a broken sparse-compound index passed every test and
 *        failed 119 of 120 concurrent spins in production.
 *   F9 — the fake has no schema validator, so a validator that rejected
 *        every write passed 333 unit tests and returned 500 on every
 *        failed login.
 *
 * Both were found by running the real thing. This file closes part of that
 * loop permanently: the same operations are run against BOTH, and the
 * results compared. A divergence fails here rather than in production.
 *
 * **Scope, honestly stated.** This pins the behaviours the fake claims to
 * model — duplicate-key errors, atomic findOneAndUpdate, update operators,
 * query operators, sort/limit. It does NOT pin the two things the fake
 * openly does not model — transaction rollback and schema validation — so
 * those remain the reason money-path work must still be run against a live
 * stack. Testing what a stand-in admits it cannot do would be theatre.
 *
 * Skips when Mongo is unreachable, so the unit CI job and a laptop without
 * Docker still pass; the e2e job runs it for real.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";
const MONGO_DB = process.env.MONGO_TEST_DB ?? "slots_engine_conformance_test";

let client: MongoClient | undefined;
let realDb: Db | undefined;
let skipReason = "";

before(async () => {
  try {
    client = new MongoClient(MONGO_URI, {
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
    realDb = client.db(MONGO_DB);
    await realDb.command({ ping: 1 });
  } catch (err) {
    skipReason = `no usable MongoDB at ${MONGO_URI} (${(err as Error).message.split("\n")[0]})`;
    await client?.close().catch(() => {});
    client = undefined;
    realDb = undefined;
  }
});

after(async () => {
  if (realDb) await realDb.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
});

/**
 * Runs `scenario` against the fake and against real Mongo, and returns both
 * results for comparison. Each run gets a fresh, uniquely named collection
 * so nothing leaks between cases.
 */
async function bothEngines<T>(scenario: (db: never, collection: string) => Promise<T>): Promise<{ fake: T; real: T }> {
  const collection = `c_${randomUUID().slice(0, 8)}`;
  const fake = fakeMongo();
  return {
    fake: await scenario(fake.db as never, collection),
    real: await scenario(realDb as never, collection),
  };
}

/**
 * Declares a unique index on whichever engine is running.
 *
 * The one API the two genuinely do not share: Mongo takes a key spec via
 * `createIndex`, the fake takes a field list via `addUniqueIndex`. Bridged
 * here rather than papered over, because the *behaviour* under that index
 * is exactly what these tests compare — how it is declared is incidental.
 */
async function declareUnique(db: unknown, collection: string, fields: string[]): Promise<void> {
  const col = (db as Db).collection(collection) as unknown as {
    createIndex?: (spec: Record<string, number>, opts: { unique: boolean }) => Promise<unknown>;
    addUniqueIndex?: (keys: string[]) => void;
  };
  if (typeof col.addUniqueIndex === "function") {
    col.addUniqueIndex(fields);
    return;
  }
  await col.createIndex!(Object.fromEntries(fields.map((f) => [f, 1])), { unique: true });
}

/** Captures a thrown error as a comparable shape, since the two engines
 * produce different Error subclasses for the same condition. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code?: number }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, code: (err as { code?: number }).code };
  }
}

describe("fakeMongo conformance with real MongoDB", () => {
  it("reports the same duplicate-key error code on a unique index", async function () {
    if (!realDb) return this.skip(skipReason);

    // The behaviour most of this system's exactly-once guarantees rest on.
    // A fake that threw a *different* code, or none, would let a
    // double-charge pass every test.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await declareUnique(d, collection, ["key"]);
      await d.collection(collection).insertOne({ key: "same" });
      return outcome(() => d.collection(collection).insertOne({ key: "same" }));
    });

    assert.equal(fake.ok, false, "the fake must refuse a duplicate");
    assert.equal(real.ok, false, "and so must Mongo");
    assert.equal(fake.ok === false && fake.code, 11000);
    assert.equal(real.ok === false && real.code, 11000, "the fake's code must match Mongo's");
  });

  it("allows the same value on a non-unique index", async function () {
    if (!realDb) return this.skip(skipReason);

    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ key: "same" });
      await d.collection(collection).insertOne({ key: "same" });
      return d.collection(collection).countDocuments({ key: "same" });
    });

    assert.equal(fake, 2);
    assert.equal(real, 2);
  });

  it("treats a compound unique index as unique on the PAIR", async function () {
    if (!realDb) return this.skip(skipReason);

    // Exactly the shape of F1. One field repeating is fine; the pair
    // repeating is not.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await declareUnique(d, collection, ["a", "b"]);
      await d.collection(collection).insertOne({ a: "x", b: "1" });
      const differentPair = await outcome(() => d.collection(collection).insertOne({ a: "x", b: "2" }));
      const samePair = await outcome(() => d.collection(collection).insertOne({ a: "x", b: "1" }));
      return { differentPair: differentPair.ok, samePair: samePair.ok };
    });

    assert.deepEqual(fake, { differentPair: true, samePair: false });
    assert.deepEqual(real, fake, "the fake must agree with Mongo on compound uniqueness");
  });

  it("applies $inc and $set the same way", async function () {
    if (!realDb) return this.skip(skipReason);

    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "p", balance: 100 });
      await d.collection(collection).updateOne({ id: "p" }, { $inc: { balance: -30 }, $set: { note: "spent" } });
      const doc = await d.collection(collection).findOne({ id: "p" });
      return { balance: doc?.balance, note: doc?.note };
    });

    assert.deepEqual(fake, { balance: 70, note: "spent" });
    assert.deepEqual(real, fake);
  });

  it("removes a field on $unset, rather than setting it to null or ignoring it", async function () {
    if (!realDb) return this.skip(skipReason);

    // The fake used to drop `$unset` silently, which made any test using it
    // pass for the wrong reason — a middleware test "removed" a
    // `tokenVersion` field, the document kept it, and the assertion that the
    // missing-field fallback worked was really asserting nothing. Same
    // family as F16: the stand-in being more permissive than Mongo.
    //
    // The distinction that matters is absent vs. null, since `?? 0`
    // fallbacks fire on the first and not the second.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "u", tokenVersion: 3, keep: "yes" });
      await d.collection(collection).updateOne({ id: "u" }, { $unset: { tokenVersion: "" } });
      const doc = await d.collection(collection).findOne({ id: "u" });
      return {
        present: doc !== null && "tokenVersion" in doc,
        value: doc?.tokenVersion ?? "absent",
        untouched: doc?.keep,
      };
    });

    assert.deepEqual(fake, { present: false, value: "absent", untouched: "yes" });
    assert.deepEqual(real, fake, "the fake must agree with Mongo on $unset");
  });

  it("refuses an update operator it does not implement, instead of ignoring it", async function () {
    // No real-Mongo half: the point is precisely that the fake must NOT
    // quietly accept what it cannot do. Mongo would apply `$push`; the fake
    // cannot, and the honest answer is to fail loudly rather than to leave
    // a test asserting on an update that never happened.
    const { db } = fakeMongo();
    await db.collection("c").insertOne({ id: "x", items: [] });
    await assert.rejects(
      () => db.collection("c").updateOne({ id: "x" }, { $push: { items: 1 } }),
      /does not implement the update operator \$push/,
    );
  });

  it("returns ONLY the named fields for an inclusion projection", async function () {
    if (!realDb) return this.skip(skipReason);

    // The fake honoured `{ _id: 0 }` (the F16 fix) but ignored inclusion
    // entirely, so a projected list query returned whole documents in tests
    // and three fields in production. Found by a `listDrafts` test asserting
    // the summary shape and failing against correct code — F16's family
    // exactly, and the second time this same asymmetry has bitten.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({
        gameId: "g1",
        name: "N",
        updatedAt: "2026-01-01",
        symbols: [1, 2, 3],
        rtpTarget: 0.95,
      });
      const docs = await d
        .collection(collection)
        .find({}, { projection: { _id: 0, gameId: 1, name: 1, updatedAt: 1 } })
        .toArray();
      return { keys: Object.keys(docs[0] ?? {}).sort() };
    });

    assert.deepEqual(fake, { keys: ["gameId", "name", "updatedAt"] });
    assert.deepEqual(real, fake, "the fake must agree with Mongo on inclusion projections");
  });

  it("keeps _id on an inclusion projection that does not exclude it", async function () {
    if (!realDb) return this.skip(skipReason);

    // Mongo's one asymmetry: `_id` rides along with an inclusion projection
    // unless explicitly excluded. A fake that dropped it would make a route
    // look like it was stripping an id it never received.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ gameId: "g1", name: "N", extra: "x" });
      const doc = await d.collection(collection).findOne({}, { projection: { gameId: 1 } });
      return { keys: Object.keys(doc ?? {}).sort() };
    });

    assert.deepEqual(fake, { keys: ["_id", "gameId"] });
    assert.deepEqual(real, fake);
  });

  it("sorts before it projects, so a sort key need not be returned", async function () {
    if (!realDb) return this.skip(skipReason);

    // A legal and useful query: order by a field the caller does not want
    // back. Projecting first would silently turn the sort into a no-op —
    // the fake agreeing on which documents come back but not on their
    // order, which is the kind of divergence that makes a list look
    // randomly ordered only in tests.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ name: "first", updatedAt: "2026-01-01" });
      await d.collection(collection).insertOne({ name: "second", updatedAt: "2026-03-01" });
      await d.collection(collection).insertOne({ name: "third", updatedAt: "2026-02-01" });

      const docs = await d
        .collection(collection)
        .find({}, { projection: { _id: 0, name: 1 } })
        .sort({ updatedAt: -1 })
        .toArray();
      return { order: docs.map((doc) => doc.name), keys: Object.keys(docs[0] ?? {}) };
    });

    assert.deepEqual(fake, { order: ["second", "third", "first"], keys: ["name"] });
    assert.deepEqual(real, fake, "the fake must sort on a projected-away field the same way Mongo does");
  });

  it("reaps a TTL document only when the field is a real Date", async function () {
    if (!realDb) return this.skip(skipReason);

    // Real Mongo only — `fakeMongo` models no TTL monitor, and pretending
    // otherwise would be exactly the F1/F9 mistake of modelling the
    // behaviour we intended rather than the one the database has.
    //
    // The bonus-session archival (TODO item 5) depends on this: a TTL field
    // written as an ISO *string* is silently ignored, so the row would live
    // forever and nobody would notice for two years. Measured rather than
    // taken from the docs — the string and absent rows survive, the Date row
    // is reaped.
    //
    // Mongo's TTL monitor runs about every 60 seconds, so this waits.
    const collection = `ttl_conformance_${randomUUID().slice(0, 8)}`;
    const col = realDb.collection(collection);
    const past = new Date(Date.now() - 3_600_000);

    try {
      await col.createIndex({ archiveAfter: 1 }, { expireAfterSeconds: 0, name: "archiveAfter_ttl" });
      await col.insertOne({ id: "date-field", archiveAfter: past });
      await col.insertOne({ id: "string-field", archiveAfter: past.toISOString() });
      await col.insertOne({ id: "no-field" });

      let surviving: string[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        surviving = (await col.find({}).toArray()).map((d) => String(d.id)).sort();
        if (surviving.length < 3) break;
      }

      assert.deepEqual(
        surviving,
        ["no-field", "string-field"],
        "only a genuine BSON Date may be reaped — a string TTL field is silently ignored",
      );
    } finally {
      await col.drop().catch(() => {});
    }
  });

  it("creates a document on upsert, and updates it on the second call", async function () {
    if (!realDb) return this.skip(skipReason);

    // The login-throttle counter depends on this exact sequence.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).updateOne({ key: "k" }, { $inc: { hits: 1 } }, { upsert: true });
      await d.collection(collection).updateOne({ key: "k" }, { $inc: { hits: 1 } }, { upsert: true });
      const doc = await d.collection(collection).findOne({ key: "k" });
      return { hits: doc?.hits, total: await d.collection(collection).countDocuments({}) };
    });

    assert.deepEqual(fake, { hits: 2, total: 1 });
    assert.deepEqual(real, fake, "an upsert must not create a second document");
  });

  it("reports matchedCount and modifiedCount the same way", async function () {
    if (!realDb) return this.skip(skipReason);

    // Routes distinguish these: "no such document" is a 404, "found it,
    // nothing changed" is not.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "p", v: 1 });
      const hit = await d.collection(collection).updateOne({ id: "p" }, { $set: { v: 2 } });
      const miss = await d.collection(collection).updateOne({ id: "nope" }, { $set: { v: 2 } });
      return { hitMatched: hit.matchedCount, missMatched: miss.matchedCount };
    });

    assert.deepEqual(fake, { hitMatched: 1, missMatched: 0 });
    assert.deepEqual(real, fake);
  });

  it("matches findOneAndUpdate's returnDocument semantics", async function () {
    if (!realDb) return this.skip(skipReason);

    // The atomic claim the bonus-step race depends on. "before" vs "after"
    // deciding the wrong way would break exactly one caller winning.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "s", step: 0 });
      const before = await d.collection(collection).findOneAndUpdate(
        { id: "s", step: 0 },
        { $inc: { step: 1 } },
        { returnDocument: "before" },
      );
      const after = await d.collection(collection).findOneAndUpdate(
        { id: "s", step: 1 },
        { $inc: { step: 1 } },
        { returnDocument: "after" },
      );
      return { before: before?.step, after: after?.step };
    });

    assert.deepEqual(fake, { before: 0, after: 2 });
    assert.deepEqual(real, fake);
  });

  it("returns null from findOneAndUpdate when nothing matched", async function () {
    if (!realDb) return this.skip(skipReason);

    // How a losing caller learns it lost the claim.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "s", step: 5 });
      const result = await d.collection(collection).findOneAndUpdate({ id: "s", step: 0 }, { $inc: { step: 1 } });
      return result === null;
    });

    assert.equal(fake, true);
    assert.equal(real, true, "a non-matching claim must return null, not throw");
  });

  it("agrees on the comparison query operators", async function () {
    if (!realDb) return this.skip(skipReason);

    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ n: 1, s: "a" });
      await d.collection(collection).insertOne({ n: 5, s: "b" });
      await d.collection(collection).insertOne({ n: 9, s: "c" });
      return {
        lt: await d.collection(collection).countDocuments({ n: { $lt: 5 } }),
        gt: await d.collection(collection).countDocuments({ n: { $gt: 5 } }),
        ne: await d.collection(collection).countDocuments({ s: { $ne: "a" } }),
        exact: await d.collection(collection).countDocuments({ n: 5 }),
      };
    });

    assert.deepEqual(fake, { lt: 1, gt: 1, ne: 2, exact: 1 });
    assert.deepEqual(real, fake);
  });

  it("agrees on sort and limit", async function () {
    if (!realDb) return this.skip(skipReason);

    // Round recovery reads "newest first, take one", so a disagreement
    // here hands a player the wrong round.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "a", at: "2026-01-01" });
      await d.collection(collection).insertOne({ id: "b", at: "2026-03-01" });
      await d.collection(collection).insertOne({ id: "c", at: "2026-02-01" });
      const docs = await d.collection(collection).find({}).sort({ at: -1 }).limit(2).toArray();
      return docs.map((doc) => doc.id);
    });

    assert.deepEqual(fake, ["b", "c"]);
    assert.deepEqual(real, fake, "newest-first ordering must match");
  });

  it("agrees on updateMany's conditional sweep", async function () {
    if (!realDb) return this.skip(skipReason);

    // The bonus-session sweep: only `active` rows older than a cutoff.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ id: "old", status: "active", at: "2026-01-01" });
      await d.collection(collection).insertOne({ id: "new", status: "active", at: "2026-09-01" });
      await d.collection(collection).insertOne({ id: "done", status: "resolved", at: "2026-01-01" });

      const result = await d
        .collection(collection)
        .updateMany({ status: "active", at: { $lt: "2026-06-01" } }, { $set: { status: "abandoned" } });

      return {
        modified: result.modifiedCount,
        resolvedUntouched: (await d.collection(collection).findOne({ id: "done" }))?.status,
      };
    });

    assert.deepEqual(fake, { modified: 1, resolvedUntouched: "resolved" });
    assert.deepEqual(real, fake);
  });

  it("agrees that a projection of { _id: 0 } strips the id", async function () {
    if (!realDb) return this.skip(skipReason);

    // Found by a test failing against correct code. Several routes exclude
    // `_id` so an internal id never reaches a client; the fake ignored
    // projections entirely, so `_id` survived in tests while production
    // stripped it properly. More permissive than Mongo is just as
    // misleading as less — it fails a correct assertion.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ a: 1, b: 2 });
      const viaFind = await d.collection(collection).find({}, { projection: { _id: 0 } }).toArray();
      const viaFindOne = await d.collection(collection).findOne({ a: 1 }, { projection: { _id: 0 } });
      return {
        find: Object.keys(viaFind[0]).sort(),
        findOne: Object.keys(viaFindOne ?? {}).sort(),
      };
    });

    assert.deepEqual(fake, { find: ["a", "b"], findOne: ["a", "b"] });
    assert.deepEqual(real, fake, "the fake must strip _id exactly as Mongo does");
  });

  it("agrees that _id survives when no projection is given", async function () {
    if (!realDb) return this.skip(skipReason);

    // The other direction, so the fix cannot overshoot into always
    // stripping — plenty of code legitimately reads `_id`.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ a: 1 });
      const docs = await d.collection(collection).find({}).toArray();
      return "_id" in docs[0];
    });

    assert.equal(fake, true);
    assert.equal(real, true);
  });

  it("agrees that countDocuments honours a limit", async function () {
    if (!realDb) return this.skip(skipReason);

    // `seedInitialAdmin` uses `countDocuments({}, { limit: 1 })` as an
    // existence check.
    const { fake, real } = await bothEngines(async (db: never, collection) => {
      const d = db as unknown as Db;
      await d.collection(collection).insertOne({ n: 1 });
      await d.collection(collection).insertOne({ n: 2 });
      await d.collection(collection).insertOne({ n: 3 });
      return d.collection(collection).countDocuments({}, { limit: 1 });
    });

    assert.equal(fake, 1);
    assert.equal(real, 1);
  });
});
