import { runSimulation } from "@slots-engine/math-engine";
import type { GameDefinition } from "@slots-engine/shared-types";

export interface SimulationReport {
  simCount: number;
  betPerSpin: number;
  resultRtp: number;
  baseRtp: number;
  bonusRtp: number;
  hitFrequency: number;
  bonusFrequency: number;
  volatilityIndex: number;
  maxWinMultiplier: number;
  generatedAt: string;
}

/**
 * Estimated return of one bonus round, as a multiple of the bet.
 *
 * The simulation counts a triggered bonus at this flat rate rather than
 * playing the module, because a module is multi-step and carries its own
 * randomness — folding it in would conflate "is the base game's maths
 * right" with "is the bonus module's maths right", and a drift in either
 * would look identical in the result.
 *
 * It is an assumption, and it is stated here rather than buried: a game
 * whose real bonus pays very differently will have a correspondingly wrong
 * `bonusRtp`. Deriving this per module is tracked as a known gap.
 */
const ASSUMED_BONUS_RETURN_MULTIPLIER = 20;

/**
 * Runs the pre-publish simulation.
 *
 * Deliberately runs **in this process**, against the shared `math-engine`
 * package, rather than calling game-backend's `/internal/simulate`. Both
 * services import the identical evaluator, so the numbers are the same
 * either way — but a 100k-spin synchronous run on the service that is
 * concurrently paying out real spins would stall live players for the sake
 * of an authoring convenience. The backoffice is the right place to absorb
 * that cost: if a publish is briefly slow, one designer waits.
 */
export async function requestSimulation(
  gameDef: GameDefinition,
  simCount: number,
  betPerSpin: number,
): Promise<SimulationReport> {
  const report = runSimulation(gameDef, {
    simCount,
    betPerSpin,
    bonusReturnMultiplier: ASSUMED_BONUS_RETURN_MULTIPLIER,
  });

  return {
    simCount: report.simCount,
    betPerSpin: report.betPerSpin,
    resultRtp: report.resultRtp,
    baseRtp: report.baseRtp,
    bonusRtp: report.bonusRtp,
    hitFrequency: report.hitFrequency,
    bonusFrequency: report.bonusFrequency,
    volatilityIndex: report.volatilityIndex,
    maxWinMultiplier: report.maxWinMultiplier,
    generatedAt: new Date().toISOString(),
  };
}
