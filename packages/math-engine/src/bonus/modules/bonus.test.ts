import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSeed } from "@slots-engine/rng";
import { deriveStepRng, getBonusModule } from "../registry.js";
import { InvalidBonusActionError } from "../types.js";

const PICK_PARAMS = { rewardMultipliers: [1, 2, 3, 5, 8], tileCount: 6, blankCount: 2 };

describe("wheel module", () => {
  const wheel = getBonusModule("wheel");

  it("resolves on start, in one step", () => {
    const out = wheel.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng(generateSeed(), 0) });
    assert.equal(out.done, true);
    assert.ok(out.totalWin > 0);
  });

  it("is deterministic for a given session seed and step", () => {
    const seed = generateSeed();
    const a = wheel.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng(seed, 0) });
    const b = wheel.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng(seed, 0) });
    assert.deepEqual(a, b, "a replayed bonus must produce the identical prize");
  });

  it("pays a whole number of minor units", () => {
    for (let i = 0; i < 200; i++) {
      const out = wheel.start({ totalBet: 137, state: {}, params: {}, rng: deriveStepRng(generateSeed(), 0) });
      assert.ok(Number.isInteger(out.totalWin), `totalWin ${out.totalWin} is not an integer`);
    }
  });

  it("only ever pays a configured segment value", () => {
    const params = { rewardMultipliers: [2, 5, 10] };
    const allowed = new Set([200, 500, 1000]);
    for (let i = 0; i < 200; i++) {
      const out = wheel.start({ totalBet: 100, state: {}, params, rng: deriveStepRng(generateSeed(), 0) });
      assert.ok(allowed.has(out.totalWin), `paid ${out.totalWin}, which is not a configured segment`);
    }
  });

  it("rejects a step, rather than silently accepting one", () => {
    assert.throws(
      () => wheel.step({ totalBet: 100, state: {}, params: {}, action: "spin", rng: deriveStepRng(generateSeed(), 1) }),
      InvalidBonusActionError,
    );
  });
});

