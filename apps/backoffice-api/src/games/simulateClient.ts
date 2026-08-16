import { runSimulation } from "@slots-engine/math-engine";
import { generateSeed } from "@slots-engine/rng";
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
  /** The seed this run used. Recorded so the verdict is reproducible — see
   * `requestSimulation`. */
  runSeed: string;
  /** How much of `resultRtp` is measured rather than assumed, stated so a
   * designer can see which half they are trusting. */
  confidence: {
    /** `baseRtp` — actually played, spin by spin. */
    measuredRtp: number;
    /** `bonusRtp` — scored at a flat multiplier, never played. */
    estimatedRtp: number;
    /** The multiplier that produced `estimatedRtp`. */
    assumedBonusReturnMultiplier: number;
    /** Share of `resultRtp` that rests on the assumption above. */
    estimatedShare: number;
  };
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
  runSeed: string = generateSeed(),
): Promise<SimulationReport> {
  // Seeded, so a publish verdict is reproducible.
  //
  // Unseeded, this is an independent sample every time, and sampling noise
  // at 100k spins is around 0.02 RTP against a tolerance of ±0.05 — roughly
  // 40% of the budget spent before the paytable is considered. A game near
  // the edge then passes or fails on which sample it drew, and a designer
  // refused at 6pm can re-run and ship at 6:01 without changing anything.
  // The seed is returned on the report so the run can be repeated exactly,
  // by a reviewer or by the designer.
  const report = runSimulation(gameDef, {
    simCount,
    betPerSpin,
    bonusReturnMultiplier: ASSUMED_BONUS_RETURN_MULTIPLIER,
    runSeed,
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
    runSeed,
    // Stated rather than left implicit. `resultRtp` is one number carrying
    // two very different kinds of confidence: `baseRtp` was played spin by
    // spin, while `bonusRtp` is a flat multiplier standing in for a module
    // the simulation never ran. A designer comparing 0.95 against a target
    // deserves to know which half is which — docs/TODO.md item G.
    confidence: {
      measuredRtp: report.baseRtp,
      estimatedRtp: report.bonusRtp,
      assumedBonusReturnMultiplier: ASSUMED_BONUS_RETURN_MULTIPLIER,
      estimatedShare: report.resultRtp === 0 ? 0 : report.bonusRtp / report.resultRtp,
    },
  };
}
