import { getBonusModule, runSimulation } from "@slots-engine/math-engine";
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
    /**
     * Where `assumedBonusReturnMultiplier` came from.
     *
     * `"derived"` — computed from the module's own configured payouts, so
     * it tracks the game being published. `"assumed"` — the flat fallback,
     * which is a guess about a module this code could not evaluate.
     *
     * Recorded because the two deserve very different amounts of trust, and
     * a single number cannot tell them apart. An auditor reading a stored
     * report should not have to know which modules happened to support
     * derivation on the day it was written.
     */
    bonusReturnSource: "derived" | "assumed";
    /** Named so a reader can tell WHICH module's return was derived or
     * guessed, rather than inferring it from the game definition. */
    bonusModuleId?: string;
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
 * Works out what one bonus round is worth, preferring the module's own
 * configured payouts over the flat constant above.
 *
 * This is docs/TODO.md item G's first option. The constant moves the gate's
 * own input by roughly 0.17 RTP against a tolerance of ±0.05 — larger than
 * the band it is compared against — so a game tuned to 0.95 could pass or
 * fail substantially on an assumption about a module the simulation never
 * played. `reference-5x3` happened to land well at 20x, which is why nothing
 * surfaced this in practice.
 *
 * Deriving does NOT mean playing the module. The original reasoning for not
 * playing it still holds: a multi-step module carries its own randomness,
 * and folding it in would conflate "is the base game's maths right" with "is
 * the bonus module's maths right", so a drift in either would look
 * identical. This computes the module's *expected value analytically* from
 * its parameters, which keeps the two questions separate while removing the
 * guess.
 *
 * Falls back to the constant, and says so, when:
 *   - the game declares no bonus module (nothing to derive, and the value is
 *     unused because `bonusFrequency` is zero);
 *   - the module does not implement `expectedReturnMultiplier`;
 *   - it implements it and returns `undefined`, meaning its return genuinely
 *     depends on something params cannot express;
 *   - it returns a value that is not a usable non-negative finite number.
 *
 * That last guard is not padding. A `NaN` here would flow into `bonusRtp`,
 * then into `resultRtp`, and `Math.abs(NaN - target) <= tolerance` is false
 * — so a malformed reward table would silently refuse every publish with a
 * verdict no report could explain. The same shape as F22, one module over.
 *
 * Only the first declared module is consulted. A game with several would
 * need weighting by each one's trigger share, which nothing in this codebase
 * currently expresses; `reference-5x3` and `pick-bonus-5x3` both declare
 * exactly one. Deriving from the first and ignoring the rest would be worse
 * than the flat constant, because it would look derived — so the multi-module
 * case deliberately falls back and is recorded in item G.
 */
export function resolveBonusReturnMultiplier(gameDef: GameDefinition): {
  multiplier: number;
  source: "derived" | "assumed";
  moduleId?: string;
} {
  const declared = gameDef.bonusModules ?? [];
  if (declared.length !== 1) {
    return { multiplier: ASSUMED_BONUS_RETURN_MULTIPLIER, source: "assumed" };
  }

  const [config] = declared;
  let module;
  try {
    module = getBonusModule(config.moduleId);
  } catch {
    // An unregistered module is a deployment error the publish route will
    // surface elsewhere; it must not take down the simulation with a throw
    // from a function whose job is producing a number.
    return { multiplier: ASSUMED_BONUS_RETURN_MULTIPLIER, source: "assumed", moduleId: config.moduleId };
  }

  const derived = module.expectedReturnMultiplier?.(config.params ?? {});
  if (typeof derived !== "number" || !Number.isFinite(derived) || derived < 0) {
    return { multiplier: ASSUMED_BONUS_RETURN_MULTIPLIER, source: "assumed", moduleId: config.moduleId };
  }

  return { multiplier: derived, source: "derived", moduleId: config.moduleId };
}

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
  const bonusReturn = resolveBonusReturnMultiplier(gameDef);

  const report = runSimulation(gameDef, {
    simCount,
    betPerSpin,
    bonusReturnMultiplier: bonusReturn.multiplier,
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
      assumedBonusReturnMultiplier: bonusReturn.multiplier,
      bonusReturnSource: bonusReturn.source,
      ...(bonusReturn.moduleId ? { bonusModuleId: bonusReturn.moduleId } : {}),
      estimatedShare: report.resultRtp === 0 ? 0 : report.bonusRtp / report.resultRtp,
    },
  };
}