describe("pick module", () => {
  const pick = getBonusModule("pick");
  const start = (seed: string) => pick.start({ totalBet: 100, state: {}, params: PICK_PARAMS, rng: deriveStepRng(seed, 0) });

  it("decides the whole layout at start, so a later pick is a pure lookup", () => {
    const out = start(generateSeed());
    assert.equal((out.state.tiles as unknown[]).length, PICK_PARAMS.tileCount);
    assert.equal(out.done, false);
    assert.equal(out.totalWin, 0);
  });

  it("never reveals the tile layout to the client", () => {
    const out = start(generateSeed());
    assert.ok(!("tiles" in out.view), "the layout would hand the client the outcome in advance");
    assert.equal(out.view.tileCount, PICK_PARAMS.tileCount);
  });

  it("gives the same result no matter how concurrent steps interleave", () => {
    // The reference implementation rolled a prize at reveal time, so two
    // concurrent steps could each produce a different value — the session's
    // recorded win could then disagree with what was actually paid. With the
    // layout fixed at start, a repeated step is idempotent by construction.
    const state = start(generateSeed()).state;
    const step = () =>
      pick.step({
        totalBet: 100,
        state,
        params: PICK_PARAMS,
        action: "pick",
        payload: { tileIndex: 0 },
        rng: deriveStepRng(generateSeed(), 1),
      });
    const a = step();
    const b = step();
    assert.deepEqual(a, b, "the same pick against the same state must always produce the same outcome");
  });

  it("accumulates across picks and ends on a blank", () => {
    // Walk a real session to completion, whatever layout came up.
    let state = start(generateSeed()).state;
    let done = false;
    let steps = 0;
    let lastWin = 0;

    for (let index = 0; index < PICK_PARAMS.tileCount && !done; index++) {
      const out = pick.step({
        totalBet: 100,
        state,
        params: PICK_PARAMS,
        action: "pick",
        payload: { tileIndex: index },
        rng: deriveStepRng("x".repeat(64), index + 1),
      });
      state = out.state;
      done = out.done;
      lastWin = out.totalWin;
      steps++;
    }

    assert.ok(done, "a session must terminate within the number of tiles");
    assert.ok(steps > 0);
    assert.ok(Number.isInteger(lastWin), `totalWin ${lastWin} is not an integer`);
  });

  it("pays nothing until the round is actually over", () => {
    const state = start(generateSeed()).state;
    const out = pick.step({
      totalBet: 100,
      state,
      params: PICK_PARAMS,
      action: "pick",
      payload: { tileIndex: 0 },
      rng: deriveStepRng(generateSeed(), 1),
    });
    if (!out.done) assert.equal(out.totalWin, 0, "an unfinished round must not report a payable win");
  });

  it("refuses a repeated reveal of the same tile", () => {
    // Pick a tile that is definitely NOT a blank: revealing a blank ends
    // the round, and a second step would then be refused as "already
    // finished" — a correct refusal, but a different one than this test is
    // about. Choosing the tile from the known layout keeps the test aimed
    // at the duplicate-reveal guard specifically.
    const started = start(generateSeed());
    const tiles = started.state.tiles as Array<number | null>;
    const prizeIndex = tiles.findIndex((tile) => tile !== null);

    const first = pick.step({
      totalBet: 100,
      state: started.state,
      params: PICK_PARAMS,
      action: "pick",
      payload: { tileIndex: prizeIndex },
      rng: deriveStepRng(generateSeed(), 1),
    });
    assert.equal(first.done, false, "a prize tile must not end the round");

    assert.throws(
      () =>
        pick.step({
          totalBet: 100,
          state: first.state,
          params: PICK_PARAMS,
          action: "pick",
          payload: { tileIndex: prizeIndex },
          rng: deriveStepRng(generateSeed(), 2),
        }),
      /already been revealed/,
    );
  });

  it("refuses an out-of-range tile", () => {
    assert.throws(
      () =>
        pick.step({
          totalBet: 100,
          state: start(generateSeed()).state,
          params: PICK_PARAMS,
          action: "pick",
          payload: { tileIndex: 99 },
          rng: deriveStepRng(generateSeed(), 1),
        }),
      /out of range/,
    );
  });

  it("refuses an unknown action", () => {
    assert.throws(
      () =>
        pick.step({
          totalBet: 100,
          state: start(generateSeed()).state,
          params: PICK_PARAMS,
          action: "cashout",
          rng: deriveStepRng(generateSeed(), 1),
        }),
      /unsupported action/,
    );
  });

  it("always leaves at least one prize tile, however misconfigured", () => {
    const out = pick.start({
      totalBet: 100,
      state: {},
      params: { tileCount: 3, blankCount: 99 },
      rng: deriveStepRng(generateSeed(), 0),
    });
    const tiles = out.state.tiles as Array<number | null>;
    assert.ok(tiles.some((t) => t !== null), "a round with no prize at all would be unwinnable");
  });
});

describe("deriveStepRng", () => {
  it("gives a different stream per step, and the same stream on replay", () => {
    const seed = generateSeed();
    assert.equal(deriveStepRng(seed, 1).next(), deriveStepRng(seed, 1).next());
    assert.notEqual(deriveStepRng(seed, 1).next(), deriveStepRng(seed, 2).next());
  });
});

describe("bonus registry", () => {
  it("throws for an unregistered module rather than substituting one", () => {
    assert.throws(() => getBonusModule("nope"), /no bonus module registered/);
  });
});

/**
 * `expectedReturnMultiplier` — what the publish gate uses in place of
 * playing the module (docs/TODO.md item G).
 *
 * Tested here, at the module, as well as at the adapter: these pin the
 * *arithmetic*, while `simulateClient.test.ts` pins the wiring and the
 * fallbacks. The distinction matters because a 100k-spin simulation cannot
 * tell 16.875 from 16.9 — sampling noise is larger than the difference — so
 * only a direct assertion on the number is capable of catching a drift.
 */
