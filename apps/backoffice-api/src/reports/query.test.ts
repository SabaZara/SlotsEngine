import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidReportQueryError,
  buildTransactionFilter,
  clampLimit,
  parseCursor,
  parseDateRange,
} from "./query.js";

/**
 * The query layer, tested without a database because none of it needs one.
 *
 * The property under test throughout is the same: **a malformed input must
 * become an error, never an empty result.** That distinction is invisible
 * in a report — "no transactions matched" and "your date was nonsense"
 * render identically — and it is the reason F22 went unnoticed: a `NaN`
 * that made every comparison false, in code whose job was bounding a page.
 */

describe("parseDateRange", () => {
  it("accepts an open-ended range, because most reports have one end", () => {
    assert.deepEqual(parseDateRange(undefined, undefined), {});
    assert.equal(parseDateRange("2026-03-01", undefined).to, undefined);
    assert.equal(parseDateRange(undefined, "2026-03-31").from, undefined);
  });

  it("parses both ends when given", () => {
    const range = parseDateRange("2026-03-01T00:00:00.000Z", "2026-03-31T23:59:59.999Z");
    assert.equal(range.from?.toISOString(), "2026-03-01T00:00:00.000Z");
    assert.equal(range.to?.toISOString(), "2026-03-31T23:59:59.999Z");
  });

  it("refuses an unparseable date instead of matching nothing", () => {
    // The core claim. `new Date("last tuesday")` is an Invalid Date, and
    // Mongo treats `$gte: Invalid Date` as excluding every document — so
    // without this the report says "no transactions" and someone believes
    // it.
    assert.throws(() => parseDateRange("last tuesday", undefined), InvalidReportQueryError);
    assert.throws(() => parseDateRange(undefined, "31/03/2026"), InvalidReportQueryError);
  });

  it("names which end was wrong, so the caller can fix the right field", () => {
    try {
      parseDateRange("nonsense", "2026-03-31");
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal((err as InvalidReportQueryError).code, "invalid_from_date");
    }
  });

  it("refuses a reversed range rather than returning nothing", () => {
    // `from > to` matches no documents, which is indistinguishable from a
    // quiet period. It is always a mistake, so it is always an error.
    assert.throws(() => parseDateRange("2026-03-31", "2026-03-01"), InvalidReportQueryError);
  });

  it("treats an empty string as absent, which is what a blank form field sends", () => {
    assert.deepEqual(parseDateRange("", ""), {});
  });
});

describe("clampLimit", () => {
  it("uses the default when no limit is asked for", () => {
    assert.equal(clampLimit(undefined, 100, 1000), 100);
    assert.equal(clampLimit("", 100, 1000), 100);
  });

  it("honours a limit inside the range", () => {
    assert.equal(clampLimit("250", 100, 1000), 250);
  });

  it("caps at the maximum rather than trusting the caller", () => {
    assert.equal(clampLimit("999999", 100, 1000), 1000);
  });

  it("falls back to the default for a non-numeric limit, never to no limit at all", () => {
    // **F22, exactly.** `Math.min(Math.max(NaN, 1), 1000)` is `NaN`, and
    // the Mongo driver reads a `NaN` limit as unbounded — so the one
    // expression whose purpose is bounding the page returned the entire
    // collection. Asserting the value is finite is the part that matters;
    // asserting it equals the default is the bonus.
    const limit = clampLimit("abc", 100, 1000);
    assert.equal(Number.isFinite(limit), true, "a non-finite limit means no limit to the driver");
    assert.equal(limit, 100);
  });

  it("refuses Infinity, which is finite-looking enough to slip through a naive check", () => {
    assert.equal(clampLimit("Infinity", 100, 1000), 100);
  });

  it("treats a zero or negative limit as one row, not as the default", () => {
    // `Number(x) || default` conflates these with garbage: `0` is falsy, so
    // a caller asking for nothing silently gets a hundred rows. Clamping
    // says what was actually asked for as closely as it can be honoured.
    assert.equal(clampLimit("0", 100, 1000), 1);
    assert.equal(clampLimit("-5", 100, 1000), 1);
  });

  it("truncates a fractional limit rather than passing it to the driver", () => {
    assert.equal(clampLimit("10.9", 100, 1000), 10);
  });
});

describe("parseCursor", () => {
  it("is absent when not supplied", () => {
    assert.equal(parseCursor(undefined), undefined);
    assert.equal(parseCursor(""), undefined);
  });

  it("parses an ISO timestamp from a previous page", () => {
    assert.equal(parseCursor("2026-03-15T12:00:00.000Z")?.toISOString(), "2026-03-15T12:00:00.000Z");
  });

  it("refuses a mangled cursor rather than serving a silently empty page", () => {
    // A truncated or edited cursor would otherwise produce `$lt: Invalid
    // Date`, which matches nothing — so paging would end early and a
    // caller looping until `hasMore` is false would stop mid-report.
    assert.throws(() => parseCursor("not-a-cursor"), InvalidReportQueryError);
  });
});

describe("buildTransactionFilter", () => {
  it("filters by operator and player when given", () => {
    const filter = buildTransactionFilter({ operatorId: "op-1", playerId: "p-1", range: {} });
    assert.equal(filter.operatorId, "op-1");
    assert.equal(filter.playerId, "p-1");
  });

  it("omits absent fields rather than matching on undefined", () => {
    // `{ operatorId: undefined }` is not the same query as `{}` — with
    // `ignoreUndefined` unset it matches documents where the field is
    // missing, which is every one of them or none.
    const filter = buildTransactionFilter({ range: {} });
    assert.deepEqual(filter, {});
  });

  it("turns a date range into a createdAt bound", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-31T00:00:00.000Z");
    const filter = buildTransactionFilter({ range: { from, to } }).createdAt as Record<string, Date>;

    assert.equal(filter.$gte, from);
    assert.equal(filter.$lte, to);
  });

  it("keeps a cursor from widening the range the caller asked for", () => {
    // The bug this prevents: page two of a March report showing April.
    // A cursor is an upper bound *within* the range, never a replacement
    // for it — so when the range ends before the cursor, the range wins.
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-31T00:00:00.000Z");
    const before = new Date("2026-05-01T00:00:00.000Z");

    const filter = buildTransactionFilter({ range: { from, to }, before }).createdAt as Record<string, Date>;

    assert.equal(filter.$gte, from, "the lower bound is untouched");
    assert.equal(filter.$lt?.toISOString(), to.toISOString(), "the tighter of the two bounds applies");
  });

  it("uses the cursor when it is tighter than the range", () => {
    const to = new Date("2026-03-31T00:00:00.000Z");
    const before = new Date("2026-03-15T00:00:00.000Z");

    const filter = buildTransactionFilter({ range: { to }, before }).createdAt as Record<string, Date>;

    assert.equal(filter.$lt?.toISOString(), before.toISOString());
    assert.equal(filter.$lte, undefined, "the looser bound is removed rather than left to coexist");
  });
});
