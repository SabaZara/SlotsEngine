import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSimulation } from "./simulate.js";
import { REFERENCE_GAME } from "./fixtures/reference-game.js";

describe("runSimulation", () => {
  /** Enough spins for the estimate to settle, few enough to stay a fast
   * test. The band below is sized to this count. */
  const SIM_COUNT = 120_000;
  const BONUS_RETURN = 20;

  it("measures the reference game near its declared rtpTarget", () => {
    // This is the test that would actually catch a broken paytable, a
    // mis-split stake, or a payout rounding the wrong way — any of those
    // move this number well outside the band.
    const report = runSimulation(REFERENCE_GAME, {
      simCount: SIM_COUNT,
      betPerSpin: 100,
      bonusReturnMultiplier: BONUS_RETURN,
    });

    assert.ok(
      Math.abs(report.resultRtp - REFERENCE_GAME.rtpTarget) < 0.04,
      `measured RTP ${report.resultRtp.toFixed(4)} is too far from target ${REFERENCE_GAME.rtpTarget}`,
    );
  });

  it("reports an RTP below 1.0 — the fixture must be a shippable game", () => {
    // A reference game that pays back more than it takes exercises the
    // plumbing but teaches the wrong intuition to everyone who reads it.
    const report = runSimulation(REFERENCE_GAME, { simCount: SIM_COUNT, betPerSpin: 100, bonusReturnMultiplier: BONUS_RETURN });
    assert.ok(report.resultRtp < 1, `a shippable game must return less than it takes, got ${report.resultRtp}`);
  });

  it("splits return into base and bonus that sum to the total", () => {
    const report = runSimulation(REFERENCE_GAME, { simCount: 20_000, betPerSpin: 100, bonusReturnMultiplier: BONUS_RETURN });
    assert.ok(Math.abs(report.baseRtp + report.bonusRtp - report.resultRtp) < 1e-9);
  });

  it("attributes nothing to bonus when no bonus return is configured", () => {
    const report = runSimulation(REFERENCE_GAME, { simCount: 20_000, betPerSpin: 100 });
    assert.equal(report.bonusRtp, 0);
    assert.equal(report.baseRtp, report.resultRtp);
  });

  it("reports frequencies as real proportions", () => {
    const report = runSimulation(REFERENCE_GAME, { simCount: 20_000, betPerSpin: 100, bonusReturnMultiplier: BONUS_RETURN });
    assert.ok(report.hitFrequency > 0 && report.hitFrequency < 1, `implausible hit frequency ${report.hitFrequency}`);
    assert.ok(report.bonusFrequency >= 0 && report.bonusFrequency < 1);
    assert.ok(report.volatilityIndex > 0, "a game with varying payouts must have non-zero volatility");
  });

  it("defaults the bet to the game's lowest option", () => {
    const report = runSimulation(REFERENCE_GAME, { simCount: 1000 });
    assert.equal(report.betPerSpin, Math.min(...REFERENCE_GAME.betOptions));
  });

  it("rejects a non-positive simCount rather than returning a meaningless report", () => {
    assert.throws(() => runSimulation(REFERENCE_GAME, { simCount: 0 }), /positive integer simCount/);
  });
});
