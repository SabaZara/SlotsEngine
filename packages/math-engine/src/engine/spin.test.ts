import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSeed } from "@slots-engine/rng";
import type { GameDefinition } from "@slots-engine/shared-types";
import { evaluateSpin } from "./spin.js";
import { evaluatePaylines } from "./paylines.js";
import { evaluateScatter } from "./scatter.js";
import { applyExpandingWild } from "./wild.js";
import { REFERENCE_GAME } from "./fixtures/reference-game.js";

/**
 * A deterministic single-outcome game: every strip is one symbol long, so
 * the grid is fixed regardless of the seed. This isolates payout logic from
 * RNG entirely — a test that fails here is a payout bug, never a bad draw.
 */
function fixedGame(grid: string[][], overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    gameId: "fixed",
    name: "Fixed",
    version: 1,
    status: "published",
    grid: { reels: grid.length, rows: grid[0].length },
    reelGenerationMode: "reel-strip",
    reelStrips: grid.map((column, reelIndex) => ({ reelIndex, symbols: column })),
    paylines: [[0, 0, 0, 0, 0]],
    symbols: [
      { symbol: "a", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 20, 5: 50 } },
      { symbol: "b", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 5 } },
      {
        symbol: "w",
        allowedReels: [0, 1, 2, 3, 4],
        role: "wild",
        wildConfig: { substitutesFor: "all-regular" },
      },
      {
        symbol: "s",
        allowedReels: [0, 1, 2, 3, 4],
        role: "scatter",
        scatterConfig: { multiplierOf: "totalBet", payout: { 3: 2 } },
      },
    ],
    bonusModules: [],
    rtpTarget: 0.95,
    betOptions: [100],
    ...overrides,
  };
}

const rows = (symbol: string, n = 3) => Array.from({ length: n }, () => symbol);

describe("evaluateSpin", () => {
  it("is deterministic — the same seed replays the same outcome", () => {
    const seed = generateSeed();
    const a = evaluateSpin(REFERENCE_GAME, seed, 100);
    const b = evaluateSpin(REFERENCE_GAME, seed, 100);
    assert.deepEqual(a.finalMatrix, b.finalMatrix);
    assert.deepEqual(a.evaluation, b.evaluation);
    assert.deepEqual(a.stops, b.stops);
  });

  it("records the algorithm used, so a round stays replayable after the default changes", () => {
    const result = evaluateSpin(REFERENCE_GAME, generateSeed(), 100);
    assert.equal(result.rngAlgorithm, "xoshiro256ss-d16");
  });

  it("builds a grid matching the declared shape", () => {
    const { finalMatrix } = evaluateSpin(REFERENCE_GAME, generateSeed(), 100);
    assert.equal(finalMatrix.length, REFERENCE_GAME.grid.reels);
    for (const column of finalMatrix) assert.equal(column.length, REFERENCE_GAME.grid.rows);
  });

  it("only ever draws symbols the game defines", () => {
    const known = new Set(REFERENCE_GAME.symbols.map((s) => s.symbol));
    for (let i = 0; i < 200; i++) {
      for (const column of evaluateSpin(REFERENCE_GAME, generateSeed(), 100).finalMatrix) {
        for (const symbol of column) assert.ok(known.has(symbol), `undeclared symbol '${symbol}'`);
      }
    }
  });

  it("never pays a fractional minor unit", () => {
    for (let i = 0; i < 500; i++) {
      const { evaluation } = evaluateSpin(REFERENCE_GAME, generateSeed(), 100);
      assert.ok(Number.isInteger(evaluation.totalWin), `totalWin ${evaluation.totalWin} is not an integer`);
      for (const line of evaluation.winLines) {
        assert.ok(Number.isInteger(line.amount), `line amount ${line.amount} is not an integer`);
      }
    }
  });

  it("reports totalWin as exactly lines plus scatter", () => {
    for (let i = 0; i < 300; i++) {
      const { evaluation } = evaluateSpin(REFERENCE_GAME, generateSeed(), 100);
      assert.equal(evaluation.totalWin, evaluation.lineWinTotal + evaluation.scatterAmount);
      assert.equal(evaluation.lineWinTotal, evaluation.winLines.reduce((s, w) => s + w.amount, 0));
    }
  });

  it("omits bonusModuleId entirely when no bonus triggered, rather than setting it undefined", () => {
    // An absent key and an explicit `undefined` are different own-property
    // shapes; keeping them distinct is what makes a fresh round byte-identical
    // to the same round read back from the database.
    for (let i = 0; i < 100; i++) {
      const { evaluation } = evaluateSpin(REFERENCE_GAME, generateSeed(), 100);
      if (!evaluation.bonusTriggered) {
        assert.ok(!("bonusModuleId" in evaluation), "bonusModuleId present on a non-bonus round");
      }
    }
  });
});

