import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCsv } from "./csv.js";

/**
 * CSV escaping.
 *
 * Worth its own file because the failure mode is quiet: a field that
 * breaks out of its column does not produce a file that looks broken. It
 * produces one that opens cleanly in a spreadsheet with values in the
 * wrong columns — and this is the export someone reconciles money against,
 * so "looks fine, is wrong" is the expensive outcome.
 */

const COLUMNS = ["a", "b"];

describe("toCsv", () => {
  it("writes a header even when there are no rows", () => {
    // An empty file and a file with headers are different answers: the
    // second says "this query ran and matched nothing", the first says
    // nothing at all and reads as a failed download.
    assert.equal(toCsv([], COLUMNS), "a,b");
  });

  it("writes the columns in the order given, not the order the row has them", () => {
    // Row key order is insertion order, which varies with how a document
    // was built. A header derived from it would silently shift columns
    // between exports.
    assert.equal(toCsv([{ b: 2, a: 1 }], COLUMNS), "a,b\n1,2");
  });

  it("leaves a gap for a column a row does not have", () => {
    // `roundId` is absent on a cash-in. The cell must be empty, not the
    // text "undefined", which a spreadsheet would treat as data.
    assert.equal(toCsv([{ a: 1 }], COLUMNS), "a,b\n1,");
  });

  it("writes an empty cell for null, rather than the word null", () => {
    assert.equal(toCsv([{ a: null, b: 2 }], COLUMNS), "a,b\n,2");
  });

  it("quotes a field containing a comma, so it stays in its column", () => {
    // The whole point of the escaping. Unquoted, "Acme, Inc." becomes two
    // columns and every value after it on that row shifts left by one.
    assert.equal(toCsv([{ a: "Acme, Inc.", b: 2 }], COLUMNS), 'a,b\n"Acme, Inc.",2');
  });

  it("doubles internal quotes, per RFC 4180", () => {
    assert.equal(toCsv([{ a: 'say "hi"', b: 2 }], COLUMNS), 'a,b\n"say ""hi""",2');
  });

  it("quotes a field containing a newline, so it does not become a new row", () => {
    assert.equal(toCsv([{ a: "line1\nline2", b: 2 }], COLUMNS), 'a,b\n"line1\nline2",2');
  });

  it("quotes a field containing a lone carriage return", () => {
    // Excel treats a bare \r as a line break, so a field carrying one
    // would split a row even though \n never appears.
    assert.equal(toCsv([{ a: "line1\rline2", b: 2 }], COLUMNS), 'a,b\n"line1\rline2",2');
  });

  it("leaves ordinary values unquoted", () => {
    // Quoting everything would also be correct, and is rejected: it makes
    // the file harder to read and diff, and hides which fields genuinely
    // needed escaping.
    assert.equal(toCsv([{ a: "plain", b: 42 }], COLUMNS), "a,b\nplain,42");
  });

  it("survives a value that is an object rather than a scalar", () => {
    // Not expected on a transaction row, but a stringified object
    // containing a comma is the exact shape that breaks a column — so the
    // escaping must apply to whatever String() produces, not only to
    // strings.
    const csv = toCsv([{ a: { nested: true }, b: 2 }], COLUMNS);
    assert.equal(csv.includes("\n"), true);
    assert.equal(csv.split("\n")[1]!.endsWith(",2"), true, "the row must still have exactly two columns");
  });
});
