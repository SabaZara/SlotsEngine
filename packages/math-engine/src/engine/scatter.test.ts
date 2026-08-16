import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameDefinition } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { countSymbol, evaluateScatter } from "./scatter.js";

/**
 * Tests for scatter evaluation.
 *
 * Scatters pay on how many appear anywhere on the grid, which makes them
 * the one payout path where position is irrelevant — and the one where a
 * miscount is invisible, because there is no line to look at and explain
 * the number.
 *
 * **The lookup is EXACT, not "N-or-more".** `payout[count]` means a table
 * of `{3,4,5}` pays nothing at six. That is a real trap for whoever writes
 * a game definition, and it is pinned below rather than left implicit; the
 * publish-time guard that catches an under-covered table lives in
 * `backoffice-api`'s `validateDraft`.
 */

const GAME: GameDefinition = {
  gameId: "scatter-test",
  name: "Scatter fixture",
  version: 1,
  status: "published",
  grid: { reels: 3, rows: 3 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [],
  paylines: [[1, 1, 1]],
  symbols: [
    { symbol: "A", allowedReels: [0, 1, 2], role: "regular", paytable: { 3: 5 } },
    {
      symbol: "S",
      allowedReels: [0, 1, 2],
      role: "scatter",
      scatterConfig: { multiplierOf: "totalBet", payout: { 2: 1, 3: 4, 4: 20 } },
    },
    {
      symbol: "W",
      allowedReels: [0, 1, 2],
      role: "wild",
      wildConfig: { substitutesFor: "all-regular" },
    },
  ],
  bonusModules: [],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

const BET = 100;

/** A 3x3 grid containing exactly `n` scatters, filled with `A` elsewhere. */
function withScatters(n: number, symbol = "S"): Matrix {
  const cells = Array.from({ length: 9 }, (_, i) => (i < n ? symbol : "A"));
  return [cells.slice(0, 3), cells.slice(3, 6), cells.slice(6, 9)];
}

describe("counting", () => {
  it("counts scatters anywhere on the grid, regardless of position", () => {
    // The defining property: three scatters scattered across different
    // reels and rows pay the same as three in a neat line.
    const spread: Matrix = [
      ["S", "A", "A"],
      ["A", "A", "S"],
      ["A", "S", "A"],
    ];

    const result = evaluateScatter(spread, GAME, BET);
    assert.equal(result.counts.S, 3);
    assert.equal(result.amount, BET * 4);
  });

  it("reports the count even when it pays nothing", () => {
    // A simulation report breaks RTP down by symbol, and the client shows
    // near-misses. Both need the count regardless of payout.
    const result = evaluateScatter(withScatters(1), GAME, BET);
    assert.equal(result.counts.S, 1);
    assert.equal(result.amount, 0);
  });

  it("pays nothing below the lowest defined count", () => {
    assert.equal(evaluateScatter(withScatters(0), GAME, BET).amount, 0);
    assert.equal(evaluateScatter(withScatters(1), GAME, BET).amount, 0);
  });
});

describe("payout", () => {
  it("pays the multiplier against the TOTAL bet, not a line stake", () => {
    // Scatters are staked on the whole bet — paying a per-line share here
    // would quietly under-pay every scatter win in a multi-line game.
    assert.equal(evaluateScatter(withScatters(3), GAME, BET).amount, BET * 4);
    assert.equal(evaluateScatter(withScatters(4), GAME, BET).amount, BET * 20);
  });

  it("scales with the bet", () => {
    assert.equal(evaluateScatter(withScatters(3), GAME, 250).amount, 250 * 4);
  });

  it("floors a fractional payout", () => {
    const fractional: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "S"
          ? { ...s, scatterConfig: { multiplierOf: "totalBet" as const, payout: { 3: 1.007 } } }
          : s,
      ),
    };

    // 100 * 1.007 = 100.7 -> 100. Rounding up would pay a minor unit the
    // paytable never promised, on every scatter win.
    assert.equal(evaluateScatter(withScatters(3), fractional, 100).amount, 100);
  });

  it("looks the count up EXACTLY — a count above the table pays nothing", () => {
    // Pinning the real behaviour rather than the intuitive one. The table
    // stops at 4; five scatters is a bigger outcome that pays zero.
    //
    // This is deliberate here — the evaluator must not invent a payout the
    // designer never wrote — but it makes an under-covered payout table a
    // silent bug, which is why `validateDraft` refuses to publish one.
    const result = evaluateScatter(withScatters(5), GAME, BET);
    assert.equal(result.counts.S, 5, "the scatters are counted");
    assert.equal(result.amount, 0, "and pay nothing, because 5 is not in the table");
  });

  it("ignores a non-positive multiplier rather than paying it", () => {
    const zeroed: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "S" ? { ...s, scatterConfig: { multiplierOf: "totalBet" as const, payout: { 3: 0 } } } : s,
      ),
    };

    assert.equal(evaluateScatter(withScatters(3), zeroed, BET).amount, 0);
  });
});

