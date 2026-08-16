import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CURRENCY,
  formatMoney,
  fromMinorUnits,
  minorUnitsFor,
  splitIntegerEvenly,
  toMinorUnits,
} from "./money.js";

/**
 * What these tests cannot establish: that the rest of the codebase actually
 * routes its money through these functions. They pin the helpers' contract,
 * not their adoption — a route that does its own `amount * 100` is invisible
 * here and would be a real bug of exactly the kind this module exists to
 * prevent.
 *
 * The property this file cares about most is that `splitIntegerEvenly`
 * creates and destroys nothing: a spin's bet divided across paylines must
 * still add up to the bet.
 */

describe("minorUnitsFor", () => {
  it("gives 100 for the ordinary two-decimal currencies", () => {
    assert.equal(minorUnitsFor("USD"), 100);
    assert.equal(minorUnitsFor("EUR"), 100);
    assert.equal(minorUnitsFor("GEL"), 100);
  });

  it("gives 1 for currencies with no minor unit at all", () => {
    // JPY has no subdivision: 1000 JPY is 1000, not 10.00. Treating it as
    // two-decimal would divide every Japanese balance by a hundred.
    assert.equal(minorUnitsFor("JPY"), 1);
    assert.equal(minorUnitsFor("KRW"), 1);
  });

  it("gives 1000 for three-decimal currencies", () => {
    assert.equal(minorUnitsFor("KWD"), 1000);
    assert.equal(minorUnitsFor("BHD"), 1000);
  });

  it("falls back to 100 for an unknown code rather than throwing", () => {
    // Deliberate, and documented on the function: a typo'd currency on a
    // game config should not crash evaluation. The authoring UI is the gate
    // on which codes exist.
    assert.equal(minorUnitsFor("ZZZ"), 100);
    assert.equal(minorUnitsFor(""), 100);
  });

  it("is case-sensitive, matching ISO 4217 as written", () => {
    // Pinned as the current contract rather than endorsed: "usd" taking the
    // fallback happens to give the same 100, but "jpy" would silently
    // become two-decimal. Worth knowing if a lowercase code ever appears.
    assert.equal(minorUnitsFor("jpy"), 100);
  });
});

describe("toMinorUnits / fromMinorUnits", () => {
  it("round-trips a two-decimal amount", () => {
    assert.equal(toMinorUnits(10.5, "USD"), 1050);
    assert.equal(fromMinorUnits(1050, "USD"), 10.5);
  });

  it("round-trips a zero-decimal amount unchanged", () => {
    assert.equal(toMinorUnits(1000, "JPY"), 1000);
    assert.equal(fromMinorUnits(1000, "JPY"), 1000);
  });

  it("defaults to USD when no currency is given", () => {
    assert.equal(DEFAULT_CURRENCY, "USD");
    assert.equal(toMinorUnits(10.5), 1050);
    assert.equal(fromMinorUnits(1050), 10.5);
  });

  it("rounds rather than truncating, so a half-cent does not vanish", () => {
    assert.equal(toMinorUnits(10.505, "USD"), 1051);
    assert.equal(toMinorUnits(10.504, "USD"), 1050);
  });

  it("absorbs the binary-float error that makes naive multiplication wrong", () => {
    // 70.07 * 100 is 7006.999999999999 in IEEE754, so `Math.trunc` here
    // would charge a player 70.06. This is the entire reason the codebase
    // stores integers and converts only at the edges.
    assert.equal(70.07 * 100 < 7007, true, "the float error this test is about still exists");
    assert.equal(toMinorUnits(70.07, "USD"), 7007);
  });

  it("converts a negative amount, as a refund or correction needs", () => {
    assert.equal(toMinorUnits(-10.5, "USD"), -1050);
    assert.equal(fromMinorUnits(-1050, "USD"), -10.5);
  });

  it("converts zero to zero", () => {
    assert.equal(toMinorUnits(0, "USD"), 0);
    assert.equal(fromMinorUnits(0, "USD"), 0);
  });
});

