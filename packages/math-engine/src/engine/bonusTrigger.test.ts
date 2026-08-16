import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRng, type Rng } from "@slots-engine/rng";
import { createHash } from "node:crypto";
import type { GameDefinition } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { checkFeatureTrigger } from "./bonusTrigger.js";

/**
 * Tests for the decision that starts a bonus round.
 *
 * A bonus is the most expensive thing a spin can hand out, so both failure
 * directions cost real money: triggering when it should not pays rounds the
 * maths never priced, and failing to trigger silently removes a feature's
 * entire RTP budget from the game while every test still passes.
 *
 * The probability roll draws from the same seeded stream as the rest of the
 * spin, which is what keeps a round replayable from its stored seed. Two
 * tests below exist specifically to pin that.
 */

const GAME: GameDefinition = {
  gameId: "trigger-test",
  name: "Trigger fixture",
  version: 1,
  status: "published",
  grid: { reels: 3, rows: 3 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [],
  paylines: [[1, 1, 1]],
  symbols: [
    { symbol: "A", allowedReels: [0, 1, 2], role: "regular", paytable: { 3: 5 } },
    {
      symbol: "W",
      allowedReels: [0, 1, 2],
      role: "wild",
      wildConfig: { substitutesFor: "all-regular" },
    },
    {
      symbol: "star",
      allowedReels: [0, 1, 2],
      role: "bonusTrigger",
      bonusTriggerConfig: { module: "wheel", minCount: 3 },
    },
  ],
  bonusModules: [{ moduleId: "wheel", params: {} }],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

/** A valid 32-byte seed derived deterministically from a label, since
 * `createRng` requires 64 hex characters and `generateSeed()` is random. */
function seedFrom(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** An Rng replaying a fixed sequence, so a probability roll is exact. */
function scriptedRng(...values: number[]): Rng {
  let i = 0;
  return { next: () => values[Math.min(i++, values.length - 1)] };
}

/** A 3x3 grid holding exactly `n` copies of `symbol`. */
function withSymbol(n: number, symbol: string): Matrix {
  const cells = Array.from({ length: 9 }, (_, i) => (i < n ? symbol : "A"));
  return [cells.slice(0, 3), cells.slice(3, 6), cells.slice(6, 9)];
}

describe("symbol trigger", () => {
  it("fires once the count reaches minCount", () => {
    const result = checkFeatureTrigger(withSymbol(3, "star"), GAME, scriptedRng(0.99));

    assert.equal(result.triggered, true);
    assert.equal(result.moduleId, "wheel");
  });

  it("fires above minCount too", () => {
    // `>=`, not `===`. A game where four triggers pays nothing extra but
    // must still start the round.
    assert.equal(checkFeatureTrigger(withSymbol(5, "star"), GAME, scriptedRng(0.99)).triggered, true);
  });

  it("does not fire below minCount", () => {
    assert.equal(checkFeatureTrigger(withSymbol(2, "star"), GAME, scriptedRng(0.99)).triggered, false);
    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), GAME, scriptedRng(0.99)).triggered, false);
  });

  it("counts triggers anywhere on the grid, like a scatter", () => {
    const spread: Matrix = [
      ["star", "A", "A"],
      ["A", "A", "star"],
      ["A", "star", "A"],
    ];

    assert.equal(checkFeatureTrigger(spread, GAME, scriptedRng(0.99)).triggered, true);
  });

  it("ignores a symbol that is not declared a bonusTrigger", () => {
    // Role is the authority. A leftover bonusTriggerConfig on a regular
    // symbol — what a mid-edit definition looks like — must not fire.
    const staleConfig: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) =>
        s.symbol === "A" ? { ...s, bonusTriggerConfig: { module: "wheel" as const, minCount: 1 } } : s,
      ),
    };

    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), staleConfig, scriptedRng(0.99)).triggered, false);
  });

  it("ignores a bonusTrigger symbol with no config", () => {
    const noConfig: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => (s.symbol === "star" ? { ...s, bonusTriggerConfig: undefined } : s)),
    };

    assert.equal(checkFeatureTrigger(withSymbol(9, "star"), noConfig, scriptedRng(0.99)).triggered, false);
  });

  it("breaks a tie by definition order, so the same grid always picks the same module", () => {
    // Determinism matters more than which module wins: a grid that could
    // start either feature must not pick differently on replay.
    const twoTriggers: GameDefinition = {
      ...GAME,
      symbols: [
        ...GAME.symbols,
        {
          symbol: "gem",
          allowedReels: [0, 1, 2],
          role: "bonusTrigger",
          bonusTriggerConfig: { module: "pick", minCount: 1 },
        },
      ],
      bonusModules: [{ moduleId: "wheel", params: {} }, { moduleId: "pick", params: {} }],
    } as GameDefinition;

    const both: Matrix = [
      ["star", "star", "star"],
      ["gem", "A", "A"],
      ["A", "A", "A"],
    ];

    const first = checkFeatureTrigger(both, twoTriggers, scriptedRng(0.99));
    assert.equal(first.moduleId, "wheel", "the earlier definition wins");
    assert.equal(checkFeatureTrigger(both, twoTriggers, scriptedRng(0.99)).moduleId, first.moduleId);
  });
});

