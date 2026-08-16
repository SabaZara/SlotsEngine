import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FREE_SPINS_GAME, FREE_SPINS_BASE_RTP } from "./free-spins-game.js";
import { REFERENCE_GAME } from "./reference-game.js";
import { runSimulation } from "../simulate.js";
import { getBonusModule } from "../../bonus/registry.js";

/**
 * The free-spins game is a **shippable fixture**, not a test instrument,
 * so unlike `pick-bonus-5x3` it has to survive the same gate a designer's
 * game does. These tests are that gate, run against the fixture itself.
 *
 * Section F says fixtures are data and their properties are asserted where
 * they are used. This one earns an exception for a reason the others do
 * not have: **its RTP is a fitted number**, and the fit couples the base
 * paytable to the feature's return — the free spins are drawn from the same
 * paytable, so lowering the base lowers the bonus too. That coupling makes
 * the fit non-obvious (a 12% paytable reduction measured 0.927, a 10% one
 * overshot to 1.03, and 8% landed at 0.954) and easy to break with an edit
 * that looks locally harmless.
 *
 * ## What these cannot establish
 *
 * That a player's *experienced* RTP matches. `runSimulation` scores the
 * bonus with a single expected-return multiplier rather than playing the
 * rounds out — that is the gate's own model, and item G is the record of
 * how much it assumes. What is pinned here is that this fixture passes that
 * model comfortably, and that the constant the module is handed matches the
 * game it is handed with.
 */

/** The tolerance the publish gate applies. Kept as a literal rather than
 * imported so a change to the gate shows up here as a decision. */
const GATE_TOLERANCE = 0.05;
const SIM_COUNT = 200_000;

function simulate(bonusReturnMultiplier: number): number {
  return runSimulation(FREE_SPINS_GAME, { simCount: SIM_COUNT, betPerSpin: 100, bonusReturnMultiplier }).resultRtp;
}

describe("free-spins-5x3 fixture", () => {
  it("declares a base RTP constant that matches what the base game measures", () => {
    // FREE_SPINS_BASE_RTP is handed to the module as `assumedBaseRtp`, so
    // it is not documentation — it is an input to the number the publish
    // gate checks. A drift here means the gate is scoring the feature
    // against a base return the game no longer has.
    const measured = simulate(0);

    assert.ok(
      Math.abs(measured - FREE_SPINS_BASE_RTP) < 0.02,
      `base RTP measured ${measured.toFixed(4)}, constant declares ${FREE_SPINS_BASE_RTP}`,
    );
  });

  it("passes the publish gate's RTP band with room to spare", () => {
    // The test that would actually catch a broken paytable edit. Uses the
    // module's own derived multiplier rather than a hardcoded one, so a
    // change to `expectedReturnMultiplier` is caught here too.
    const derived = getBonusModule("freeSpins").expectedReturnMultiplier!(FREE_SPINS_GAME.bonusModules[0]!.params);
    const measured = simulate(derived);
    const drift = Math.abs(measured - FREE_SPINS_GAME.rtpTarget);

    assert.ok(drift < GATE_TOLERANCE, `measured ${measured.toFixed(4)} drifts ${drift.toFixed(4)} from target`);
    // Not merely inside the band — comfortably inside it, so ordinary
    // sampling noise cannot flip a green run red. Measured drift is ~0.004.
    assert.ok(drift < GATE_TOLERANCE / 2, `drift ${drift.toFixed(4)} leaves too little margin for sampling noise`);
  });

  it("returns less than it takes, so it is a game and not a giveaway", () => {
    const derived = getBonusModule("freeSpins").expectedReturnMultiplier!(FREE_SPINS_GAME.bonusModules[0]!.params);
    assert.ok(simulate(derived) < 1.0, "a shippable fixture must not pay back more than it takes");
  });

  it("pays less in the base game than the reference game does", () => {
    // The design claim in the fixture's own docstring: the base game funds
    // the feature. If this ever inverts, the paytable was edited without
    // the reasoning being revisited.
    const referenceBase = runSimulation(REFERENCE_GAME, {
      simCount: SIM_COUNT,
      betPerSpin: 100,
      bonusReturnMultiplier: 0,
    }).resultRtp;

    assert.ok(
      simulate(0) < referenceBase,
      "the free-spins game's base return should sit below the reference game's",
    );
  });

  it("triggers its bonus through the freeSpins module specifically", () => {
    // A fixture pointing at a module that is not registered fails only when
    // a player happens to trigger it — which on a real game is rare enough
    // to reach production.
    const trigger = FREE_SPINS_GAME.symbols.find((s) => s.role === "bonusTrigger");
    assert.ok(trigger, "the fixture must declare a bonus trigger symbol");
    assert.equal(trigger.bonusTriggerConfig?.module, "freeSpins");
    assert.equal(getBonusModule("freeSpins").moduleId, "freeSpins");
  });

  it("hands the module a capped retrigger count, so a round cannot run forever", () => {
    // The one parameter whose absence is unbounded rather than merely
    // wrong. A fixture omitting it would inherit the module's default,
    // which is safe — this pins that the fixture states it deliberately.
    const params = FREE_SPINS_GAME.bonusModules[0]!.params;
    assert.equal(typeof params.maxRetriggers, "number");
    assert.ok((params.maxRetriggers as number) >= 0);
  });

  it("declares every symbol its reel strips actually contain", () => {
    // A strip carrying a symbol the definition never declares evaluates as
    // an unknown symbol on a real spin. Cheap to check, and the kind of
    // thing a hand-edited strip gets wrong.
    const declared = new Set(FREE_SPINS_GAME.symbols.map((s) => s.symbol));
    for (const strip of FREE_SPINS_GAME.reelStrips ?? []) {
      for (const symbol of strip.symbols) {
        assert.ok(declared.has(symbol), `reel ${strip.reelIndex} carries undeclared symbol '${symbol}'`);
      }
    }
  });

  it("does not collide with the other shipped fixtures", () => {
    assert.notEqual(FREE_SPINS_GAME.gameId, REFERENCE_GAME.gameId);
    assert.equal(FREE_SPINS_GAME.gameId, "free-spins-5x3");
  });
});
