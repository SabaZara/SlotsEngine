import { DEFAULT_MATH_ENGINE_ID, type GameDefinition } from "@slots-engine/shared-types";
import type { RngAlgorithmId } from "@slots-engine/rng";
import { evaluateSpin, type SpinResult } from "./engine/spin.js";

/**
 * A math engine is the swappable unit of "how a spin is evaluated". Keeping
 * this a registry rather than a direct import is what makes the algorithm a
 * real per-game config choice (`GameDefinition.mathEngineId`) instead of a
 * theoretical one: a game with unusual mechanics can register its own
 * evaluator without the money path in game-backend changing at all.
 */
export interface MathEngine {
  id: string;
  evaluateSpin(gameDef: GameDefinition, seed: string, totalBet: number, rngAlgorithm?: RngAlgorithmId): SpinResult;
}

const engines = new Map<string, MathEngine>();

export function registerMathEngine(engine: MathEngine): void {
  engines.set(engine.id, engine);
}

/**
 * Throws rather than silently falling back to the default engine: a game
 * asking for an evaluator that isn't registered is a deployment error, and
 * quietly paying it out under different math would be far worse than
 * refusing the spin.
 */
export function getMathEngine(id: string): MathEngine {
  const engine = engines.get(id);
  if (!engine) {
    throw new Error(`no math engine registered under id '${id}' (registered: ${[...engines.keys()].join(", ") || "none"})`);
  }
  return engine;
}

export const genericMathEngine: MathEngine = {
  id: DEFAULT_MATH_ENGINE_ID,
  evaluateSpin,
};

registerMathEngine(genericMathEngine);
