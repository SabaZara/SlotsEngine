import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "./formatMoney.js";

/**
 * Display only. Every amount crossing the wire is an integer count of minor
 * units, and this is the one place division happens — no value derived here
 * is ever sent back, so a rounding artefact cannot become a money error.
 *
 * That is exactly why the tests below check what a *player sees* rather than
 * arithmetic: the failure mode here is not a corrupted ledger, it is a
 * player being shown a number that disagrees with their balance.
 *
 * Note this duplicates `shared-types/src/money.ts` rather than importing it.
 * That is a real (small) divergence risk and is recorded in docs/TODO.md; the
 * tests below pin the two to the same answers where they overlap.
 */

describe("formatMoney", () => {
  it("shows two-decimal currencies as a player expects", () => {
    assert.equal(formatMoney(1050, "USD"), "$10.50");
    assert.equal(formatMoney(100, "USD"), "$1.00");
    assert.equal(formatMoney(1, "USD"), "$0.01");
    assert.equal(formatMoney(0, "USD"), "$0.00");
  });

  it("keeps trailing zeros, so a balance reads as money and not as a count", () => {
    // "$10" for a balance of 1000 minor units invites the reading "ten
    // somethings" rather than ten dollars.
    assert.equal(formatMoney(1000, "USD"), "$10.00");
    assert.equal(formatMoney(1500, "USD"), "$15.00");
  });

  it("gives zero-decimal currencies no decimal point at all", () => {
    // 1000 JPY is 1000 yen, not 10.00. Formatting it with two decimals
    // divides a Japanese player's balance by a hundred on screen.
    assert.equal(formatMoney(1000, "JPY"), "¥1000");
    assert.equal(formatMoney(1, "JPY"), "¥1");
  });

  it("gives three-decimal currencies all three", () => {
    assert.equal(formatMoney(1000, "KWD"), "1.000");
    assert.equal(formatMoney(1, "KWD"), "0.001");
  });

  it("falls back to two decimals for an unknown currency", () => {
    // Matches `minorUnitsFor`'s fallback in shared-types. A game config with
    // a typo'd code must still render a plausible amount rather than crash
    // the reel display.
    assert.equal(formatMoney(1050, "ZZZ"), "10.50");
  });

  it("omits the symbol for a currency it has no symbol for, rather than printing a placeholder", () => {
    // No symbol is better than "?" or "undefined" in front of a balance.
    assert.equal(formatMoney(1050, "PLN"), "10.50");
    assert.equal(formatMoney(1050, "ZZZ").startsWith("undefined"), false);
  });

  it("uses the right symbol per currency", () => {
    assert.equal(formatMoney(100, "USD"), "$1.00");
    assert.equal(formatMoney(100, "EUR"), "€1.00");
    assert.equal(formatMoney(100, "GBP"), "£1.00");
    assert.equal(formatMoney(100, "GEL"), "₾1.00");
  });

  it("defaults to USD when no currency is given", () => {
    assert.equal(formatMoney(1050), "$10.50");
  });

  it("renders a negative amount with the sign before the symbol's value", () => {
    // Reachable if a balance is ever displayed mid-correction. It must not
    // render as "$-10.50" with the minus lost or doubled.
    assert.equal(formatMoney(-1050, "USD"), "$-10.50");
  });

  it("renders a large balance without switching to exponent notation", () => {
    // `toFixed` is what prevents 1e+21 appearing where a balance should be.
    // A jackpot-sized number is the worst possible place for that.
    assert.equal(formatMoney(1_000_000_00, "USD"), "$1000000.00");
    assert.equal(formatMoney(999_999_999_99, "USD").includes("e"), false);
  });

  it("agrees with shared-types on the currencies both know", () => {
    // The frontend deliberately does not import shared-types (it would pull
    // a Node-oriented package into a browser bundle), so this is the seam
    // where the two could drift apart unnoticed. Pinned against the same
    // expectations that file's own tests assert.
    assert.equal(formatMoney(1050, "USD").replace("$", ""), "10.50");
    assert.equal(formatMoney(1000, "JPY").replace("¥", ""), "1000");
    assert.equal(formatMoney(1000, "KWD"), "1.000");
  });
});