describe("wild interaction", () => {
  it("does not count a wild toward a scatter by default", () => {
    // Most real games' scatters are wild-immune, and a wild silently
    // completing a scatter win inflates RTP with no visible cause.
    const grid: Matrix = [
      ["S", "A", "A"],
      ["S", "A", "A"],
      ["W", "A", "A"],
    ];

    const result = evaluateScatter(grid, GAME, BET);
    assert.equal(result.counts.S, 2, "the wild must not be counted");
    assert.equal(result.amount, BET * 1, "so this pays the 2-scatter tier, not the 3");
  });

  it("counts a wild only when the scatter opts in AND the wild lists it", () => {
    // Two independent switches, both required. `wildCountsToward` alone is
    // not enough, because `wildSubstitutes` never treats "all-regular" as
    // covering a scatter.
    const optedInBoth: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => {
        if (s.symbol === "S") {
          return {
            ...s,
            scatterConfig: { multiplierOf: "totalBet" as const, payout: { 2: 1, 3: 4, 4: 20 }, wildCountsToward: true },
          };
        }
        if (s.symbol === "W") return { ...s, wildConfig: { substitutesFor: ["S"] } };
        return s;
      }),
    };

    const grid: Matrix = [
      ["S", "A", "A"],
      ["S", "A", "A"],
      ["W", "A", "A"],
    ];

    assert.equal(evaluateScatter(grid, optedInBoth, BET).counts.S, 3);
    assert.equal(evaluateScatter(grid, optedInBoth, BET).amount, BET * 4);
  });

  it("does not count a wild when only the WILD lists the scatter", () => {
    // The mirror of the test below, and the one that actually pins
    // `wildCountsToward`. The default-behaviour test above passes even if
    // that flag is ignored entirely, because its wild is "all-regular" and
    // `wildSubstitutes` rejects on that alone — verified by mutation.
    //
    // Here the wild explicitly lists "S", so the substitution half says
    // yes. Only the scatter's own opt-in — absent — can refuse it.
    const wildListsScatter: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => (s.symbol === "W" ? { ...s, wildConfig: { substitutesFor: ["S"] } } : s)),
    };

    const grid: Matrix = [
      ["S", "A", "A"],
      ["S", "A", "A"],
      ["W", "A", "A"],
    ];

    assert.equal(
      evaluateScatter(grid, wildListsScatter, BET).counts.S,
      2,
      "without wildCountsToward the scatter stays wild-immune",
    );
  });

  it("does not count a wild when only the scatter opts in", () => {
    // The wild still substitutes for "all-regular", which excludes
    // scatters — so the opt-in on its own changes nothing.
    const scatterOnly: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "S"
          ? {
              ...s,
              scatterConfig: {
                multiplierOf: "totalBet" as const,
                payout: { 2: 1, 3: 4, 4: 20 },
                wildCountsToward: true,
              },
            }
          : s,
      ),
    };

    const grid: Matrix = [
      ["S", "A", "A"],
      ["S", "A", "A"],
      ["W", "A", "A"],
    ];

    assert.equal(evaluateScatter(grid, scatterOnly, BET).counts.S, 2);
  });
});

describe("games without scatters", () => {
  it("returns zero and an empty breakdown", () => {
    const noScatter: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.filter((s) => s.role !== "scatter"),
    };

    const result = evaluateScatter(withScatters(3), noScatter, BET);
    assert.equal(result.amount, 0);
    assert.deepEqual(result.counts, {});
  });

  it("handles a scatter with no payout table configured", () => {
    const noPayout: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => (s.symbol === "S" ? { ...s, scatterConfig: undefined } : s)),
    };

    const result = evaluateScatter(withScatters(3), noPayout, BET);
    assert.equal(result.amount, 0);
    assert.equal(result.counts.S, 3, "still counted, just not paid");
  });
});

describe("multiple scatter symbols", () => {
  it("pays each independently and sums them", () => {
    const twoScatters: GameDefinition = {
      ...GAME,
      symbols: [
        ...GAME.symbols,
        {
          symbol: "T",
          allowedReels: [0, 1, 2],
          role: "scatter",
          scatterConfig: { multiplierOf: "totalBet", payout: { 2: 5 } },
        },
      ],
    } as GameDefinition;

    const grid: Matrix = [
      ["S", "S", "S"],
      ["T", "T", "A"],
      ["A", "A", "A"],
    ];

    const result = evaluateScatter(grid, twoScatters, BET);
    assert.equal(result.counts.S, 3);
    assert.equal(result.counts.T, 2);
    assert.equal(result.amount, BET * 4 + BET * 5, "both scatter wins pay");
  });
});

describe("countSymbol", () => {
  it("counts a symbol across the whole grid", () => {
    assert.equal(countSymbol(withScatters(4), GAME, "S", false), 4);
  });

  it("honours the wild opt-in it is given", () => {
    const grid: Matrix = [
      ["S", "A", "A"],
      ["W", "A", "A"],
      ["A", "A", "A"],
    ];

    assert.equal(countSymbol(grid, GAME, "S", false), 1, "wilds excluded");
    assert.equal(
      countSymbol(grid, GAME, "S", true),
      1,
      "still 1 — the wild does not list this scatter, so opting in is not enough",
    );
    // 7 literal As plus the wild, which does substitute for a regular
    // symbol — the contrast with the scatter case above is the point.
    assert.equal(countSymbol(grid, GAME, "A", true), 8, "a wild does substitute for a regular symbol");
    assert.equal(countSymbol(grid, GAME, "A", false), 7, "and is excluded when the caller opts out");
  });
});