describe("evaluatePaylines", () => {
  it("pays a straight three-of-a-kind from reel 0", () => {
    const game = fixedGame([rows("a"), rows("a"), rows("a"), rows("b"), rows("b")]);
    const { winLines, lineWinTotal } = evaluatePaylines(
      game.reelStrips!.map((s) => s.symbols),
      game,
      100,
    );
    assert.equal(winLines.length, 1);
    assert.equal(winLines[0].symbol, "a");
    assert.equal(winLines[0].count, 3);
    // One payline, so the whole 100 is staked on it: 100 * 10 = 1000.
    assert.equal(lineWinTotal, 1000);
  });

  it("does not pay a run that starts after reel 0", () => {
    const game = fixedGame([rows("b"), rows("a"), rows("a"), rows("a"), rows("a")]);
    const { winLines } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    // "b" alone is one-of-a-kind with no paytable entry at 1; the "a" run
    // starting at reel 1 must not pay.
    assert.deepEqual(winLines, []);
  });

  it("anchors a leading wild to the first real symbol, not to 'wild'", () => {
    const game = fixedGame([rows("w"), rows("a"), rows("a"), rows("b"), rows("b")]);
    const { winLines } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(winLines.length, 1);
    assert.equal(winLines[0].symbol, "a", "a wild-led run should pay the symbol it substitutes for");
    assert.equal(winLines[0].count, 3);
  });

  it("applies a wild's multiplier to the line it joins", () => {
    const base = fixedGame([rows("w"), rows("a"), rows("a"), rows("b"), rows("b")]);
    const multiplied = fixedGame([rows("w"), rows("a"), rows("a"), rows("b"), rows("b")], {
      symbols: base.symbols.map((s) =>
        s.symbol === "w" ? { ...s, wildConfig: { substitutesFor: "all-regular" as const, multiplier: 3 } } : s,
      ),
    });
    const plain = evaluatePaylines(base.reelStrips!.map((s) => s.symbols), base, 100).lineWinTotal;
    const boosted = evaluatePaylines(multiplied.reelStrips!.map((s) => s.symbols), multiplied, 100).lineWinTotal;
    assert.equal(boosted, plain * 3);
  });

  it("splits the bet across lines without creating or losing a minor unit", () => {
    // 100 across 3 lines divides unevenly — the split must still total 100.
    const game = fixedGame([rows("a"), rows("a"), rows("a"), rows("a"), rows("a")], {
      paylines: [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2]],
    });
    const { winLines } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(winLines.length, 3);
    // Stakes are 34/33/33, each paying 50x for five-of-a-kind.
    assert.equal(winLines[0].amount, 34 * 50);
    assert.equal(winLines[1].amount, 33 * 50);
    assert.equal(winLines[2].amount, 33 * 50);
  });

  it("honours the highestOnly rule", () => {
    const game = fixedGame([rows("a"), rows("a"), rows("a"), rows("a"), rows("a")], {
      paylines: [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2]],
      paylineWinRule: "highestOnly",
    });
    const { winLines, lineWinTotal } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(winLines.length, 1);
    assert.equal(lineWinTotal, winLines[0].amount);
    assert.equal(lineWinTotal, 34 * 50, "the surviving line should be the highest-paying one");
  });

  it("never pays a scatter as a line run", () => {
    // Scatters pay on count; matching them on a line too would pay twice.
    const game = fixedGame([rows("s"), rows("s"), rows("s"), rows("b"), rows("b")]);
    const { winLines } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.deepEqual(winLines, []);
  });

  it("stops a run at a null payline entry", () => {
    const game = fixedGame([rows("a"), rows("a"), rows("a"), rows("a"), rows("a")], {
      paylines: [[0, 0, 0, null, 0]],
    });
    const { winLines } = evaluatePaylines(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(winLines[0].count, 3, "the run must end at the null, not skip past it");
  });
});

