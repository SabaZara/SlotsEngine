import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { readAuditLog, writeAuditLog } from "./log.js";

/**
 * Tests for the audit log — the tamper-evidence record.
 *
 * This module had no direct test until the second sweep of `docs/TODO.md`
 * section A. It was reached only through route suites, which exercise it
 * with well-formed input and therefore never touched a clamp boundary.
 * Writing these found F22.
 *
 * Two contracts here are load-bearing and neither was pinned:
 *
 * 1. **`writeAuditLog` never throws into the caller's path.** An audit
 *    write failing must not roll back a publish that already succeeded.
 *    Losing the record of a change is bad; losing the change itself
 *    because we could not describe it is worse. Nothing tested that the
 *    `try` was there, so a refactor removing it would have been invisible
 *    until a failing Mongo took down a publish.
 * 2. **`readAuditLog` bounds what it returns.** The clamp is the only
 *    thing standing between a query string and an unbounded collection
 *    scan. F22 is what happens when it does not hold.
 *
 * ## A surviving mutation, and why it is equivalent
 *
 * Removing `Math.floor` from `clampLimit` does not fail these tests, and
 * no reasonable test would catch it: both `Array.prototype.slice` (what
 * `fakeMongo` uses) and the Mongo driver already truncate a fractional
 * limit, so `limit: 3.7` returns three documents either way. Measured
 * against real Mongo as well as the fake, and the clamped *value* does
 * differ (1.5 vs 1) — but nothing observable downstream does.
 *
 * The floor is kept anyway, because it makes this function's answer
 * *identical* to the database's rather than merely equivalent to it. A
 * clamp that reports 499.5 while the driver acts on 499 is one refactor
 * away from being wrong, and the cost of not relying on that coincidence
 * is one call.
 *
 * ## What these tests cannot establish
 *
 * That the route mounts the read behind `requireRole("operations")`, or
 * that there is no write route — both are `routes/audit.ts`'s territory
 * and are covered in `app.test.ts`. And because `fakeMongo` models no
 * schema validator, these cannot establish that a written entry satisfies
 * the real collection's validator; that is F9's blind spot, and the reason
 * the clamp fix was also verified against the live stack.
 *
 * They also cannot establish what the driver does with the clamped value,
 * since `fakeMongo` implements `limit` as a `slice`. The two disagree on
 * `NaN` — F22's mechanism — so that disagreement is pinned in
 * `fakeMongo.conformance.test.ts` against real Mongo rather than here.
 */

