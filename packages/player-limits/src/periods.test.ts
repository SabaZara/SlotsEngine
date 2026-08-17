import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { periodKey } from "./periods.js";

/**
 * Period keys.
 *
 * These are pure string arithmetic, so everything here is directly
 * testable — which matters more than usual because a wrong key is not a
 * crash. It is a counter that resets when it should not, handing a player
 * a fresh allowance against a limit they had already reached, and nothing
 * anywhere raises an error.
 *
 * What these cannot establish: that UTC is the right boundary for a given
 * market. It is a recorded decision, not a derived one — see the note in
 * `periods.ts`.
 */

describe("daily keys", () => {
  it("names the UTC day, not the local one", () => {
    // 23:30 UTC on the 18th is already the 19th in Tokyo. The key must
    // follow UTC, or the same instant buckets differently depending on
    // where the server happens to run.
    assert.equal(periodKey("daily", new Date("2026-08-18T23:30:00.000Z")), "2026-08-18");
  });

  it("rolls at midnight UTC and not a moment before", () => {
    assert.equal(periodKey("daily", new Date("2026-08-18T23:59:59.999Z")), "2026-08-18");
    assert.equal(periodKey("daily", new Date("2026-08-19T00:00:00.000Z")), "2026-08-19");
  });

  it("zero-pads, so keys sort chronologically as strings", () => {
    // Unpadded, "2026-9-1" sorts before "2026-10-1", which would make any
    // range query over these keys quietly wrong.
    assert.equal(periodKey("daily", new Date("2026-09-01T12:00:00.000Z")), "2026-09-01");
  });
});

describe("monthly keys", () => {
  it("names the month, counting January as 01 rather than 00", () => {
    // `getUTCMonth()` is zero-based; forgetting the +1 shifts every key by
    // a month and is invisible until someone compares a key to a date.
    assert.equal(periodKey("monthly", new Date("2026-01-15T12:00:00.000Z")), "2026-01");
    assert.equal(periodKey("monthly", new Date("2026-12-31T23:59:59.999Z")), "2026-12");
  });

  it("rolls at the first instant of the next month", () => {
    assert.equal(periodKey("monthly", new Date("2026-08-31T23:59:59.999Z")), "2026-08");
    assert.equal(periodKey("monthly", new Date("2026-09-01T00:00:00.000Z")), "2026-09");
  });
});

describe("weekly keys", () => {
  it("holds one key across a whole ISO week, Monday to Sunday", () => {
    // 2026-08-17 is a Monday. Every day through Sunday must share a key,
    // or a weekly limit resets mid-week.
    const monday = periodKey("weekly", new Date("2026-08-17T00:00:00.000Z"));
    for (const day of ["18", "19", "20", "21", "22", "23"]) {
      assert.equal(periodKey("weekly", new Date(`2026-08-${day}T12:00:00.000Z`)), monday, `2026-08-${day}`);
    }
  });

  it("rolls on Monday, not on Sunday", () => {
    // The off-by-one that a Sunday-start implementation produces. Both
    // conventions look reasonable; only one is ISO, and mixing them across
    // a change would split one week's stakes into two counters.
    const sunday = periodKey("weekly", new Date("2026-08-23T23:59:59.999Z"));
    const monday = periodKey("weekly", new Date("2026-08-24T00:00:00.000Z"));
    assert.notEqual(sunday, monday, "a new week must start on Monday");
    assert.equal(sunday, periodKey("weekly", new Date("2026-08-17T00:00:00.000Z")));
  });

  it("keeps a new-year week whole rather than resetting mid-week", () => {
    // The reason ISO weeks are used at all. 2026-12-31 is a Thursday, so
    // the week 2026-12-28..2027-01-03 belongs to 2026 under ISO. A naive
    // `getUTCFullYear()` + week number would emit a 2027 key on 1 January
    // and hand the player a fresh weekly allowance three days early.
    const december = periodKey("weekly", new Date("2026-12-31T12:00:00.000Z"));
    const january = periodKey("weekly", new Date("2027-01-01T12:00:00.000Z"));
    assert.equal(december, january, "one ISO week must keep one key across the year boundary");
    assert.match(december, /^2026-W\d\d$/);
  });

  it("gives a new week its own key once the ISO year genuinely turns", () => {
    // The other side of the case above — the guard must not be so eager
    // that January never starts a new week.
    assert.notEqual(
      periodKey("weekly", new Date("2027-01-03T12:00:00.000Z")),
      periodKey("weekly", new Date("2027-01-04T12:00:00.000Z")),
    );
  });

  it("does not mutate the date it was given", () => {
    // The implementation steps a Date to that week's Thursday. Doing it in
    // place would move the caller's clock reading, and the caller is the
    // spin path deciding which counters to increment.
    const at = new Date("2026-08-18T12:00:00.000Z");
    periodKey("weekly", at);
    assert.equal(at.toISOString(), "2026-08-18T12:00:00.000Z");
  });
});

describe("an unusable clock reading", () => {
  it("throws rather than minting a shared NaN bucket", () => {
    // An Invalid Date would render as "NaN-NaN-NaN" — a real key that
    // every other invalid date also produces, so unrelated players'
    // stakes would accumulate in one counter. F22's shape: the danger is
    // the plausible wrong number, not the crash.
    assert.throws(() => periodKey("daily", new Date("not a date")), RangeError);
  });
});
