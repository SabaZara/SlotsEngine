import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameDefinition } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { evaluatePaylines } from "./paylines.js";

/**
 * Direct tests for payline evaluation — the code that decides what a spin
 * pays.
 *
 * `independentModelCrossCheck.test.ts` checks this against a second,
 * hand-derived probability model in aggregate. That catches a rule being
 * wrong; it cannot say *which* rule, because it only sees the mean over
 * 200,000 spins. These tests pin each rule on a fixed grid, so a failure
 * names the behaviour that broke.
 *
 * The fixture is built here rather than borrowed from the reference game,
 * so that a later tuning change to the reference paytable cannot silently
 * alter what these assert.
 *
 * A note on the rule this repo actually implements, because it differs
 * from the obvious alternative: a run pays at whatever length it reaches,
 * so a 3-reel line can pay a 2-of-a-kind if the paytable has an entry for
 * 2. Some engines pay only full-length lines. This one does not, and the
 * tests below are written for the rule that exists here.
 */

const GAME: GameDefinition = {
  gameId: "payline-test",
  name: "Payline fixture",
  version: 1,
  status: "published",
  grid: { reels: 5, rows: 3 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [],
  // Line 0 reads the middle row straight across; line 1 is a V.
  paylines: [
    [1, 1, 1, 1, 1],
    [0, 1, 2, 1, 0],
  ],
  symbols: [
    { symbol: "A", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 2: 2, 3: 5, 4: 20, 5: 100 } },
    { symbol: "B", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 3 } },
    { symbol: "S", allowedReels: [0, 1, 2, 3, 4], role: "scatter", paytable: { 3: 4 } },
    {
      symbol: "W",
      allowedReels: [0, 1, 2, 3, 4],
      role: "wild",
      wildConfig: { substitutesFor: "all-regular" },
    },
  ],
  bonusModules: [],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

/** Two paylines and a bet of 100 gives a clean line stake of 50 each. */
const BET = 100;
const LINE_STAKE = 50;

/** Builds a 5x3 grid from five reel columns, padding with a symbol that
 * never appears on a payline path used here. */
function grid(...reels: string[][]): Matrix {
  return reels.map((r) => [...r]);
}

/** A grid whose middle row (line 0) is exactly `row`, with the other rows
 * filled by a non-paying symbol. */
function middleRow(...row: string[]): Matrix {
  return grid(...row.map((s) => ["B", s, "B"]));
}

describe("payout amounts", () => {
  it("pays the paytable multiplier on the line stake", () => {
    const result = evaluatePaylines(middleRow("A", "A", "A", "B", "B"), GAME, BET);

    const line0 = result.winLines.find((w) => w.line === 0);
    assert.equal(line0?.count, 3);
    assert.equal(line0?.symbol, "A");
    assert.equal(line0?.amount, LINE_STAKE * 5, "3-of-a-kind at 5x on a stake of 50");
  });

  it("pays a shorter run when the paytable has an entry for that length", () => {
    // This repo's rule, and the one most easily got wrong: the run pays at
    // the length it reaches. An engine that paid only full-length lines
    // would return nothing here.
    const result = evaluatePaylines(middleRow("A", "A", "B", "B", "B"), GAME, BET);

    const line0 = result.winLines.find((w) => w.line === 0);
    assert.equal(line0?.count, 2);
    assert.equal(line0?.amount, LINE_STAKE * 2);
  });

  it("pays nothing for a run with no paytable entry for its length", () => {
    // `B` pays only at 3. A run of two Bs must not fall back to some other
    // tier or to the next entry down.
    const result = evaluatePaylines(middleRow("B", "B", "A", "A", "A"), GAME, BET);
    assert.equal(result.winLines.find((w) => w.line === 0), undefined);
  });

  it("floors a fractional payout rather than rounding up", () => {
    // A payout must be a whole minor unit, and rounding up pays money the
    // paytable never promised. 3 lines into 100 gives stakes of 34/33/33,
    // so a 2x line on a 33 stake is exact — the fractional case needs a
    // multiplier that does not divide evenly.
    const fractional: GameDefinition = {
      ...GAME,
      paylines: [[1, 1, 1, 1, 1]],
      symbols: GAME.symbols.map((s) => (s.symbol === "A" ? { ...s, paytable: { 2: 1.005 } } : s)),
    };

    const result = evaluatePaylines(middleRow("A", "A", "B", "B", "B"), fractional, 100);
    assert.equal(result.winLines[0]?.amount, 100, "100 * 1.005 = 100.5, floored to 100");
  });
});

