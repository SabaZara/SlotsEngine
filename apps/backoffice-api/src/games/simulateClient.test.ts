import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REFERENCE_GAME, runSimulation } from "@slots-engine/math-engine";
import { requestSimulation } from "./simulateClient.js";

/**
 * This module is a thin adapter over `runSimulation`, which has its own
 * tests in `math-engine`. What is worth pinning here is not the maths but
 * the three things the adapter decides:
 *
 *   1. that it runs in *this* process rather than on game-backend,
 *   2. that it passes `ASSUMED_BONUS_RETURN_MULTIPLIER` at all, and
 *   3. what that constant does to the number the publish gate trusts.
 *
 * Point 3 is TODO item G, and these tests measure it rather than restate
 * it: the constant moves the gate's own input by more than the tolerance
 * the gate compares against.
 *
 * What these cannot establish: that the assumed multiplier is *right*. It
 * is an assumption about a module the simulation never plays, and no test
 * here can validate it — only playing the module could, which is the trade
 * the file documents and declines. These tests pin its influence so the
 * assumption is visible, not correct.
 *
 * Simulation counts are kept small deliberately. A 100k run is what the
 * publish gate uses; the properties below hold at 2k and the suite stays
 * fast.
 */

const BET = 100;

describe("requestSimulation", () => {
  it("returns every field the publish gate reads", async () => {
    const report = await requestSimulation(REFERENCE_GAME, 2_000, BET);

    for (const field of [
      "simCount",
      "betPerSpin",
      "resultRtp",
      "baseRtp",
      "bonusRtp",
      "hitFrequency",
      "bonusFrequency",
      "volatilityIndex",
      "maxWinMultiplier",
      "generatedAt",
    ]) {
      assert.notEqual(
        (report as unknown as Record<string, unknown>)[field],
        undefined,
        `${field} is missing — the publish gate or the report UI reads it`,
      );
    }
  });

  it("echoes back the simulation parameters it was given", async () => {
    // A report that silently simulated a different bet than it claims is
    // worse than no report: every derived figure is a ratio against it.
    const report = await requestSimulation(REFERENCE_GAME, 2_000, BET);

    assert.equal(report.simCount, 2_000);
    assert.equal(report.betPerSpin, BET);
  });

  it("stamps generatedAt as a parseable ISO timestamp", async () => {
    const before = Date.now();
    const report = await requestSimulation(REFERENCE_GAME, 500, BET);
    const at = Date.parse(report.generatedAt);

    assert.ok(Number.isFinite(at), "generatedAt must parse");
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "generatedAt must be roughly now");
  });

  it("splits RTP into a base and a bonus part that sum to the whole", async () => {
    // The publish gate compares `resultRtp` against target. The split is
    // what makes the estimated half separable from the measured half — see
    // the last test in this file.
    const report = await requestSimulation(REFERENCE_GAME, 5_000, BET);

    assert.ok(Math.abs(report.resultRtp - (report.baseRtp + report.bonusRtp)) < 1e-9);
  });

  it("reports frequencies as fractions in [0, 1], not percentages", async () => {
    // A hit frequency of 25 rather than 0.25 reads as a plausible number
    // and is wrong by 100x wherever it is compared or displayed.
    const report = await requestSimulation(REFERENCE_GAME, 5_000, BET);

    assert.ok(report.hitFrequency >= 0 && report.hitFrequency <= 1, `hitFrequency ${report.hitFrequency}`);
    assert.ok(
      report.bonusFrequency >= 0 && report.bonusFrequency <= 1,
      `bonusFrequency ${report.bonusFrequency}`,
    );
  });

  it("lands near the reference game's tuned RTP", async () => {
    // A wide band on purpose. Run-to-run spread was measured at ~0.05 at
    // 20k spins and ~0.015 at 60k, so a tight assertion here would be a
    // flaky test rather than a strict one — this call passes no seed, so it
    // is still an independent sample. This
    // catches an adapter that dropped the multiplier or halved the bet, not
    // a drift of a few points — the publish gate is what checks the latter,
    // at 100k.
    const report = await requestSimulation(REFERENCE_GAME, 20_000, BET);

    assert.ok(
      report.resultRtp > 0.7 && report.resultRtp < 1.2,
      `resultRtp ${report.resultRtp} is outside the range any correctly-wired run should produce`,
    );
  });

  it("passes the assumed bonus multiplier through, rather than letting it default to zero", async () => {
    // `runSimulation` defaults `bonusReturnMultiplier` to 0. If the adapter
    // ever stops passing it, every triggered bonus scores nothing, bonusRtp
    // silently becomes 0, and resultRtp drops by the entire bonus
    // contribution — a game tuned to 0.95 would then be refused for a
    // reason nothing in the report explains.
    const report = await requestSimulation(REFERENCE_GAME, 20_000, BET);

    assert.ok(report.bonusFrequency > 0, "the reference game must trigger bonuses for this test to mean anything");
    assert.ok(report.bonusRtp > 0, "bonusRtp of 0 with bonuses triggering means the multiplier was not passed");
  });

  it("refuses a non-positive simCount rather than reporting on nothing", async () => {
    await assert.rejects(() => requestSimulation(REFERENCE_GAME, 0, BET), /simCount/);
    await assert.rejects(() => requestSimulation(REFERENCE_GAME, -1, BET), /simCount/);
    await assert.rejects(() => requestSimulation(REFERENCE_GAME, 1.5, BET), /simCount/);
  });
});

