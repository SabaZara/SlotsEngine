import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REFERENCE_GAME } from "../engine/fixtures/reference-game.js";
import { FREE_SPINS_GAME } from "../engine/fixtures/free-spins-game.js";
import { bonusSeedForSpin, playOutBonus } from "./playOut.js";

/**
 * What these cannot establish: that the modules' own payouts are correct.
 * They pin that a round is played to resolution and that the same seed
 * always pays the same, which is what the simulation depends on. Whether
 * `wheel`'s prize table is the right prize table is the module's own
 * tests' subject, not this file's.
 */
describe("playing a bonus round out", () => {
  it("resolves the reference game's wheel and pays a real amount", () => {
    const r = playOutBonus({
      gameDef: REFERENCE_GAME,
      moduleId: REFERENCE_GAME.bonusModules[0]!.moduleId,
      totalBet: 100,
      sessionSeed: bonusSeedForSpin("seed-a"),
    });
    assert.ok(r.steps >= 1, "a resolved round must have taken at least one step");
    assert.ok(r.totalWin >= 0, `a bonus cannot pay a negative amount, got ${r.totalWin}`);
    assert.equal(Number.isInteger(r.totalWin), true, "money is integer minor units");
  });

  it("resolves free spins, which needs the game's own reels rather than inventing them", () => {
    // freeSpins refuses to run without `gameDef` — a spin evaluated against
    // anything but this game's reels pays under maths nobody configured.
    const r = playOutBonus({
      gameDef: FREE_SPINS_GAME,
      moduleId: FREE_SPINS_GAME.bonusModules[0]!.moduleId,
      totalBet: 100,
      sessionSeed: bonusSeedForSpin("seed-b"),
    });
    assert.ok(r.steps > 1, "free spins is multi-step and cannot resolve on start alone");
    assert.ok(r.totalWin >= 0);
  });

  it("pays the same amount for the same seed, so a seeded simulation replays exactly", () => {
    // The property the whole change rests on: without it a "seeded" run
    // would still wander whenever a spin triggered a bonus.
    const of = (seed: string) =>
      playOutBonus({
        gameDef: REFERENCE_GAME,
        moduleId: REFERENCE_GAME.bonusModules[0]!.moduleId,
        totalBet: 100,
        sessionSeed: bonusSeedForSpin(seed),
      }).totalWin;
    assert.equal(of("same"), of("same"));
  });

  it("derives a different round per spin, rather than paying one prize forever", () => {
    // The opposite failure: a constant seed would make every bonus in a
    // 100k-spin run pay identically and the measured bonusRtp meaningless.
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const wins = new Set(
      seeds.map(
        (s) =>
          playOutBonus({
            gameDef: REFERENCE_GAME,
            moduleId: REFERENCE_GAME.bonusModules[0]!.moduleId,
            totalBet: 100,
            sessionSeed: bonusSeedForSpin(s),
          }).totalWin,
      ),
    );
    assert.ok(wins.size > 1, `every seed paid the same prize (${[...wins]}) — the seed is not reaching the module`);
  });

  it("refuses a module that never finishes, rather than scoring a partial round", () => {
    assert.throws(
      () =>
        playOutBonus({
          gameDef: FREE_SPINS_GAME,
          moduleId: FREE_SPINS_GAME.bonusModules[0]!.moduleId,
          totalBet: 100,
          sessionSeed: bonusSeedForSpin("seed-c"),
          maxSteps: 1,
        }),
      /did not resolve within 1 steps/,
      "an unfinished round must throw — a partial total is an RTP no player could receive",
    );
  });

  it("names an unplayable module instead of looping to the step ceiling", () => {
    assert.throws(
      () =>
        playOutBonus({
          gameDef: REFERENCE_GAME,
          moduleId: "no-such-module",
          totalBet: 100,
          sessionSeed: bonusSeedForSpin("seed-d"),
        }),
      /no bonus module registered/,
    );
  });
});