describe("where a run may start and end", () => {
  it("requires the run to start at reel 0", () => {
    // Left-to-right is the convention these definitions assume. A matching
    // run starting mid-grid pays nothing — worth pinning because paying it
    // would inflate RTP substantially and silently.
    const result = evaluatePaylines(middleRow("B", "A", "A", "A", "A"), GAME, BET);
    assert.equal(result.winLines.find((w) => w.line === 0), undefined);
  });

  it("stops the run at the first non-matching symbol", () => {
    // The gap must not be skipped: A A B A A is a run of 2, not 4.
    const result = evaluatePaylines(middleRow("A", "A", "B", "A", "A"), GAME, BET);
    assert.equal(result.winLines.find((w) => w.line === 0)?.count, 2);
  });

  it("pays the full length when every reel matches", () => {
    const result = evaluatePaylines(middleRow("A", "A", "A", "A", "A"), GAME, BET);
    assert.equal(result.winLines.find((w) => w.line === 0)?.amount, LINE_STAKE * 100);
  });

  it("follows the payline's own path, not a straight row", () => {
    // Line 1 is [0,1,2,1,0] — a V. Placing A along that path and nothing
    // along the middle row proves the path is honoured rather than the
    // grid being read row-wise.
    const matrix: Matrix = [
      ["A", "B", "B"],
      ["B", "A", "B"],
      ["B", "B", "A"],
      ["B", "B", "B"],
      ["B", "B", "B"],
    ];

    const result = evaluatePaylines(matrix, GAME, BET);
    const line1 = result.winLines.find((w) => w.line === 1);
    assert.equal(line1?.count, 3, "the V path should match three As");
    assert.deepEqual(
      line1?.positions,
      [
        { reel: 0, row: 0 },
        { reel: 1, row: 1 },
        { reel: 2, row: 2 },
      ],
      "positions must name the exact cells that matched, in order",
    );
  });
});

describe("wilds", () => {
  it("substitutes for a regular symbol", () => {
    const result = evaluatePaylines(middleRow("A", "W", "A", "B", "B"), GAME, BET);

    const line0 = result.winLines.find((w) => w.line === 0);
    assert.equal(line0?.count, 3);
    assert.equal(line0?.symbol, "A", "the wild pays as the symbol it stood in for");
  });

  it("anchors a leading wild to the first real symbol it meets", () => {
    // A wild leading the line must not anchor the run to "wild" — it
    // should pay the high symbol it is standing in for.
    const result = evaluatePaylines(middleRow("W", "A", "A", "B", "B"), GAME, BET);

    const line0 = result.winLines.find((w) => w.line === 0);
    assert.equal(line0?.symbol, "A");
    assert.equal(line0?.count, 3);
  });

  it("pays nothing for an all-wild line when the wild has no paytable", () => {
    // There is no regular symbol to anchor to, and `W` defines no paytable
    // of its own, so this must not pay — not fall back to some default.
    const result = evaluatePaylines(middleRow("W", "W", "W", "W", "W"), GAME, BET);
    assert.equal(result.winLines.length, 0);
  });

  it("scales the payout by a participating wild's multiplier", () => {
    const multiplied: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "W" ? { ...s, wildConfig: { substitutesFor: "all-regular" as const, multiplier: 3 } } : s,
      ),
    };

    const result = evaluatePaylines(middleRow("A", "W", "A", "B", "B"), multiplied, BET);
    assert.equal(result.winLines.find((w) => w.line === 0)?.amount, LINE_STAKE * 5 * 3);
  });

  it("multiplies the multipliers when several wilds take part", () => {
    const multiplied: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "W" ? { ...s, wildConfig: { substitutesFor: "all-regular" as const, multiplier: 2 } } : s,
      ),
    };

    const result = evaluatePaylines(middleRow("A", "W", "W", "B", "B"), multiplied, BET);
    assert.equal(
      result.winLines.find((w) => w.line === 0)?.amount,
      LINE_STAKE * 5 * 4,
      "two 2x wilds compound to 4x, not 2x",
    );
  });

  it("does not substitute for a scatter", () => {
    // A wild standing in for a scatter would silently inflate RTP by
    // paying scatter lines that should not exist.
    const result = evaluatePaylines(middleRow("S", "W", "S", "B", "B"), GAME, BET);
    assert.equal(result.winLines.find((w) => w.line === 0), undefined);
  });
});

