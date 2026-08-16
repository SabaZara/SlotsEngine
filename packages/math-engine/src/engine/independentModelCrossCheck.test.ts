import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameDefinition } from "@slots-engine/shared-types";
import { runSimulation } from "./simulate.js";

/**
 * Does the real stack agree with an INDEPENDENTLY derived probability
 * model — not merely with itself?
 *
 * Every other test in this package checks self-consistency: the evaluator
 * behaves sensibly, matches its own documented rules, produces plausible
 * numbers. None of them can catch a rule that is implemented consistently
 * and *wrong*, because the thing they compare against is the same code.
 *
 * This file is a second source of truth. The expected RTP below is worked
 * out from plain combinatorial probability, written without importing or
 * reusing a single line of `paylines.ts`, `matrix.ts` or `simulate.ts`, and
 * then compared against the real `runSimulation` — which drives the real
 * matrix generation, the real payline evaluator and the real seeded RNG.
 * If the evaluator ever pays differently from what the maths says, this is
 * the test that notices, and it is the closest thing here to the
 * verification a certification lab performs.
 *
 * ## Why the fixture looks the way it does
 *
 * Every choice below exists to make the hand-derived formula EXACT rather
 * than an approximation:
 *
 * - **`weighted-symbol` mode.** Each grid cell is drawn independently, so
 *   multiplying per-cell probabilities is exactly right. In `reel-strip`
 *   mode two rows on one reel come from adjacent positions in the same
 *   cyclic window and are correlated, which would make the closed form an
 *   approximation and the comparison meaningless.
 * - **One row.** With `rows: 1` each reel contributes exactly one cell, so
 *   a payline is a straight read across the grid and there is no choice of
 *   row to model.
 * - **No wilds, no scatters, no bonus.** Each of those deserves its own
 *   cross-check; bundling them here would leave a failure ambiguous about
 *   which subsystem broke. This isolates payline matching and paytable
 *   lookup — the largest surface for a real bug.
 * - **One payline, `betPerSpin` equal to it.** `splitIntegerEvenly` then
 *   hands the single line the whole stake with no remainder, so "lineBet =
 *   totalBet" is exact rather than a rounding assumption.
 * - **Two symbols with clean weights.** Probabilities are exact binary
 *   fractions, so the arithmetic below carries no floating-point slop.
 */

/**
 * Three reels, one row, one payline, two symbols drawn 50/50 per cell.
 *
 * `A` pays on runs of 2 and 3 from reel 0; `B` pays nothing, and exists
 * only to be the way a run ends.
 */
const CROSS_CHECK_GAME: GameDefinition = {
  gameId: "cross-check-3x1",
  name: "Cross-check fixture",
  version: 1,
  status: "published",
  grid: { reels: 3, rows: 1 },
  reelGenerationMode: "weighted-symbol",
  symbolWeights: [
    [
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 1 },
    ],
    [
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 1 },
    ],
    [
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 1 },
    ],
  ],
  paylines: [[0, 0, 0]],
  symbols: [
    { symbol: "A", allowedReels: [0, 1, 2], role: "regular", paytable: { 2: 2, 3: 10 } },
    { symbol: "B", allowedReels: [0, 1, 2], role: "regular", paytable: {} },
  ],
  bonusModules: [],
  rtpTarget: 0.95,
  betOptions: [100],
  mathEngineId: "generic-v1",
};

/**
 * The independent model.
 *
 * Each cell is `A` with probability 1/2, independently. A run is counted
 * from reel 0 and must start there, so with three reels there are exactly
 * three outcomes that pay anything:
 *
 *   AAA  — probability (1/2)^3       = 1/8  → paytable[3] = 10x line bet
 *   AAB  — probability (1/2)^2 * 1/2 = 1/8  → paytable[2] = 2x  line bet
 *   AB*  — run of 1; paytable has no entry for 1, so it pays nothing.
 *   B**  — no run from reel 0 at all; pays nothing.
 *
 * Note AAB is the ONLY way to get a run of exactly two: the run must begin
 * at reel 0, so a trailing `AA` on reels 1-2 (i.e. `BAA`) pays nothing.
 * Getting that backwards is exactly the kind of off-by-one this test
 * exists to catch.
 *
 * Expected return per unit staked:
 *   1/8 * 10 + 1/8 * 2 = 1.25 + 0.25 = 1.5
 */
const P_AAA = 0.5 ** 3;
const P_AAB = 0.5 ** 2 * 0.5;
const EXPECTED_RTP = P_AAA * 10 + P_AAB * 2;