/** A valid entry, so a test that means to be malformed in one way is
 * malformed in exactly that way — the lesson from `passwords.test.ts`. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: "user-1",
    action: "game.publish",
    entityType: "game",
    entityId: "reference-5x3",
    ...overrides,
  } as never;
}

describe("writeAuditLog", () => {
  it("appends an entry that can be read back", async () => {
    const { db } = fakeMongo();
    await writeAuditLog(db, entry());

    const entries = await readAuditLog(db, {});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "game.publish");
    assert.equal(entries[0].entityId, "reference-5x3");
  });

  it("stamps an entryId and a timestamp the caller did not supply", async () => {
    const { db } = fakeMongo();
    await writeAuditLog(db, entry());

    const [written] = await readAuditLog(db, {});
    assert.ok(written.entryId, "entryId should be generated");
    assert.ok(written.timestamp, "timestamp should be generated");
    // ISO-8601, because the sort is lexicographic on this field and any
    // other format would silently order the log wrongly.
    assert.match(written.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("gives each entry a distinct entryId", async () => {
    const { db } = fakeMongo();
    await writeAuditLog(db, entry());
    await writeAuditLog(db, entry());

    const entries = await readAuditLog(db, {});
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].entryId, entries[1].entryId);
  });

  it("does not let the caller forge an entryId or timestamp", async () => {
    const { db } = fakeMongo();
    // The spread puts the caller's fields BEFORE the generated ones, so a
    // caller cannot backdate an entry or collide an id. If that order ever
    // flips, the log becomes something its own writers can shape.
    await writeAuditLog(db, entry({ entryId: "forged", timestamp: "1999-01-01T00:00:00.000Z" }));

    const [written] = await readAuditLog(db, {});
    assert.notEqual(written.entryId, "forged");
    assert.notEqual(written.timestamp, "1999-01-01T00:00:00.000Z");
  });

  /**
   * The swallow-and-report contract. This is the reason the module has a
   * `try` at all, and it is stated in the source as a promise.
   */
  it("never throws into the caller's path when the insert fails", async () => {
    const db = {
      collection: () => ({
        insertOne: async () => {
          throw new Error("mongo is down");
        },
      }),
    } as never;

    // The assertion is that this resolves at all. A publish must survive
    // its own audit write failing.
    await assert.doesNotReject(() => writeAuditLog(db, entry()));
  });

  it("hands the failure to the caller's logger rather than discarding it", async () => {
    const db = {
      collection: () => ({
        insertOne: async () => {
          throw new Error("mongo is down");
        },
      }),
    } as never;

    // Swallowing is only acceptable because the error still surfaces
    // somewhere. Silently losing it would make a broken audit log
    // indistinguishable from an idle one.
    const seen: unknown[] = [];
    await writeAuditLog(db, entry(), (err) => seen.push(err));

    assert.equal(seen.length, 1);
    assert.match((seen[0] as Error).message, /mongo is down/);
  });

  it("survives a failing insert with no error handler supplied", async () => {
    const db = {
      collection: () => ({
        insertOne: async () => {
          throw new Error("mongo is down");
        },
      }),
    } as never;

    // `onError` is optional; the optional call must not itself throw.
    await assert.doesNotReject(() => writeAuditLog(db, entry()));
  });

  it("does not call the error handler when the write succeeds", async () => {
    const { db } = fakeMongo();
    const seen: unknown[] = [];
    await writeAuditLog(db, entry(), (err) => seen.push(err));

    assert.equal(seen.length, 0);
  });
});

