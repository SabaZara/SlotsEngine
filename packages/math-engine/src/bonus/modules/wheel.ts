import { rollInt } from "@slots-engine/rng";
import type { BonusModule, BonusStepInput, BonusStepOutput } from "../types.js";
import { InvalidBonusActionError } from "../types.js";

const DEFAULT_REWARDS = [2, 3, 5, 8, 12, 20, 35, 50];

function rewards(params: Record<string, unknown>): number[] {
  const configured = params.rewardMultipliers;
  if (!Array.isArray(configured) || configured.length === 0) return DEFAULT_REWARDS;
  const parsed = configured.filter((v): v is number => typeof v === "number" && v >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_REWARDS;
}

/**
 * Single-step wheel: one spin, one prize, resolved immediately.
 *
 * Every segment is equally likely — the prize spread comes entirely from
 * how many segments carry each multiplier, which keeps the module's
 * expected value something a designer can compute by reading `params`
 * rather than by reading this file.
 */
export const wheelModule: BonusModule = {
  moduleId: "wheel",

  start({ totalBet, params, rng }): BonusStepOutput {
    const table = rewards(params);
    const index = rollInt(rng, table.length);
    const multiplier = table[index];
    const totalWin = Math.floor(totalBet * multiplier);

    return {
      state: { segmentIndex: index, multiplier },
      done: true,
      totalWin,
      // The full table is safe to reveal: it's already in the game
      // definition the client can read, and the client needs it to draw the
      // wheel. What it never learns is the next result before it happens.
      view: { segmentIndex: index, multiplier, segments: table, totalWin },
    };
  },

  step(_input: BonusStepInput): BonusStepOutput {
    // A resolved-on-start module has nothing to step. Throwing rather than
    // returning a no-op keeps a client bug loud instead of silent.
    throw new InvalidBonusActionError("the wheel module resolves on start and accepts no further actions");
  },
};
