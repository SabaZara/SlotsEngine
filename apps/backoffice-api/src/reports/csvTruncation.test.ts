import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSV_EXPORT_LIMIT, decideCsvTruncation } from "./routes.js";

/**
 * The CSV export's ceiling.
 *
 * **This exists because the ceiling had never been demonstrated.** The
 * truncation branch lived inline in the route, and the only way to reach it
 * was to export more than 50,000 rows — which nothing in the suite does. So
 * the slice, the `x-truncated` header and the appended `# TRUNCATED` row
 * had never executed in a test, while every surrounding case passed.
 *
 * That is the verification standard's fifth entry in miniature: reaching a
 * limit and being refused by one are different events, and only the second
 * proves anything. Here it matters more than usual, because the entire
 * purpose of these signals is that **a truncated financial export must not
 * look complete** — and F31 is already the record of that exact signal
 * being broken in a way no test caught.
 *
 * The limit is a parameter, so the boundary is driven with three rows
 * rather than fifty thousand and one. The route passes the real constant,
 * pinned below so the two cannot drift apart.
 *
 * What this cannot establish: that the *database* returns `limit + 1` rows.
 * That is the route's query, covered against real MongoDB in
 * `routes.test.ts` — this is the decision made on whatever it returns.
 */

const row = (id: number) => ({ transactionId: `tx-${id}` });

describe("under the ceiling", () => {
  it("reports nothing truncated and exports every row", () => {
    const rows = [row(1), row(2)];
    const result = decideCsvTruncation(rows, 3);

    assert.equal(result.truncated, false);
    assert.equal(result.exported.length, 2);
    assert.equal(result.notice, undefined, "no notice when nothing was cut");
  });

  it("treats exactly the cap as complete, not as truncated", () => {
    // The boundary a `>=` would get wrong: a limit of 3 means three rows
    // fit. Reporting that file as incomplete would send someone narrowing
    // a date range to solve a problem they do not have.
    const result = decideCsvTruncation([row(1), row(2), row(3)], 3);

    assert.equal(result.truncated, false);
    assert.equal(result.exported.length, 3);
    assert.equal(result.notice, undefined);
  });

  it("handles an empty result without inventing a truncation", () => {
    const result = decideCsvTruncation([], 3);
    assert.equal(result.truncated, false);
    assert.equal(result.exported.length, 0);
  });
});

describe("when the ceiling actually binds", () => {
  // The route fetches `limit + 1`, so one extra row IS the signal.
  const rows = [row(1), row(2), row(3), row(4)];

  it("says it truncated", () => {
    assert.equal(decideCsvTruncation(rows, 3).truncated, true);
  });

  it("cuts the file down to the cap, not to the fetched count", () => {
    // The off-by-one that would ship a 50,001-row file from a 50,000 cap.
    const result = decideCsvTruncation(rows, 3);
    assert.equal(result.exported.length, 3);
  });

  it("keeps the NEWEST rows, because the query sorts newest first", () => {
    // Slicing from the wrong end drops exactly the rows someone
    // reconciling a recent period came for — and the file would still open
    // cleanly, with no sign anything was missing.
    const result = decideCsvTruncation(rows, 3);
    assert.deepEqual(
      result.exported.map((r) => r.transactionId),
      ["tx-1", "tx-2", "tx-3"],
    );
  });

  it("emits a notice naming the cap, so a spreadsheet reader is told too", () => {
    // A header is invisible to someone who opens the file in Excel, which
    // is what most people do with it. The comment row is what reaches them.
    const result = decideCsvTruncation(rows, 3);

    assert.ok(result.notice, "a truncated export must carry a notice");
    assert.match(result.notice!, /^# TRUNCATED/, "starts with a comment marker, so a parser can skip it");
    assert.match(result.notice!, /more than 3 rows matched/, "names the actual cap, not a hardcoded number");
    assert.match(result.notice!, /Narrow the date range/, "and says what to do about it");
  });

  it("does not mutate the rows it was given", () => {
    // The caller still holds the fetched array.
    const original = [row(1), row(2), row(3), row(4)];
    decideCsvTruncation(original, 3);
    assert.equal(original.length, 4);
  });
});

describe("the cap the route actually uses", () => {
  it("is 50,000", () => {
    // Pinned so the constant and the tests above cannot drift apart: these
    // drive the boundary at 3, and this is what says 3 stands in for.
    assert.equal(CSV_EXPORT_LIMIT, 50_000);
  });
});
