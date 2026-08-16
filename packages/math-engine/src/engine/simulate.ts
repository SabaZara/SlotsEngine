import { generateSeed } from "@slots-engine/rng";
import type { GameDefinition } from "@slots-engine/shared-types";
import { evaluateSpin } from "./spin.js";

export interface SimulationReport {
  gameId: string;
  gameVersion: number;
  simCount: number;
  /** Integer minor units staked per simulated spin. */
  betPerSpin: number;
  /** Total returned / total staked. A real game sits below 1.0 — the gap is
   * the business. Above 1.0 means the game pays out more than it takes. */
  resultRtp: number;
  /** The portion of `resultRtp` from base-game wins (lines + scatters). */
  baseRtp: number;
  /** The portion from bonus rounds. `baseRtp + bonusRtp === resultRtp`. */
  bonusRtp: number;
  /** Share of spins returning any win at all. */
  hitFrequency: number;
  /** Share of spins triggering a bonus. */
  bonusFrequency: number;
  /** Standard deviation of per-spin return as a multiple of the bet — how
   * swingy the game feels. Independent of RTP: two games can return the
   * same and feel completely different. */
  volatilityIndex: number;
  /** Largest single-spin win seen, as a multiple of the bet. */
  maxWinMultiplier: number;
}

export interface SimulationOptions {
  simCount: number;
  /** Defaults to the game's lowest bet option. */
  betPerSpin?: number;
  /**
   * Estimated return of one bonus round, as a multiple of the bet. The
   * simulation counts a triggered bonus at this rate rather than playing
   * the module: modules carry their own internal randomness and are
   * multi-step, so folding them in here would conflate two separate
   * questions. Set from a module's own expected value.
   */
  bonusReturnMultiplier?: number;
  /** Called with progress in [0,1] — a million spins is long enough that a
   * caller may want to report progress or abort. */
  onProgress?: (fraction: number) => void;
}

/**
 * Monte Carlo estimate of a game's real return, run before a game may ship.
 * The declared `rtpTarget` on a definition is an intention; this is the
 * measurement — and the two disagreeing is the single most common way a
 * misconfigured paytable gets caught.
 *
 * Each spin draws a fresh cryptographic seed, so the estimate reflects the
 * same seeding path a real round takes rather than one long deterministic
 * stream that could mask a seeding defect.
 */
export function runSimulation(gameDef: GameDefinition, options: SimulationOptions): SimulationReport {
  const { simCount } = options;
  if (!Number.isInteger(simCount) || simCount <= 0) {
    throw new Error(`runSimulation requires a positive integer simCount, got ${simCount}`);
  }

  const betPerSpin = options.betPerSpin ?? Math.min(...gameDef.betOptions);
  if (!Number.isInteger(betPerSpin) || betPerSpin <= 0) {
    throw new Error(`runSimulation requires a positive integer betPerSpin, got ${betPerSpin}`);
  }
  const bonusReturnMultiplier = options.bonusReturnMultiplier ?? 0;

  let baseReturned = 0;
  let bonusReturned = 0;
  let hits = 0;
  let bonuses = 0;
  let maxWin = 0;
  // Sum of squared per-spin returns, for the variance below. Accumulated as
  // a bet multiple rather than minor units so the figure stays comparable
  // across games with different bet sizes.
  let sumSquaredMultiples = 0;
  let sumMultiples = 0;

  const progressEvery = Math.max(1, Math.floor(simCount / 100));

  for (let i = 0; i < simCount; i++) {
    const spin = evaluateSpin(gameDef, generateSeed(), betPerSpin);
    const base = spin.evaluation.totalWin;
    const bonus = spin.evaluation.bonusTriggered ? Math.floor(betPerSpin * bonusReturnMultiplier) : 0;

    baseReturned += base;
    bonusReturned += bonus;
    if (base > 0) hits++;
    if (spin.evaluation.bonusTriggered) bonuses++;

    const total = base + bonus;
    if (total > maxWin) maxWin = total;

    const multiple = total / betPerSpin;
    sumMultiples += multiple;
    sumSquaredMultiples += multiple * multiple;

    if (options.onProgress && i % progressEvery === 0) options.onProgress(i / simCount);
  }

  const staked = betPerSpin * simCount;
  const meanMultiple = sumMultiples / simCount;
  const variance = Math.max(0, sumSquaredMultiples / simCount - meanMultiple * meanMultiple);

  return {
    gameId: gameDef.gameId,
    gameVersion: gameDef.version,
    simCount,
    betPerSpin,
    resultRtp: (baseReturned + bonusReturned) / staked,
    baseRtp: baseReturned / staked,
    bonusRtp: bonusReturned / staked,
    hitFrequency: hits / simCount,
    bonusFrequency: bonuses / simCount,
    volatilityIndex: Math.sqrt(variance),
    maxWinMultiplier: maxWin / betPerSpin,
  };
}