describe("expectedReturnMultiplier", () => {
  describe("wheel — exact, since every segment is equally likely", () => {
    it("is the arithmetic mean of the configured reward table", () => {
      // [10,20,30,40] -> 25. Chosen so the answer is checkable by eye.
      assert.equal(getBonusModule("wheel").expectedReturnMultiplier!({ rewardMultipliers: [10, 20, 30, 40] }), 25);
    });

    it("agrees with what the module actually pays, over many rounds", () => {
      // The claim is that this number describes the real payout. Playing
      // 40k rounds against the same table must converge to it — if the
      // derivation ever drifts from `start`, this catches it where an
      // assertion on the formula alone could not.
      const params = { rewardMultipliers: [2, 3, 5, 8, 12, 20, 35, 50] };
      const expected = getBonusModule("wheel").expectedReturnMultiplier!(params)!;

      let total = 0;
      const rounds = 40_000;
      for (let i = 0; i < rounds; i++) {
        const out = getBonusModule("wheel").start({ totalBet: 1_000_000, params, state: {}, rng: deriveStepRng(`w${i}`, 0) });
        total += out.totalWin / 1_000_000;
      }
      const actual = total / rounds;

      assert.ok(
        Math.abs(actual - expected) < 0.5,
        `derived ${expected} but 40k rounds averaged ${actual.toFixed(4)}`,
      );
    });

    it("uses the module's own defaults for a malformed table", () => {
      // Must agree with what `start` would pay, which falls back the same
      // way. Deriving from a separately-parsed copy is how the two drift.
      assert.equal(getBonusModule("wheel").expectedReturnMultiplier!({ rewardMultipliers: "nope" }), 16.875);
      assert.equal(getBonusModule("wheel").expectedReturnMultiplier!({}), 16.875);
    });
  });

  describe("pick — prizeCount/(blanks+1) x mean reward", () => {
    it("computes the expected accumulation for a player who picks until a blank", () => {
      // 9 tiles, 1 blank, single reward of 10: 8/(1+1) x 10 = 40.
      assert.equal(
        getBonusModule("pick").expectedReturnMultiplier!({ tileCount: 9, blankCount: 1, rewardMultipliers: [10] }),
        40,
      );
    });

    it("agrees with what the module actually pays under that stopping rule", () => {
      // The formula's justification, checked against the module rather than
      // against itself. Plays each round by revealing tiles in order until a
      // blank ends it — which is what a player with no cash-out can do.
      const params = { tileCount: 9, blankCount: 2, rewardMultipliers: [1, 2, 3, 5, 8, 12, 20, 40] };
      const expected = getBonusModule("pick").expectedReturnMultiplier!(params)!;
      const bet = 1_000_000;

      let total = 0;
      const rounds = 20_000;
      for (let i = 0; i < rounds; i++) {
        let out = getBonusModule("pick").start({ totalBet: bet, params, state: {}, rng: deriveStepRng(`p${i}`, 0) });
        let state = out.state;
        for (let tile = 0; tile < 9 && !out.done; tile++) {
          out = getBonusModule("pick").step({
            totalBet: bet,
            state,
            params,
            action: "pick",
            payload: { tileIndex: tile },
            rng: deriveStepRng(`p${i}`, tile + 1),
          });
          state = out.state;
        }
        total += out.totalWin / bet;
      }
      const actual = total / rounds;

      assert.ok(
        Math.abs(actual - expected) < 1.5,
        `derived ${expected.toFixed(4)} but 20k played rounds averaged ${actual.toFixed(4)}`,
      );
    });

    it("pays less as blanks rise, since a round ends sooner", () => {
      const at = (blankCount: number) =>
        getBonusModule("pick").expectedReturnMultiplier!({ tileCount: 9, blankCount, rewardMultipliers: [10] })!;

      assert.ok(at(1) > at(2) && at(2) > at(4), "more blanks must mean a smaller expected return");
    });

    it("never reports a non-positive return, however the tiles are configured", () => {
      // `config` guarantees at least one prize tile. Without that floor the
      // formula could report zero, and a zero bonus return would silently
      // drop the whole bonus contribution from the gate's input.
      const result = getBonusModule("pick").expectedReturnMultiplier!({ tileCount: 3, blankCount: 99, rewardMultipliers: [10] })!;

      assert.ok(result > 0 && Number.isFinite(result), `got ${result}`);
    });
  });
});