describe("formatMoney", () => {
  it("shows each currency's real number of decimal places", () => {
    assert.equal(formatMoney(1050, "USD"), "10.50");
    assert.equal(formatMoney(1000, "JPY"), "1000");
    assert.equal(formatMoney(1000, "KWD"), "1.000");
  });

  it("adds no currency symbol, leaving that to the caller", () => {
    const formatted = formatMoney(1050, "USD");
    assert.equal(/[$€£¥]/.test(formatted), false);
  });

  it("keeps trailing zeros, so a balance reads as money rather than a number", () => {
    assert.equal(formatMoney(1000, "USD"), "10.00");
    assert.equal(formatMoney(1, "USD"), "0.01");
    assert.equal(formatMoney(0, "USD"), "0.00");
  });

  it("formats a negative amount with its sign", () => {
    assert.equal(formatMoney(-1050, "USD"), "-10.50");
  });

  it("uses two decimals for an unknown currency, matching minorUnitsFor's fallback", () => {
    assert.equal(formatMoney(1050, "ZZZ"), "10.50");
  });
});

describe("splitIntegerEvenly", () => {
  it("divides evenly when it can", () => {
    assert.deepEqual(splitIntegerEvenly(9, 3), [3, 3, 3]);
    assert.deepEqual(splitIntegerEvenly(0, 3), [0, 0, 0]);
  });

  it("gives the remainder to the earliest parts, one unit each", () => {
    // Largest-remainder. Which parts get the extra unit is deterministic by
    // index and not a fairness question — paylines already differ in the
    // positions they cover.
    assert.deepEqual(splitIntegerEvenly(10, 3), [4, 3, 3]);
    assert.deepEqual(splitIntegerEvenly(40, 3), [14, 13, 13]);
    assert.deepEqual(splitIntegerEvenly(1, 5), [1, 0, 0, 0, 0]);
  });

  it("creates and destroys no minor unit, for any total and part count", () => {
    // The property that matters. A split whose parts do not sum to the bet
    // is money invented or money lost, and both are ledger corruption.
    for (let total = 0; total <= 60; total++) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitIntegerEvenly(total, n);
        assert.equal(parts.length, n, `expected ${n} parts for total=${total}`);
        assert.equal(
          parts.reduce((a, b) => a + b, 0),
          total,
          `parts of split(${total}, ${n}) did not sum to the total`,
        );
        assert.ok(
          parts.every((p) => Number.isInteger(p)),
          `split(${total}, ${n}) produced a non-integer part`,
        );
      }
    }
  });

  it("keeps every part within one unit of every other", () => {
    // The other half of "even": summing correctly is not enough, since
    // [total, 0, 0, …] also sums correctly and is not a split.
    for (const [total, n] of [[100, 7], [999, 4], [40, 3], [7, 7], [5, 8]] as const) {
      const parts = splitIntegerEvenly(total, n);
      assert.ok(
        Math.max(...parts) - Math.min(...parts) <= 1,
        `split(${total}, ${n}) = ${JSON.stringify(parts)} is not evenly spread`,
      );
    }
  });

  it("still sums exactly for a negative total, as a reversal would need", () => {
    // Math.floor rounds toward negative infinity, so the remainder lands on
    // the *last* parts here rather than the first — the mirror of the
    // positive case. Pinned because it is surprising, and because the sum
    // invariant is what actually matters.
    assert.deepEqual(splitIntegerEvenly(-10, 3), [-3, -3, -4]);
    for (const [total, n] of [[-10, 3], [-1, 5], [-40, 3], [-999, 7]] as const) {
      const parts = splitIntegerEvenly(total, n);
      assert.equal(parts.reduce((a, b) => a + b, 0), total);
      assert.ok(parts.every((p) => Number.isInteger(p)));
    }
  });

  it("splits into one part by returning the whole total", () => {
    assert.deepEqual(splitIntegerEvenly(37, 1), [37]);
  });

  it("refuses a non-integer total, rather than producing fractional money", () => {
    assert.throws(() => splitIntegerEvenly(10.5, 3), /integer total/);
  });

  it("refuses a zero or negative part count", () => {
    assert.throws(() => splitIntegerEvenly(10, 0), /positive integer n/);
    assert.throws(() => splitIntegerEvenly(10, -1), /positive integer n/);
    assert.throws(() => splitIntegerEvenly(10, 2.5), /positive integer n/);
  });

  it("names the offending values in the refusal", () => {
    // A stack trace saying only "invalid arguments" is a bad afternoon when
    // it fires inside a spin.
    assert.throws(() => splitIntegerEvenly(10.5, 3), /total=10\.5/);
    assert.throws(() => splitIntegerEvenly(10.5, 3), /n=3/);
  });
});
