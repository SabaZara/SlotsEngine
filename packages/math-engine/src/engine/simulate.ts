import { createHmac } from "node:crypto";
import { generateSeed } from "@slots-engine/rng";
import type { GameDefinition } from "@slots-engine/shared-types";
import { bonusSeedForSpin, playOutBonus } from "../bonus/playOut.js";
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
  /**
   * Play the bonus module to resolution instead of scoring it at
   * `bonusReturnMultiplier`. Defaults to true.
   *
   * Set false only to measure the base game in isolation — the separation
   * `baseRtp`/`bonusRtp` already provides that in the report, so the flag
   * is for a caller who wants the bonus excluded entirely rather than
   * attributed.
   */
  playBonus?: boolean;
  /** Called with progress in [0,1] — a million spins is long enough that a
   * caller may want to report progress or abort. */
  onProgress?: (fraction: number) => void;
  /**
   * Makes a run reproducible: the same `runSeed`, game and spin count
   * produce the same report, every time.
   *
   * Omitted, each spin draws a fresh cryptographic seed and the run is a
   * genuine independent sample — which is what a fairness estimate wants,
   * but it makes a publish verdict unrepeatable. Measured on
   * `reference-5x3`, two runs of the SAME configuration at 100k spins differ
   * by around 0.02 RTP against a publish tolerance of ±0.05, so sampling
   * noise alone consumes roughly 40% of the tolerance budget: a game near
   * the edge passes or fails on which sample it drew, and a designer who
   * re-runs a refused publish may simply succeed. See docs/TODO.md item G.
   *
   * When set, per-spin seeds are DERIVED from it rather than the whole run
   * sharing one stream. That distinction is deliberate — the comment on this
   * function explains that each spin taking its own 32-byte seed is what
   * keeps the simulation on the same seeding path a real round uses, so a
   * defect in that path cannot hide behind one long deterministic sequence.
   * Seeding the run must not quietly give that up.
   */
  runSeed?: string;
}

/**
 * Per-spin seed for a reproducible run: HMAC of the spin index under the run
 * seed, giving a 32-byte value with the same shape and distribution as
 * `generateSeed()` produces.
 *
 * HMAC rather than a counter or a hash of the concatenation, so that
 * per-spin seeds cannot be walked backwards to the run seed and adjacent
 * spins share no structure — the simulation should exercise the evaluator
 * the same way real, unrelated seeds do.
 */
function derivedSeed(runSeed: string, index: number): string {
  return createHmac("sha256", runSeed).update(String(index)).digest("hex");
}

/**
 * Monte Carlo estimate of a game's real return, run before a game may ship.
 * The declared `rtpTarget` on a definition is an intention; this is the
 * measurement — and the two disagreeing is the single most common way a
 * misconfigured paytable gets caught.
 *
 * Each spin takes its own 32-byte seed, so the estimate reflects the same
 * seeding path a real round takes rather than one long deterministic stream
 * that could mask a seeding defect. That holds in both modes: without a
 * `runSeed` those seeds are freshly random, and with one they are derived
 * per spin — reproducible, but still a distinct seed per spin rather than a
 * shared generator.
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
  // Opt-out rather than opt-in: a caller that forgets the flag should get
  // the measured figure, not the assumed one.
  const playBonus = options.playBonus ?? true;
  const moduleId = gameDef.bonusModules[0]?.moduleId;

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
    const seed = options.runSeed !== undefined ? derivedSeed(options.runSeed, i) : generateSeed();
    const spin = evaluateSpin(gameDef, seed, betPerSpin);
    const base = spin.evaluation.totalWin;
    // Played, not assumed. `playBonus` defaults on so the reported RTP is
    // the one a player would receive; the flat multiplier remains for the
    // caller that deliberately wants the base game measured alone.
    let bonus = 0;
    if (spin.evaluation.bonusTriggered) {
      if (playBonus && moduleId !== undefined) {
        bonus = playOutBonus({
          gameDef,
          moduleId,
          totalBet: betPerSpin,
          sessionSeed: bonusSeedForSpin(seed),
        }).totalWin;
      } else {
        bonus = Math.floor(betPerSpin * bonusReturnMultiplier);
      }
    }

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