describe("readAuditLog", () => {
  /** Seeds `count` entries with distinct, ordered timestamps. */
  async function seed(db: ReturnType<typeof fakeMongo>["db"], count: number, overrides: (i: number) => Record<string, unknown> = () => ({})) {
    for (let i = 0; i < count; i++) {
      await db.collection("auditLogs").insertOne({
        entryId: `entry-${i}`,
        actorUserId: "user-1",
        action: "game.publish",
        entityType: "game",
        entityId: "reference-5x3",
        // Zero-padded so the lexicographic sort matches the numeric order.
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        ...overrides(i),
      });
    }
  }

  it("returns newest first, because the read pattern is always 'what happened recently'", async () => {
    const { db } = fakeMongo();
    await seed(db, 5);

    const entries = await readAuditLog(db, {});
    const timestamps = entries.map((e) => e.timestamp);
    assert.deepEqual(timestamps, [...timestamps].sort().reverse());
    assert.equal(entries[0].entryId, "entry-4");
  });

  it("strips _id, which is Mongo's internal key and not part of the entry", async () => {
    const { db } = fakeMongo();
    await seed(db, 1);

    const [read] = await readAuditLog(db, {});
    assert.ok(!("_id" in read), `_id leaked into the response: ${JSON.stringify(read)}`);
  });

  describe("filtering", () => {
    it("filters by each field independently", async () => {
      const { db } = fakeMongo();
      await seed(db, 4, (i) => ({
        entityId: i < 2 ? "game-a" : "game-b",
        entityType: i % 2 === 0 ? "game" : "user",
        actorUserId: i < 3 ? "user-1" : "user-2",
        action: i === 0 ? "game.publish" : "game.update",
      }));

      assert.equal((await readAuditLog(db, { entityId: "game-a" })).length, 2);
      assert.equal((await readAuditLog(db, { entityType: "user" })).length, 2);
      assert.equal((await readAuditLog(db, { actorUserId: "user-2" })).length, 1);
      assert.equal((await readAuditLog(db, { action: "game.publish" })).length, 1);
    });

    it("combines filters conjunctively rather than returning either match", async () => {
      const { db } = fakeMongo();
      await seed(db, 4, (i) => ({
        entityId: i < 2 ? "game-a" : "game-b",
        actorUserId: i % 2 === 0 ? "user-1" : "user-2",
      }));

      // game-a AND user-1 is one entry; an OR would give three.
      const entries = await readAuditLog(db, { entityId: "game-a", actorUserId: "user-1" });
      assert.equal(entries.length, 1);
    });

    it("returns everything when no filter is given", async () => {
      const { db } = fakeMongo();
      await seed(db, 3);

      assert.equal((await readAuditLog(db, {})).length, 3);
    });

    it("treats an empty-string filter as absent rather than matching empty", async () => {
      const { db } = fakeMongo();
      await seed(db, 3);

      // The guards are `if (query.entityId)`, so "" is falsy and skipped.
      // Filtering on "" would otherwise match nothing and read as "no
      // activity" rather than "you asked for nothing".
      assert.equal((await readAuditLog(db, { entityId: "" })).length, 3);
    });

    it("returns an empty list for a filter matching nothing", async () => {
      const { db } = fakeMongo();
      await seed(db, 3);

      assert.deepEqual(await readAuditLog(db, { entityId: "no-such-game" }), []);
    });
  });

  describe("the limit clamp", () => {
    it("defaults to 100 when no limit is given", async () => {
      const { db } = fakeMongo();
      await seed(db, 120);

      assert.equal((await readAuditLog(db, {})).length, 100);
    });

    it("honours a limit inside the band", async () => {
      const { db } = fakeMongo();
      await seed(db, 50);

      assert.equal((await readAuditLog(db, { limit: 10 })).length, 10);
    });

    it("caps at 500, so one query cannot pull an unbounded collection", async () => {
      const { db } = fakeMongo();
      await seed(db, 520);

      assert.equal((await readAuditLog(db, { limit: 10_000 })).length, 500);
    });

    it("raises a limit below 1 to 1 rather than returning nothing", async () => {
      const { db } = fakeMongo();
      await seed(db, 5);

      // Mongo treats limit(0) as "no limit", so clamping up to 1 is what
      // keeps a caller's `?limit=0` from becoming an unbounded scan.
      assert.equal((await readAuditLog(db, { limit: 0 })).length, 1);
      assert.equal((await readAuditLog(db, { limit: -5 })).length, 1);
    });

    /**
     * F22. `Math.min(Math.max(NaN, 1), 500)` is `NaN`, and the driver
     * treats a `NaN` limit as no limit at all — so `?limit=abc` returned
     * the entire collection through a code path whose whole purpose is
     * bounding it.
     */
    it("refuses a non-numeric limit instead of falling through to no limit", async () => {
      const { db } = fakeMongo();
      await seed(db, 150);

      // `Number("abc")` — what routes/audit.ts produces from a query string.
      const entries = await readAuditLog(db, { limit: Number("abc") });
      assert.equal(entries.length, 100, "a NaN limit must fall back to the default, not to unbounded");
    });

    it("bounds a limit of Infinity, treating it as unintelligible rather than as 'the maximum'", async () => {
      const { db } = fakeMongo();
      await seed(db, 520);

      // Grouped with NaN rather than with 10_000: a caller writing a real
      // number too large gets the cap, but `Infinity` is not a page size
      // anyone meant to ask for, and answering it with the largest scan
      // available is the wrong reading of an unintelligible request.
      assert.equal((await readAuditLog(db, { limit: Infinity })).length, 100);
      assert.equal((await readAuditLog(db, { limit: -Infinity })).length, 100);
    });

    it("floors a fractional limit to a whole number of documents", async () => {
      const { db } = fakeMongo();
      await seed(db, 10);

      // Real Mongo truncates 3.7 to 3. Pinned so the fake and the driver
      // cannot drift on it silently.
      assert.equal((await readAuditLog(db, { limit: 3.7 })).length, 3);
    });
  });
});