describe("combining lines", () => {
  it("sums every winning line by default", () => {
    // Both lines start with A at reel 0 in this grid.
    const matrix: Matrix = [
      ["A", "A", "B"],
      ["B", "A", "B"],
      ["B", "A", "B"],
      ["B", "B", "B"],
      ["B", "B", "B"],
    ];

    const result = evaluatePaylines(matrix, GAME, BET);
    const total = result.winLines.reduce((sum, w) => sum + w.amount, 0);
    assert.equal(result.lineWinTotal, total, "the reported total must equal the sum of the lines");
    assert.ok(result.winLines.length >= 1);
  });

  it("keeps only the best line under the highestOnly rule", () => {
    // The grid is built so the two lines pay DIFFERENT amounts, and the
    // assertion names the higher one explicitly. Asserting only
    // `highestOnly <= summed` is not enough: a rule that kept the *worst*
    // line satisfies that too (verified by mutation), so the test would
    // pass while the player was underpaid on every multi-line win.
    const highestOnly: GameDefinition = { ...GAME, paylineWinRule: "highestOnly" };

    // Line 0 (middle row) reads AAABB -> 3-of-a-kind at 5x.
    // Line 1 (the V, [0,1,2,1,0]) reads AABBB -> 2-of-a-kind at 2x.
    // They diverge at reel 2, where the middle row holds A and row 2 holds B.
    const matrix: Matrix = [
      ["A", "A", "B"],
      ["B", "A", "B"],
      ["B", "A", "B"],
      ["B", "B", "B"],
      ["B", "B", "B"],
    ];

    const summed = evaluatePaylines(matrix, GAME, BET);
    assert.equal(summed.winLines.length, 2, "the fixture must produce two paying lines");
    const amounts = summed.winLines.map((w) => w.amount).sort((a, b) => b - a);
    assert.ok(amounts[0] > amounts[1], "the two lines must pay differently for this test to mean anything");

    const best = evaluatePaylines(matrix, highestOnly, BET);
    assert.equal(best.winLines.length, 1, "only one line is reported");
    assert.equal(best.lineWinTotal, amounts[0], "it must be the HIGHEST-paying line, not merely one of them");
    assert.equal(best.winLines[0].amount, amounts[0]);
  });

  it("returns nothing when the game defines no paylines", () => {
    const noLines: GameDefinition = { ...GAME, paylines: [] };
    const result = evaluatePaylines(middleRow("A", "A", "A", "A", "A"), noLines, BET);

    assert.deepEqual(result.winLines, []);
    assert.equal(result.lineWinTotal, 0);
  });
});

describe("grid shape independence", () => {
  it("evaluates a 3-reel game with no reference to a 5-reel assumption", () => {
    // Guards against a reel count being hardcoded anywhere in the walk.
    const threeReel: GameDefinition = {
      ...GAME,
      grid: { reels: 3, rows: 1 },
      paylines: [[0, 0, 0]],
    };

    const result = evaluatePaylines([["A"], ["A"], ["A"]], threeReel, 100);
    assert.equal(result.winLines[0]?.count, 3);
    assert.equal(result.winLines[0]?.amount, 100 * 5);
  });

  it("ends the run where a payline path ends early", () => {
    // A `null` entry means the reel is not part of this line's pattern, so
    // the run must stop there rather than skipping to the next reel.
    const shortLine: GameDefinition = {
      ...GAME,
      paylines: [[1, 1, null, 1, 1]],
    };

    const result = evaluatePaylines(middleRow("A", "A", "A", "A", "A"), shortLine, 100);
    assert.equal(result.winLines[0]?.count, 2, "the path ends at the null, so the run is 2 long");
  });
});