describe("wild interaction", () => {
  const gridWithWild: Matrix = [
    ["star", "star", "W"],
    ["A", "A", "A"],
    ["A", "A", "A"],
  ];

  it("does not count a wild toward the trigger by default", () => {
    // Two stars and a wild is two, not three — a wild completing a bonus
    // trigger hands out rounds the maths never priced.
    assert.equal(checkFeatureTrigger(gridWithWild, GAME, scriptedRng(0.99)).triggered, false);
  });

  it("does not count a wild that lists the trigger unless the trigger opts in", () => {
    // Isolates `wildCountsToward` from the substitution rule: the wild here
    // explicitly lists "star", so only the missing opt-in can refuse it.
    const wildListsTrigger: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => (s.symbol === "W" ? { ...s, wildConfig: { substitutesFor: ["star"] } } : s)),
    };

    assert.equal(checkFeatureTrigger(gridWithWild, wildListsTrigger, scriptedRng(0.99)).triggered, false);
  });

  it("counts a wild when the trigger opts in AND the wild lists it", () => {
    const optedInBoth: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.map((s) => {
        if (s.symbol === "W") return { ...s, wildConfig: { substitutesFor: ["star"] } };
        if (s.symbol === "star") {
          return { ...s, bonusTriggerConfig: { module: "wheel" as const, minCount: 3, wildCountsToward: true } };
        }
        return s;
      }),
    };

    assert.equal(checkFeatureTrigger(gridWithWild, optedInBoth, scriptedRng(0.99)).triggered, true);
  });
});

describe("probability trigger", () => {
  const chanceGame: GameDefinition = {
    ...GAME,
    // No symbol trigger at all, so only the probability path can fire.
    symbols: GAME.symbols.filter((s) => s.role !== "bonusTrigger"),
    bonusModules: [{ moduleId: "wheel", params: {}, probabilityTrigger: { chancePerSpin: 0.25 } }],
  } as GameDefinition;

  it("fires when the roll falls below the configured chance", () => {
    const result = checkFeatureTrigger(withSymbol(0, "star"), chanceGame, scriptedRng(0.1));

    assert.equal(result.triggered, true);
    assert.equal(result.moduleId, "wheel");
  });

  it("does not fire when the roll is above the chance", () => {
    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), chanceGame, scriptedRng(0.9)).triggered, false);
  });

  it("treats the boundary as a miss", () => {
    // `<`, not `<=`. At chance 0.25 a roll of exactly 0.25 must not fire,
    // or the effective rate is fractionally above the configured one.
    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), chanceGame, scriptedRng(0.25)).triggered, false);
  });

  it("never fires at zero or absent chance", () => {
    const zero: GameDefinition = {
      ...chanceGame,
      bonusModules: [{ moduleId: "wheel", params: {}, probabilityTrigger: { chancePerSpin: 0 } }],
    } as GameDefinition;
    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), zero, scriptedRng(0)).triggered, false);

    const absent: GameDefinition = { ...chanceGame, bonusModules: [{ moduleId: "wheel", params: {} }] };
    assert.equal(checkFeatureTrigger(withSymbol(0, "star"), absent, scriptedRng(0)).triggered, false);
  });

  it("fires at about the configured rate over many spins", () => {
    // The aggregate check that would catch a boundary or comparison error
    // the single-roll tests above could miss.
    let fired = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      const rng = createRng(seedFrom(`seed-${i}`));
      if (checkFeatureTrigger(withSymbol(0, "star"), chanceGame, rng).triggered) fired++;
    }

    const rate = fired / trials;
    assert.ok(Math.abs(rate - 0.25) < 0.02, `expected about 25%, got ${(rate * 100).toFixed(1)}%`);
  });
});

describe("precedence between the two paths", () => {
  const bothPaths: GameDefinition = {
    ...GAME,
    bonusModules: [{ moduleId: "wheel", params: {}, probabilityTrigger: { chancePerSpin: 1 } }],
  } as GameDefinition;

  it("lets a symbol trigger win without consuming the probability roll", () => {
    // The draw sequence must not diverge based on a roll that was never
    // needed — that is what keeps the spin replayable from its seed.
    let draws = 0;
    const counting: Rng = {
      next: () => {
        draws++;
        return 0.0;
      },
    };

    const result = checkFeatureTrigger(withSymbol(3, "star"), bothPaths, counting);
    assert.equal(result.triggered, true);
    assert.equal(draws, 0, "a symbol trigger must short-circuit before any roll");
  });

  it("rolls the probability path only when no symbol trigger fired", () => {
    let draws = 0;
    const counting: Rng = {
      next: () => {
        draws++;
        return 0.0;
      },
    };

    const result = checkFeatureTrigger(withSymbol(0, "star"), bothPaths, counting);
    assert.equal(result.triggered, true, "chance 1 always fires");
    assert.equal(draws, 1, "exactly one roll consumed");
  });
});

describe("replay", () => {
  it("reaches the identical outcome from the same seed", () => {
    // The property the whole audit story rests on: a stored seed must
    // reproduce the trigger decision exactly, not merely a similar one.
    const chanceGame: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.filter((s) => s.role !== "bonusTrigger"),
      bonusModules: [{ moduleId: "wheel", params: {}, probabilityTrigger: { chancePerSpin: 0.5 } }],
    } as GameDefinition;

    for (const seed of ["a", "b", "c", "d"]) {
      const first = checkFeatureTrigger(withSymbol(0, "star"), chanceGame, createRng(seedFrom(seed)));
      const second = checkFeatureTrigger(withSymbol(0, "star"), chanceGame, createRng(seedFrom(seed)));
      assert.deepEqual(first, second, `seed '${seed}' must replay identically`);
    }
  });
});

describe("games with no bonus at all", () => {
  it("never triggers", () => {
    const plain: GameDefinition = {
      ...GAME,
      symbols: GAME.symbols.filter((s) => s.role !== "bonusTrigger"),
      bonusModules: [],
    };

    assert.deepEqual(checkFeatureTrigger(withSymbol(9, "star"), plain, scriptedRng(0)), { triggered: false });
  });
});
