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

/**
 * A fixed seed for the assertions about **margin**.
 *
 * Not a stability crutch — the variance here is structural, and measuring it
 * is what picked this fix over the obvious one. The bonus pays **40.5x the
 * bet** on a rare trigger, so a run's RTP is dominated by how many triggers
 * happened to land, which is a low-rate count rather than an average over
 * 200k spins. Measured: sd is ~0.0066 at 200k and ~0.0077 at 500k — flat
 * where genuine per-spin noise would have fallen as sqrt(n). Raising
 * `SIM_COUNT` therefore buys almost nothing, which is worth recording
 * because it is the first thing anyone would try.
 *
 * The seed is not cherry-picked, and that was checked rather than assumed:
 * across ten arbitrary seeds the worst drift was 0.0149 against a 0.025
 * threshold, so **every** seed passes. The fixture was always sound; the
 * measurement was what wobbled.
 *
 * Reproducible without being unrepresentative — `runSimulation` derives a
 * distinct per-spin seed by HMAC rather than running one deterministic
 * stream, so a seeded run still exercises the same seeding path a real
 * round takes.
 */
const MARGIN_SEED = "free-spins-fixture-margin";

/** Seed for the base-return check, which runs at its own larger sample size
 * — see that test for why more spins is the right fix there and not here. */
const BASE_RTP_SEED = "free-spins-fixture-base";

/**
 * `bonusReturnMultiplier` is only consulted when the bonus is NOT played,
 * so this passes `playBonus: false` alongside it. Before the bonus could
 * be played, a multiplier of 0 was how a caller asked for the base game
 * alone; it now means "score the played bonus at 0x", which is not the
 * same thing and silently included the feature.
 */
function simulate(bonusReturnMultiplier: number, runSeed?: string): number {
  return runSimulation(FREE_SPINS_GAME, {
    simCount: SIM_COUNT,
    betPerSpin: 100,
    playBonus: false,
    bonusReturnMultiplier,
    ...(runSeed !== undefined ? { runSeed } : {}),
  }).resultRtp;
}

describe("free-spins-5x3 fixture", () => {
  it("declares a base RTP constant that matches what the base game measures", () => {
    /*
     * FREE_SPINS_BASE_RTP is handed to the module as `assumedBaseRtp`, so
     * it is not documentation — it is an input to the number the publish
     * gate checks. A drift here means the gate is scoring the feature
     * against a base return the game no longer has.
     *
     * **This test was flaky, and the flake was telling the truth.** It ran
     * unseeded at 200k spins against a 0.02 tolerance, and failed roughly
     * one run in fifteen. Two things were wrong, and only fixing both
     * settles it:
     *
     *   1. The constant was **0.81 against a true base return of 0.8024**,
     *      re-measured over five independent 2M-spin runs. That 0.0076 bias
     *      spent 38% of the tolerance before any sampling — so the test was
     *      not measuring what it claimed to have margin for. Corrected in
     *      the fixture.
     *   2. Even with the constant right, an unseeded 200k run drifts up to
     *      ~0.024 — more than the whole tolerance. Measured after the
     *      correction: still one failure in ten unseeded runs.
     *
     * Seeded and raised to 500k, which unlike the gate test below actually
     * works here: with no bonus contributing, this is ordinary per-spin
     * sampling and sd falls as sqrt(n) (0.0093 at 200k, 0.0026 at 1M).
     * 500k is the knee — worst drift across ten *arbitrary* seeds is 0.0091
     * (2.2x headroom) for ~3.3s, where 1M costs double for 2.7x. The seed
     * is therefore not load-bearing and not cherry-picked: every seed
     * tried passes comfortably, which is the property that makes pinning
     * one honest rather than convenient.
     */
    const measured = runSimulation(FREE_SPINS_GAME, {
      simCount: 500_000,
      betPerSpin: 100,
      playBonus: false,
      runSeed: BASE_RTP_SEED,
    }).resultRtp;

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

    /*
     * The two assertions below are seeded differently on purpose, because
     * they are claims about different things.
     *
     * The **gate** check is left unseeded. It asks what a designer's real
     * publish would do, and a real publish draws a fresh sample — pinning a
     * seed here would check the same 200k spins forever and let a paytable
     * change pass on a run that happened to flatter it. It has room to
     * absorb that: measured drift across seeded and unseeded runs alike
     * peaked at 0.0170 against this 0.05 threshold, so it is roughly 3x
     * clear rather than marginally clear.
     *
     * The **margin** check is seeded. It is not asking "did this run come
     * out well", it is asking "is the fixture tuned far enough from the
     * gate that a bad run cannot fail it" — a claim about the fixture's
     * tuning, which does not change between runs. Measuring it with a fresh
     * sample each time meant the assertion's own noise was the thing most
     * likely to trip it, which is how it failed once here without anything
     * being wrong. See `MARGIN_SEED` for why more spins is not the fix.
     */
    const gateMeasured = simulate(derived);
    const gateDrift = Math.abs(gateMeasured - FREE_SPINS_GAME.rtpTarget);
    assert.ok(
      gateDrift < GATE_TOLERANCE,
      `measured ${gateMeasured.toFixed(4)} drifts ${gateDrift.toFixed(4)} from target`,
    );

    const marginDrift = Math.abs(simulate(derived, MARGIN_SEED) - FREE_SPINS_GAME.rtpTarget);
    assert.ok(
      marginDrift < GATE_TOLERANCE / 2,
      `drift ${marginDrift.toFixed(4)} leaves too little margin for sampling noise`,
    );
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
      playBonus: false,
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
