import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { fakeMongo } from "../testing/fakeMongo.js";
import { consumeLaunchToken, LaunchTokenAlreadyUsedError } from "./consume.js";

/**
 * Single-use launch tokens.
 *
 * `routes/misc.test.ts` covers the HTTP boundary — 409 versus 401, which is
 * the difference between "this token is spent" and "this token is not
 * valid". Its own header names what it could not establish: **that a
 * *concurrent* double-consume is refused**. That is this file's job, and it
 * is a different guarantee from the sequential one.
 *
 * The distinction is F14's exactly, one module over. A sequential replay —
 * call, then call again — passes with or without a unique index, because
 * the second insert sees the first already committed. Two callers arriving
 * at the same instant is what the index actually exists for: both attempt
 * the insert, one wins, and the loser is told the token is spent. Nothing
 * tested that here, and the reference repo's own `consume.test.ts` covers
 * only the sequential case too, so reading it would not have closed this.
 *
 * The concurrency block therefore runs against **real MongoDB**, because
 * `fakeMongo` is single-threaded JavaScript: its "concurrent" inserts are
 * interleaved by the event loop, not raced, so it can model the *decision*
 * but never the guarantee. Same reasoning as `wallet.concurrency.test.ts`.
 *
 * ## What these cannot establish
 *
 * That the TTL index on `expireAt` actually reaps. Mongo's TTL monitor runs
 * on its own schedule (up to 60s), so asserting a real expiry here would
 * make the suite slow and flaky. `collections.test.ts` pins the index
 * declaration, and item 5's work established the rule that matters: the
 * field must be a genuine BSON `Date` or the monitor silently ignores it —
 * which is why the Date-ness is asserted below rather than assumed.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";
const MONGO_DB = process.env.MONGO_TEST_DB ?? "slots_engine_consume_test";

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
    // The index IS the mechanism under test — without it the race has no
    // arbiter and every assertion below would pass for the wrong reason.
    await realDb.collection("usedLaunchTokens").createIndex({ jti: 1 }, { unique: true });
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

describe("consumeLaunchToken", () => {
  it("accepts a token that has not been used", async () => {
    const { db } = fakeMongo();

    await assert.doesNotReject(() => consumeLaunchToken(db, randomUUID(), Date.now() + 60_000));
  });

  it("refuses the same token a second time — the single-use guarantee", async () => {
    const { db } = fakeMongo();
    const jti = randomUUID();

    await consumeLaunchToken(db, jti, Date.now() + 60_000);

    await assert.rejects(
      () => consumeLaunchToken(db, jti, Date.now() + 60_000),
      LaunchTokenAlreadyUsedError,
    );
  });

  it("throws a typed error, so the route can answer 409 rather than 500", async () => {
    // A spent token is a legitimate outcome the caller must be able to
    // distinguish from a forged one. An untyped throw becomes a 500 and
    // tells a returning player nothing actionable.
    const { db } = fakeMongo();
    const jti = randomUUID();
    await consumeLaunchToken(db, jti, Date.now() + 60_000);

    await assert.rejects(
      () => consumeLaunchToken(db, jti, Date.now() + 60_000),
      (err: unknown) => {
        assert.ok(err instanceof LaunchTokenAlreadyUsedError);
        assert.match((err as Error).message, new RegExp(jti), "the error must name the token");
        return true;
      },
    );
  });

  it("lets two DIFFERENT tokens through independently", async () => {
    // The guard must be keyed on the jti. A collection-wide or
    // player-wide lock would refuse every second launch in the system.
    const { db } = fakeMongo();

    await consumeLaunchToken(db, randomUUID(), Date.now() + 60_000);
    await assert.doesNotReject(() => consumeLaunchToken(db, randomUUID(), Date.now() + 60_000));
  });

  it("stores expireAt as a real Date, not a number or a string", async () => {
    // Item 5's lesson, and it is load-bearing rather than cosmetic: Mongo's
    // TTL monitor only reaps a field that is a genuine BSON Date. A number
    // or an ISO string is silently ignored and the row lives forever —
    // confirmed against real Mongo during the bonus-session work.
    const { db, raw } = fakeMongo();
    const jti = randomUUID();
    const expiresAt = Date.now() + 60_000;

    await consumeLaunchToken(db, jti, expiresAt);

    const stored = raw.collection("usedLaunchTokens").all()[0];
    assert.ok(stored.expireAt instanceof Date, `expireAt must be a Date, got ${typeof stored.expireAt}`);
    assert.equal((stored.expireAt as Date).getTime(), expiresAt);
  });

  it("rethrows a non-duplicate-key failure rather than reporting it as a spent token", async () => {
    // Mapping every error to "already used" would tell a player their
    // token was spent when the database was simply unreachable — and would
    // hide a real outage behind a plausible-looking 409.
    const db = {
      collection: () => ({
        insertOne: async () => {
          throw Object.assign(new Error("connection reset"), { code: 6 });
        },
      }),
    } as never;

    await assert.rejects(
      () => consumeLaunchToken(db, randomUUID(), Date.now() + 60_000),
      (err: unknown) => {
        assert.ok(!(err instanceof LaunchTokenAlreadyUsedError), "a transport failure is not a spent token");
        assert.match((err as Error).message, /connection reset/);
        return true;
      },
    );
  });

  /**
   * The half `misc.test.ts` explicitly could not reach, against real Mongo
   * because the fake cannot race.
   */
  describe("under real concurrency", () => {
    it("lets exactly one of many simultaneous consumers win", async function () {
      if (!realDb) return this.skip(skipReason);

      // The guarantee that matters. All twelve callers observe an unused
      // token; the unique index decides, not the application code. Remove
      // the index and this fails with twelve winners — which is precisely
      // the F1 shape, where an index that did not do what it looked like it
      // did passed every unit test.
      const jti = randomUUID();
      const attempts = 12;

      const outcomes = await Promise.allSettled(
        Array.from({ length: attempts }, () => consumeLaunchToken(realDb!, jti, Date.now() + 60_000)),
      );

      const won = outcomes.filter((o) => o.status === "fulfilled").length;
      const refused = outcomes.filter(
        (o) => o.status === "rejected" && o.reason instanceof LaunchTokenAlreadyUsedError,
      ).length;

      assert.equal(won, 1, `exactly one caller may consume a token, got ${won}`);
      assert.equal(refused, attempts - 1, "every loser must be told the token is spent, not given another error");
    });

    it("writes exactly one row, so the winner is unambiguous in the record", async function () {
      if (!realDb) return this.skip(skipReason);

      // A double-consume that both succeeded AND left two rows would be
      // invisible to the count above if the second insert silently
      // upserted. Asserted separately because "one caller succeeded" and
      // "one row exists" are different claims.
      const jti = randomUUID();

      await Promise.allSettled(
        Array.from({ length: 8 }, () => consumeLaunchToken(realDb!, jti, Date.now() + 60_000)),
      );

      const rows = await realDb.collection("usedLaunchTokens").countDocuments({ jti });
      assert.equal(rows, 1, "a raced token must leave exactly one record");
    });

    it("does not serialise unrelated tokens against each other", async function () {
      if (!realDb) return this.skip(skipReason);

      // The other direction: the index must not make concurrent launches of
      // *different* tokens contend. A guard that refused these would be
      // safe and would break every simultaneous player.
      const jtis = Array.from({ length: 10 }, () => randomUUID());

      const outcomes = await Promise.allSettled(
        jtis.map((jti) => consumeLaunchToken(realDb!, jti, Date.now() + 60_000)),
      );

      assert.equal(
        outcomes.filter((o) => o.status === "fulfilled").length,
        jtis.length,
        "distinct tokens must all succeed concurrently",
      );
    });
  });
});
