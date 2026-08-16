import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rng } from "@slots-engine/rng";
import type { GameDefinition } from "@slots-engine/shared-types";
import { buildMatrix } from "./matrix.js";

/**
 * Tests for grid generation — the step between the seeded RNG and anything
 * the player sees or gets paid for.
 *
 * The property that matters most here is determinism: a stored seed is only
 * sufficient for replay if the same draw sequence always produces the same
 * grid. Everything downstream (payline evaluation, the audit trail, a
 * regulator re-running a disputed round) rests on that.
 *
 * The RNG is scripted rather than seeded, so the assertions are exact
 * rather than statistical. `buildMatrix` consumes `next()` in a defined
 * order, and driving it with a known sequence is what turns "the
 * distribution looks about right" into "this exact cell is this exact
 * symbol".
 */

/** An Rng that replays a fixed sequence, then repeats its last value.
 * Repeating rather than throwing keeps a test focused on the draws it
 * actually cares about. */
function scriptedRng(...values: number[]): Rng {
  let i = 0;
  return {
    next: () => values[Math.min(i++, values.length - 1)],
  };
}

const STRIP_GAME: GameDefinition = {
  gameId: "strip-test",
  name: "Strip fixture",
  version: 1,
  status: "published",
  grid: { reels: 3, rows: 3 },
  reelGenerationMode: "reel-strip",
  reelStrips: [
    { reelIndex: 0, symbols: ["A", "B", "C", "D"] },
    { reelIndex: 1, symbols: ["E", "F", "G", "H"] },
    { reelIndex: 2, symbols: ["I", "J", "K", "L"] },
  ],
  paylines: [[1, 1, 1]],
  symbols: [],
  bonusModules: [],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

const WEIGHTED_GAME: GameDefinition = {
  gameId: "weighted-test",
  name: "Weighted fixture",
  version: 1,
  status: "published",
  grid: { reels: 2, rows: 2 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [
    [
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 3 },
    ],
    [
      { symbol: "C", weight: 2 },
      { symbol: "D", weight: 2 },
    ],
  ],
  paylines: [[0, 0]],
  symbols: [],
  bonusModules: [],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

describe("reel-strip mode", () => {
  it("reads `rows` consecutive symbols from the chosen stop", () => {
    // rollInt is floor(next() * length), so 0 picks stop 0 on every reel.
    const { matrix, stops } = buildMatrix(STRIP_GAME, scriptedRng(0));

    assert.deepEqual(stops, [0, 0, 0]);
    assert.deepEqual(matrix, [
      ["A", "B", "C"],
      ["E", "F", "G"],
      ["I", "J", "K"],
    ]);
  });

  it("wraps around the end of the strip rather than running off it", () => {
    // Stop 3 on a 4-symbol strip: the window is D, then wraps to A, B.
    // Getting this wrong is the classic off-by-one here — either an
    // exception at the boundary, or a silently truncated column.
    const { matrix, stops } = buildMatrix(STRIP_GAME, scriptedRng(0.75));

    assert.deepEqual(stops, [3, 3, 3]);
    assert.deepEqual(matrix[0], ["D", "A", "B"], "the window must wrap cyclically");
    assert.deepEqual(matrix[1], ["H", "E", "F"]);
  });

  it("chooses a stop per reel, not one stop for the whole grid", () => {
    // Each reel consumes its own draw. If the implementation reused one
    // stop across every reel, these would all be equal.
    const { stops } = buildMatrix(STRIP_GAME, scriptedRng(0, 0.25, 0.5));

    assert.deepEqual(stops, [0, 1, 2], "each reel gets its own draw, in order");
  });

  it("is column-major — matrix[reel][row]", () => {
    // The whole codebase indexes reel-first; a transposed grid would pay
    // wrong lines everywhere while still looking like a plausible grid.
    const { matrix } = buildMatrix(STRIP_GAME, scriptedRng(0));

    assert.equal(matrix.length, 3, "outer array is reels");
    assert.equal(matrix[0].length, 3, "inner array is rows");
    assert.equal(matrix[0][0], "A", "reel 0 row 0 comes from reel 0's own strip");
    assert.equal(matrix[1][0], "E", "reel 1 row 0 comes from reel 1's strip");
  });

  it("produces the same grid for the same draws — the replay guarantee", () => {
    const a = buildMatrix(STRIP_GAME, scriptedRng(0.1, 0.4, 0.9));
    const b = buildMatrix(STRIP_GAME, scriptedRng(0.1, 0.4, 0.9));

    assert.deepEqual(a.matrix, b.matrix);
    assert.deepEqual(a.stops, b.stops);
  });

  it("refuses to build when the mode's own data is missing", () => {
    // Failing loudly beats generating a plausible grid from nothing: a
    // silent fallback here would produce spins that pay real money from a
    // misconfigured game.
    const noStrips: GameDefinition = { ...STRIP_GAME, reelStrips: [] };
    assert.throws(() => buildMatrix(noStrips, scriptedRng(0)), /defines no reelStrips/);

    const missingReel: GameDefinition = {
      ...STRIP_GAME,
      reelStrips: [{ reelIndex: 0, symbols: ["A", "B"] }],
    };
    assert.throws(() => buildMatrix(missingReel, scriptedRng(0)), /no reel strip for reel 1/);
  });

  it("matches strips by reelIndex, not by array position", () => {
    // A definition may list its strips in any order; binding by position
    // would quietly hand reel 0 the wrong symbols.
    const reordered: GameDefinition = {
      ...STRIP_GAME,
      reelStrips: [
        { reelIndex: 2, symbols: ["I", "J", "K", "L"] },
        { reelIndex: 0, symbols: ["A", "B", "C", "D"] },
        { reelIndex: 1, symbols: ["E", "F", "G", "H"] },
      ],
    };

    const { matrix } = buildMatrix(reordered, scriptedRng(0));
    assert.equal(matrix[0][0], "A", "reel 0 must still read the strip declared for reel 0");
    assert.equal(matrix[2][0], "I");
  });
});

describe("weighted-symbol mode", () => {
  it("picks by inverse CDF across the pool's total weight", () => {
    // Reel 0 is A:1, B:3 — total 4. A ticket below 1/4 lands on A;
    // anything at or above lands on B.
    const allA = buildMatrix(WEIGHTED_GAME, scriptedRng(0.0));
    assert.equal(allA.matrix[0][0], "A");

    const allB = buildMatrix(WEIGHTED_GAME, scriptedRng(0.99));
    assert.equal(allB.matrix[0][0], "B");
  });

  it("places the boundary exactly at the cumulative weight", () => {
    // ticket = 0.25 * 4 = 1.0; after subtracting A's weight of 1 the
    // remainder is 0, which is NOT < 0, so the walk continues to B. An
    // implementation using `<=` would hand this draw to A instead — a
    // one-symbol shift in the payout distribution that no aggregate test
    // would attribute to this line.
    const atBoundary = buildMatrix(WEIGHTED_GAME, scriptedRng(0.25));
    assert.equal(atBoundary.matrix[0][0], "B", "the boundary belongs to the later symbol");

    const justBelow = buildMatrix(WEIGHTED_GAME, scriptedRng(0.2499));
    assert.equal(justBelow.matrix[0][0], "A");
  });

  it("draws every cell independently rather than once per reel", () => {
    // The property the independent-model cross-check depends on: with rows
    // drawn independently, per-cell probabilities multiply exactly.
    const { matrix } = buildMatrix(WEIGHTED_GAME, scriptedRng(0.0, 0.99, 0.0, 0.99));

    assert.equal(matrix[0][0], "A", "first draw");
    assert.equal(matrix[0][1], "B", "second draw — a different symbol on the same reel");
    assert.equal(matrix[1][0], "C");
    assert.equal(matrix[1][1], "D");
  });

  it("uses each reel's own pool", () => {
    // Reel 1 can only ever produce C or D; leaking reel 0's pool would let
    // a symbol land where the game says it cannot.
    const { matrix } = buildMatrix(WEIGHTED_GAME, scriptedRng(0.0));

    assert.ok(["C", "D"].includes(matrix[1][0]), `reel 1 produced ${matrix[1][0]}`);
    assert.ok(["C", "D"].includes(matrix[1][1]));
  });

  it("fills the grid the definition asks for", () => {
    const { matrix } = buildMatrix(WEIGHTED_GAME, scriptedRng(0.5));

    assert.equal(matrix.length, 2, "two reels");
    assert.ok(matrix.every((column) => column.length === 2), "two rows each");
  });

  it("refuses to build when the mode's own data is missing or unusable", () => {
    const noWeights: GameDefinition = { ...WEIGHTED_GAME, symbolWeights: [] };
    assert.throws(() => buildMatrix(noWeights, scriptedRng(0)), /defines no symbolWeights/);

    const missingReel: GameDefinition = {
      ...WEIGHTED_GAME,
      symbolWeights: [[{ symbol: "A", weight: 1 }]],
    };
    assert.throws(() => buildMatrix(missingReel, scriptedRng(0)), /no symbol weights for reel 1/);

    // A pool of zero-weight entries has no meaningful pick, and dividing
    // by it would silently produce the last symbol every time.
    const zeroWeight: GameDefinition = {
      ...WEIGHTED_GAME,
      symbolWeights: [
        [
          { symbol: "A", weight: 0 },
          { symbol: "B", weight: 0 },
        ],
        [{ symbol: "C", weight: 1 }],
      ],
    };
    assert.throws(() => buildMatrix(zeroWeight, scriptedRng(0)), /non-positive total symbol weight/);
  });

  it("produces the same grid for the same draws — the replay guarantee", () => {
    const draws = [0.1, 0.6, 0.35, 0.8];
    assert.deepEqual(
      buildMatrix(WEIGHTED_GAME, scriptedRng(...draws)).matrix,
      buildMatrix(WEIGHTED_GAME, scriptedRng(...draws)).matrix,
    );
  });
});

describe("mode selection", () => {
  it("routes on the declared generation mode", () => {
    // Both fixtures below carry the data for BOTH modes, so only the
    // declared mode can explain which symbols come out.
    const both = {
      ...STRIP_GAME,
      symbolWeights: [
        [{ symbol: "Z", weight: 1 }],
        [{ symbol: "Z", weight: 1 }],
        [{ symbol: "Z", weight: 1 }],
      ],
    };

    const asStrips = buildMatrix({ ...both, reelGenerationMode: "reel-strip" }, scriptedRng(0));
    assert.equal(asStrips.matrix[0][0], "A", "strip mode reads the strips");

    const asWeights = buildMatrix({ ...both, reelGenerationMode: "weighted-symbol" }, scriptedRng(0));
    assert.equal(asWeights.matrix[0][0], "Z", "weighted mode reads the pools");
  });
});