describe("evaluateScatter", () => {
  it("pays on count anywhere, regardless of position", () => {
    const game = fixedGame([["s", "b", "b"], ["b", "s", "b"], ["b", "b", "s"], rows("b"), rows("b")]);
    const { amount, counts } = evaluateScatter(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(counts.s, 3);
    assert.equal(amount, 200, "3 scatters pay 2x the total bet");
  });

  it("ignores wilds by default, even a wild substituting all-regular", () => {
    const game = fixedGame([["s", "b", "b"], ["w", "b", "b"], ["s", "b", "b"], rows("b"), rows("b")]);
    const { counts } = evaluateScatter(game.reelStrips!.map((s) => s.symbols), game, 100);
    assert.equal(counts.s, 2, "'all-regular' must never cover a scatter");
  });

  it("counts a wild toward a scatter only when both opt in explicitly", () => {
    const grid = [["s", "b", "b"], ["w", "b", "b"], ["s", "b", "b"], rows("b"), rows("b")];
    const game = fixedGame(grid, {
      symbols: fixedGame(grid).symbols.map((s) => {
        if (s.symbol === "w") return { ...s, wildConfig: { substitutesFor: ["s"] } };
        if (s.symbol === "s") {
          return { ...s, scatterConfig: { multiplierOf: "totalBet" as const, payout: { 3: 2 }, wildCountsToward: true } };
        }
        return s;
      }),
    });
    const { counts, amount } = evaluateScatter(grid, game, 100);
    assert.equal(counts.s, 3);
    assert.equal(amount, 200);
  });
});

describe("applyExpandingWild", () => {
  it("fills the whole reel and reports which reels expanded", () => {
    const grid = [rows("a"), ["w", "b", "b"], rows("a"), rows("b"), rows("b")];
    const game = fixedGame(grid, {
      symbols: fixedGame(grid).symbols.map((s) =>
        s.symbol === "w" ? { ...s, wildConfig: { substitutesFor: "all-regular" as const, expanding: true } } : s,
      ),
    });
    const { matrix, expandedReels } = applyExpandingWild(grid, game);
    assert.deepEqual(expandedReels, [1]);
    assert.deepEqual(matrix[1], ["w", "w", "w"]);
    assert.deepEqual(matrix[0], grid[0], "other reels must be untouched");
  });

  it("does not mutate the input grid", () => {
    const grid = [rows("a"), ["w", "b", "b"], rows("a"), rows("b"), rows("b")];
    const game = fixedGame(grid, {
      symbols: fixedGame(grid).symbols.map((s) =>
        s.symbol === "w" ? { ...s, wildConfig: { substitutesFor: "all-regular" as const, expanding: true } } : s,
      ),
    });
    applyExpandingWild(grid, game);
    assert.deepEqual(grid[1], ["w", "b", "b"], "the raw grid must survive for the audit record");
  });

  it("reports an empty array, not absent, when nothing expands", () => {
    const grid = [rows("a"), rows("b"), rows("a"), rows("b"), rows("b")];
    const { expandedReels } = applyExpandingWild(grid, fixedGame(grid));
    assert.deepEqual(expandedReels, []);
  });
});
