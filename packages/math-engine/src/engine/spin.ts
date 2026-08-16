import type { GameDefinition, RoundEvaluation } from "@slots-engine/shared-types";
import { createRng, DEFAULT_RNG_ALGORITHM, type RngAlgorithmId } from "@slots-engine/rng";
import { buildMatrix, type Matrix } from "./matrix.js";
import { applyExpandingWild } from "./wild.js";
import { evaluatePaylines } from "./paylines.js";
import { evaluateScatter } from "./scatter.js";
import { checkFeatureTrigger } from "./bonusTrigger.js";

export interface SpinResult {
  seed: string;
  /** Which RNG algorithm produced `stops`/`rawMatrix` from `seed` — the
   * caller persists this on the round so a future replay uses the algorithm
   * the round actually ran with, not whatever the current default became. */
  rngAlgorithm: RngAlgorithmId;
  stops: number[];
  /** The grid as drawn, before expanding wilds. Kept alongside
   * `finalMatrix` so an auditor can see what the expansion changed. */
  rawMatrix: Matrix;
  finalMatrix: Matrix;
  expandedReels: number[];
  evaluation: RoundEvaluation;
}

/**
 * The single authoritative entry point for turning (gameDef, seed, bet)
 * into a spin outcome.
 *
 * Deterministic and free of I/O: the same inputs always produce the same
 * result. Those two properties are what let the caller run this inside a
 * database transaction safely and replay any historical round from its
 * stored seed alone.
 */
export function evaluateSpin(
  gameDef: GameDefinition,
  seed: string,
  totalBet: number,
  rngAlgorithm: RngAlgorithmId = DEFAULT_RNG_ALGORITHM,
): SpinResult {
  const rng = createRng(seed, rngAlgorithm);
  const { stops, matrix: rawMatrix } = buildMatrix(gameDef, rng);
  const { matrix: finalMatrix, expandedReels } = applyExpandingWild(rawMatrix, gameDef);

  const { winLines, lineWinTotal } = evaluatePaylines(finalMatrix, gameDef, totalBet);
  const scatter = evaluateScatter(finalMatrix, gameDef, totalBet);
  const bonus = checkFeatureTrigger(finalMatrix, gameDef, rng);

  const evaluation: RoundEvaluation = {
    winLines,
    lineWinTotal,
    scatterAmount: scatter.amount,
    totalWin: lineWinTotal + scatter.amount,
    bonusTriggered: bonus.triggered,
    // Conditionally spread rather than `bonusModuleId: bonus.moduleId`: an
    // explicit `key: undefined` and an absent key are different own-property
    // shapes in JS, even though Mongo stores both the same way. Built this
    // way, a round fresh out of this function is byte-for-byte identical to
    // the same round read back from the database — not merely equivalent
    // after a JSON round-trip.
    ...(bonus.moduleId !== undefined ? { bonusModuleId: bonus.moduleId } : {}),
  };

  return { seed, rngAlgorithm, stops, rawMatrix, finalMatrix, expandedReels, evaluation };
}