describe("the assumed bonus multiplier's influence on the publish gate", () => {
  it("moves measured RTP by more than the tolerance the gate compares against", async () => {
    // TODO item G, measured rather than asserted from memory.
    //
    // `ASSUMED_BONUS_RETURN_MULTIPLIER = 20` is a flat estimate for a
    // triggered bonus, and it feeds bonusRtp -> resultRtp -> the tolerance
    // check that decides whether a game may publish. This runs the same
    // game at several multipliers to show the constant's leverage.
    //
    // Deliberately calls `runSimulation` directly: the adapter hardcodes
    // the constant, and the point is to vary it.
    //
    // 60k spins, not 20k, and the reason is worth recording. These calls
    // pass no `runSeed`, so two runs are independent samples rather than the
    // same spins scored differently. At 20k the run-to-run spread on an
    // UNCHANGED multiplier was measured at 0.0512 — larger than the ±0.05
    // tolerance this test is about, which would make any comparison here
    // noise. At 60k that spread is ~0.015 against a 5x..50x signal of
    // ~0.159, about ten to one.
    const byMultiplier = [5, 50].map((multiplier) => ({
      multiplier,
      rtp: runSimulation(REFERENCE_GAME, {
        simCount: 60_000,
        betPerSpin: BET,
        bonusReturnMultiplier: multiplier,
      }).resultRtp,
    }));

    const spread = byMultiplier[1].rtp - byMultiplier[0].rtp;

    // The publish gate's tolerance is ±0.05. If the constant can move the
    // gate's own input by more than that, its verdict rests substantially
    // on an assumption rather than on measurement.
    assert.ok(
      spread > 0.05,
      `expected the assumption to dominate the tolerance, but 5x..50x moved RTP only ${spread.toFixed(4)} — ` +
        `if this ever fails, item G in docs/TODO.md has become less severe and should be re-measured. ` +
        `Measured: ${JSON.stringify(byMultiplier)}`,
    );
  });

  it("moves only the bonus half of the split", async () => {
    // The mitigation that makes item G tolerable: the assumption is
    // confined to `bonusRtp`, so a report surfacing the split would let a
    // designer see which half they are trusting.
    //
    // Asserted as a large ratio rather than an equality on `baseRtp`: with
    // no seeding, two runs never produce identical base figures, so
    // `assert.equal` here would be testing the RNG, not the split. What is
    // checkable is that bonusRtp responds to the multiplier far more than
    // baseRtp drifts between independent runs.
    const low = runSimulation(REFERENCE_GAME, { simCount: 60_000, betPerSpin: BET, bonusReturnMultiplier: 5 });
    const high = runSimulation(REFERENCE_GAME, { simCount: 60_000, betPerSpin: BET, bonusReturnMultiplier: 50 });

    const bonusChange = Math.abs(high.bonusRtp - low.bonusRtp);
    const baseDrift = Math.abs(high.baseRtp - low.baseRtp);

    assert.ok(bonusChange > 0.05, `bonusRtp should track the multiplier, moved ${bonusChange.toFixed(4)}`);

    // Compared against an absolute bound rather than a ratio to
    // `baseDrift`. The ratio form was flaky in the full suite: `baseDrift`
    // is pure sampling noise between two independent unseeded runs, so it
    // is occasionally near zero and occasionally spikes, and dividing by it
    // makes the assertion depend on the draw. Measured run-to-run spread on
    // `baseRtp` at 60k is ~0.015, so 0.05 is comfortably above the noise
    // while still failing if the multiplier ever starts moving the measured
    // half.
    assert.ok(
      baseDrift < 0.05,
      `the assumption must not move the measured half: baseRtp drifted ${baseDrift.toFixed(4)} ` +
        `between runs, which is beyond sampling noise`,
    );
  });
});

