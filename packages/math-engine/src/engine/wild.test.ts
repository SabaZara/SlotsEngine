import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameDefinition } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { applyExpandingWild, isWild, symbolRule, wildSubstitutes } from "./wild.js";

/**
 * Tests for wild handling.
 *
 * Two things here can silently inflate RTP, which is why they get the most
 * attention below: a wild substituting for a symbol it should not (most
 * importantly a scatter), and an expanding wild filling a reel it never
 * landed on. Both produce wins that look perfectly legitimate in a payout
 * log — nothing errors, the money is simply wrong.
 *
 * `paylines.test.ts` covers what a wild does to a payout. This file covers
 * the substitution rules themselves and the expansion step that runs before
 * evaluation.
 */

const GAME: GameDefinition = {
  gameId: "wild-test",
  name: "Wild fixture",
  version: 1,
  status: "published",
  grid: { reels: 3, rows: 3 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [],
  paylines: [[1, 1, 1]],
  symbols: [
    { symbol: "A", allowedReels: [0, 1, 2], role: "regular", paytable: { 3: 5 } },
    { symbol: "B", allowedReels: [0, 1, 2], role: "regular", paytable: { 3: 3 } },
    { symbol: "S", allowedReels: [0, 1, 2], role: "scatter", paytable: { 3: 4 } },
    { symbol: "T", allowedReels: [0, 1, 2], role: "bonus", paytable: {} },
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

/** Replaces one symbol's rule, leaving the rest of the fixture intact. */
function withSymbol(symbol: string, patch: Record<string, unknown>): GameDefinition {
  return {
    ...GAME,
    symbols: GAME.symbols.map((s) => (s.symbol === symbol ? { ...s, ...patch } : s)),
  } as GameDefinition;
}

describe("symbolRule", () => {
  it("finds a symbol's rule by id", () => {
    assert.equal(symbolRule(GAME, "A")?.role, "regular");
    assert.equal(symbolRule(GAME, "W")?.role, "wild");
  });

  it("returns undefined for a symbol the game does not define", () => {
    // Callers depend on this being undefined rather than a throw: a grid
    // can legitimately contain a symbol with no paytable entry.
    assert.equal(symbolRule(GAME, "does-not-exist"), undefined);
  });
});

describe("isWild", () => {
  it("is true only for the wild role", () => {
    assert.equal(isWild(GAME, "W"), true);
    assert.equal(isWild(GAME, "A"), false);
    assert.equal(isWild(GAME, "S"), false);
    assert.equal(isWild(GAME, "unknown"), false, "an unknown symbol is not a wild");
  });
});

describe("wildSubstitutes", () => {
  it("stands in for any regular symbol under all-regular", () => {
    assert.equal(wildSubstitutes(GAME, "W", "A"), true);
    assert.equal(wildSubstitutes(GAME, "W", "B"), true);
  });

  it("never stands in for a scatter", () => {
    // The single most expensive mistake available here. A wild completing
    // scatter lines pays wins the paytable never intended, and the payout
    // log looks entirely normal.
    assert.equal(wildSubstitutes(GAME, "W", "S"), false);
  });

  it("never stands in for a bonus trigger", () => {
    // Same reasoning, worse consequence: a wild that can complete a bonus
    // trigger hands out bonus rounds the maths never priced.
    assert.equal(wildSubstitutes(GAME, "W", "T"), false);
  });

  it("substitutes for itself", () => {
    // A run of wilds has to match itself, or an all-wild line could never
    // be recognised at all.
    assert.equal(wildSubstitutes(GAME, "W", "W"), true);
  });

  it("honours an explicit allowlist instead of the role", () => {
    const allowlisted = withSymbol("W", { wildConfig: { substitutesFor: ["A"] } });

    assert.equal(wildSubstitutes(allowlisted, "W", "A"), true);
    assert.equal(wildSubstitutes(allowlisted, "W", "B"), false, "a regular symbol NOT on the list is excluded");
  });

  it("allows a scatter only when the allowlist names it explicitly", () => {
    // The documented escape hatch. It must require naming the scatter — a
    // game that wants this has opted in deliberately.
    const explicit = withSymbol("W", { wildConfig: { substitutesFor: ["S"] } });
    assert.equal(wildSubstitutes(explicit, "W", "S"), true);

    const notExplicit = withSymbol("W", { wildConfig: { substitutesFor: ["A"] } });
    assert.equal(wildSubstitutes(notExplicit, "W", "S"), false);
  });

  it("refuses when the substituting symbol is not a wild", () => {
    // Direction matters: `wildSubstitutes(gameDef, wild, target)`. A
    // regular symbol must never be treated as able to stand in for another.
    assert.equal(wildSubstitutes(GAME, "A", "B"), false);
    assert.equal(wildSubstitutes(GAME, "S", "A"), false);
  });

  it("checks the ROLE, not merely the presence of a wildConfig", () => {
    // The two halves of the guard are separable, and the first two
    // assertions above do not distinguish them: `A` and `S` are rejected by
    // the missing-config half alone, so dropping the role check keeps them
    // passing (verified by mutation).
    //
    // A symbol carrying a leftover wildConfig while declared `regular` —
    // exactly what a mid-edit game definition looks like in the backoffice
    // — is the case that separates them. Role is the authority; a stale
    // config must not silently grant substitution.
    const staleConfig = withSymbol("A", {
      wildConfig: { substitutesFor: "all-regular" as const },
    });

    assert.equal(
      wildSubstitutes(staleConfig, "A", "B"),
      false,
      "a regular symbol with a wildConfig must still not substitute",
    );
  });

  it("refuses when a wild has no wildConfig at all", () => {
    // A symbol marked wild but never configured substitutes for nothing,
    // rather than defaulting to everything.
    const unconfigured = withSymbol("W", { wildConfig: undefined });
    assert.equal(wildSubstitutes(unconfigured, "W", "A"), false);
  });

  it("refuses for a symbol the game does not define", () => {
    assert.equal(wildSubstitutes(GAME, "unknown", "A"), false);
    assert.equal(wildSubstitutes(GAME, "W", "unknown"), false, "an undefined target has no role to match");
  });
});

describe("applyExpandingWild", () => {
  const expandingGame = withSymbol("W", {
    wildConfig: { substitutesFor: "all-regular", expanding: true },
  });

  const gridWithWild: Matrix = [
    ["A", "W", "B"],
    ["A", "B", "A"],
    ["B", "A", "B"],
  ];

  it("fills the whole reel the wild landed on", () => {
    const { matrix, expandedReels } = applyExpandingWild(gridWithWild, expandingGame);

    assert.deepEqual(matrix[0], ["W", "W", "W"], "reel 0 held the wild and is now all wild");
    assert.deepEqual(expandedReels, [0]);
  });

  it("leaves every other reel untouched", () => {
    // An expansion that leaked to neighbouring reels would multiply wins
    // far beyond what the maths priced.
    const { matrix } = applyExpandingWild(gridWithWild, expandingGame);

    assert.deepEqual(matrix[1], ["A", "B", "A"]);
    assert.deepEqual(matrix[2], ["B", "A", "B"]);
  });

  it("does nothing when no wild landed", () => {
    const noWild: Matrix = [
      ["A", "B", "A"],
      ["B", "A", "B"],
      ["A", "B", "A"],
    ];

    const { matrix, expandedReels } = applyExpandingWild(noWild, expandingGame);
    assert.deepEqual(matrix, noWild);
    assert.deepEqual(expandedReels, [], "empty, not absent — a client reads this to play a reveal");
  });

  it("does not expand a wild that is not configured as expanding", () => {
    // GAME's wild has no `expanding` flag. A non-expanding wild must stay
    // a single cell.
    const { matrix, expandedReels } = applyExpandingWild(gridWithWild, GAME);

    assert.deepEqual(matrix, gridWithWild);
    assert.deepEqual(expandedReels, []);
  });

  it("expands every reel that holds one", () => {
    const twoWilds: Matrix = [
      ["W", "A", "B"],
      ["A", "B", "A"],
      ["B", "W", "A"],
    ];

    const { matrix, expandedReels } = applyExpandingWild(twoWilds, expandingGame);
    assert.deepEqual(expandedReels, [0, 2]);
    assert.deepEqual(matrix[0], ["W", "W", "W"]);
    assert.deepEqual(matrix[2], ["W", "W", "W"]);
    assert.deepEqual(matrix[1], ["A", "B", "A"], "the reel between them is unaffected");
  });

  it("never mutates the input grid", () => {
    // The caller persists both the raw and expanded grids so an auditor can
    // see exactly what expansion changed. Mutating in place would destroy
    // the "before" record — and the corruption would be invisible, because
    // both variables would then point at the same expanded grid.
    const original: Matrix = [
      ["A", "W", "B"],
      ["A", "B", "A"],
      ["B", "A", "B"],
    ];
    const snapshot = original.map((column) => [...column]);

    const { matrix } = applyExpandingWild(original, expandingGame);

    assert.deepEqual(original, snapshot, "the input must be unchanged");
    assert.notDeepEqual(matrix, original, "and the result must actually differ from it");
  });

  it("returns a deep copy, so editing the result cannot reach back", () => {
    // A shallow `[...matrix]` copies the outer array but shares every
    // column, so a later write to the result would still corrupt the raw
    // grid — the same audit failure, one level down.
    const original: Matrix = [
      ["A", "B", "A"],
      ["B", "A", "B"],
      ["A", "B", "A"],
    ];

    const { matrix } = applyExpandingWild(original, expandingGame);
    matrix[1][0] = "CHANGED";

    assert.equal(original[1][0], "B", "the raw grid must not share column arrays with the result");
  });
});