/** Hit rate: the share of spins paying anything at all. */
const EXPECTED_HIT_RATE = P_AAA + P_AAB;

describe("independent model cross-check", () => {
  it("derives an expected RTP of exactly 1.5 for this fixture", () => {
    // Pinned so a later edit to the fixture cannot silently move the
    // target the simulation is checked against — the model and the game
    // must be changed together, deliberately.
    assert.equal(EXPECTED_RTP, 1.5);
    assert.equal(EXPECTED_HIT_RATE, 0.25);
  });

  it("converges to the independently derived RTP", () => {
    const report = runSimulation(CROSS_CHECK_GAME, { simCount: 200_000, betPerSpin: 100 });

    // Tolerance from the statistics rather than picked to fit. Per spin the
    // return is 10 with p=1/8, 2 with p=1/8, else 0, giving a standard
    // deviation of about 3.4 bet-multiples; over N spins the standard error
    // of the mean is that over sqrt(N) — roughly 0.0076 at N=200,000. Four
    // standard errors is ~0.03, so a correct evaluator effectively never
    // fails this while a real payout bug moves the mean far further.
    const sd = Math.sqrt(P_AAA * 10 ** 2 + P_AAB * 2 ** 2 - EXPECTED_RTP ** 2);
    const tolerance = 4 * (sd / Math.sqrt(200_000));

    assert.ok(
      Math.abs(report.resultRtp - EXPECTED_RTP) < tolerance,
      `measured RTP ${report.resultRtp.toFixed(5)} differs from the independently derived ` +
        `${EXPECTED_RTP} by more than ${tolerance.toFixed(5)} — the evaluator and the maths disagree`,
    );
  });

  it("converges to the independently derived hit rate", () => {
    // A separate check because RTP alone can hide compensating errors: pay
    // the wrong symbol twice as often at half the multiplier and the return
    // is unchanged while the game plays completely differently.
    const report = runSimulation(CROSS_CHECK_GAME, { simCount: 200_000, betPerSpin: 100 });

    const sd = Math.sqrt(EXPECTED_HIT_RATE * (1 - EXPECTED_HIT_RATE));
    const tolerance = 4 * (sd / Math.sqrt(200_000));

    assert.ok(
      Math.abs(report.hitFrequency - EXPECTED_HIT_RATE) < tolerance,
      `hit frequency ${report.hitFrequency.toFixed(5)} differs from the derived ${EXPECTED_HIT_RATE} ` +
        `by more than ${tolerance.toFixed(5)}`,
    );
  });

  it("pays a run only when it starts at reel 0", () => {
    // The asymmetry the model depends on, checked directly rather than
    // inferred from the aggregate. If `BAA` paid, the measured RTP would
    // rise by 1/8 * 2 = 0.25 — a quarter of the stake, silently.
    //
    // Derived here from a fixture where `A` can only ever appear on reels
    // 1 and 2: reel 0 is always `B`, so no run can start at reel 0 and the
    // game must return exactly nothing however often `AA` appears.
    const noRunFromReelZero: GameDefinition = {
      ...CROSS_CHECK_GAME,
      gameId: "cross-check-no-anchor",
      symbolWeights: [
        [{ symbol: "B", weight: 1 }],
        [
          { symbol: "A", weight: 1 },
          { symbol: "B", weight: 1 },
        ],
        [
          { symbol: "A", weight: 1 },
          { symbol: "B", weight: 1 },
        ],
      ],
    };

    const report = runSimulation(noRunFromReelZero, { simCount: 20_000, betPerSpin: 100 });
    assert.equal(report.resultRtp, 0, "a run that does not start at reel 0 must pay nothing");
  });

  it("is capable of failing — a deliberately wrong model does not pass", () => {
    // Guards the guard. A cross-check that cannot fail is decoration, and
    // the failure mode is silent: tolerances wide enough to accept anything
    // still report green forever.
    const report = runSimulation(CROSS_CHECK_GAME, { simCount: 200_000, betPerSpin: 100 });
    const wrongModel = EXPECTED_RTP * 1.1;
    const sd = Math.sqrt(P_AAA * 10 ** 2 + P_AAB * 2 ** 2 - EXPECTED_RTP ** 2);
    const tolerance = 4 * (sd / Math.sqrt(200_000));

    assert.ok(
      Math.abs(report.resultRtp - wrongModel) > tolerance,
      "a model 10% off must be rejected, or the tolerance is too wide to detect a real bug",
    );
  });
});