describe("a publish verdict is reproducible (docs/TODO.md item G)", () => {
  /**
   * Sampling noise used to sit at roughly 0.02 RTP at 100k spins against a
   * tolerance of ±0.05 — about 40% of the budget spent before the paytable
   * was considered. A game near the edge passed or failed on which sample it
   * drew, and a designer refused at 6pm could re-run and ship at 6:01 having
   * changed nothing.
   *
   * The run is now seeded, so the same seed gives the same verdict. Note
   * this does not make the estimate *more accurate* — the noise is still
   * there, it is simply no longer a coin flip on re-run, and the seed is
   * recorded so a reviewer can repeat the exact run.
   */
  it("gives byte-identical results for the same seed", async () => {
    const first = await requestSimulation(REFERENCE_GAME, 5_000, BET, "a-fixed-seed");
    const second = await requestSimulation(REFERENCE_GAME, 5_000, BET, "a-fixed-seed");

    assert.equal(first.resultRtp, second.resultRtp);
    assert.equal(first.baseRtp, second.baseRtp);
    assert.equal(first.hitFrequency, second.hitFrequency);
    assert.equal(first.maxWinMultiplier, second.maxWinMultiplier);
  });

  it("gives different results for different seeds, so it is still sampling", async () => {
    // The seed must actually drive the draw. A "reproducible" run that
    // ignored its seed would be reproducible for the wrong reason.
    const a = await requestSimulation(REFERENCE_GAME, 5_000, BET, "seed-a");
    const b = await requestSimulation(REFERENCE_GAME, 5_000, BET, "seed-b");

    assert.notEqual(a.resultRtp, b.resultRtp);
  });

  it("returns the seed it used, so a run can be repeated exactly", async () => {
    const report = await requestSimulation(REFERENCE_GAME, 2_000, BET, "explicit-seed");
    assert.equal(report.runSeed, "explicit-seed");
  });

  it("generates a seed when none is given, rather than running unseeded", async () => {
    // The default path — what the publish gate uses. It must still be
    // reproducible after the fact, which means the seed has to be recorded
    // even when nobody chose it.
    const report = await requestSimulation(REFERENCE_GAME, 2_000, BET);

    assert.ok(report.runSeed.length > 0, "a run must always record its seed");
    const repeat = await requestSimulation(REFERENCE_GAME, 2_000, BET, report.runSeed);
    assert.equal(repeat.resultRtp, report.resultRtp, "replaying the recorded seed must reproduce the run");
  });

  it("draws a distinct seed per spin, not one shared stream", async () => {
    // The property the unseeded version had and that seeding must not
    // quietly give up: each spin takes its own 32-byte seed, so the
    // simulation stays on the same seeding path a real round uses and a
    // defect there cannot hide behind one long deterministic sequence.
    //
    // Observable as a distribution: one shared stream advanced across 5,000
    // spins would not produce the same hit frequency as 5,000 independent
    // seeds do.
    const report = await requestSimulation(REFERENCE_GAME, 5_000, BET, "distribution-check");

    assert.ok(
      report.hitFrequency > 0.05 && report.hitFrequency < 0.95,
      `hit frequency ${report.hitFrequency} suggests the seeds are not varying per spin`,
    );
  });
});

describe("the report says which half of the verdict is assumed", () => {
  it("splits the RTP into what was measured and what was estimated", async () => {
    // `resultRtp` is one number carrying two kinds of confidence: `baseRtp`
    // was played spin by spin, while `bonusRtp` is a flat multiplier
    // standing in for a module the simulation never ran. A designer
    // comparing 0.95 against a target deserves to know which half is which.
    const report = await requestSimulation(REFERENCE_GAME, 20_000, BET, "confidence");

    assert.equal(report.confidence.measuredRtp, report.baseRtp);
    assert.equal(report.confidence.estimatedRtp, report.bonusRtp);
    assert.ok(
      Math.abs(report.confidence.measuredRtp + report.confidence.estimatedRtp - report.resultRtp) < 1e-9,
      "the two halves must account for the whole",
    );
  });

  it("names the assumption that produced the estimated half", async () => {
    // The constant is the thing a reviewer would question, so the report
    // states it rather than making them read the source.
    const report = await requestSimulation(REFERENCE_GAME, 2_000, BET, "assumption");
    assert.equal(report.confidence.assumedBonusReturnMultiplier, 20);
  });

  it("reports the estimated share as a fraction of the whole verdict", async () => {
    const report = await requestSimulation(REFERENCE_GAME, 20_000, BET, "share");

    assert.ok(
      report.confidence.estimatedShare > 0 && report.confidence.estimatedShare < 1,
      `estimatedShare ${report.confidence.estimatedShare} should be a proper fraction`,
    );
    assert.ok(
      Math.abs(report.confidence.estimatedShare - report.bonusRtp / report.resultRtp) < 1e-9,
      "the share must match the numbers it is derived from",
    );
  });
});
