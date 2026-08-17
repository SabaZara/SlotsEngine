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

  // Declared here rather than in the backoffice, per F24: a list kept in a
  // second place drifts, and nothing fails when it does. The default shown
  // is `DEFAULT_REWARDS` above, which is what `rewards()` substitutes for
  // anything malformed — so a designer can see that an empty field is a
  // choice with a value rather than an omission.
  paramSchema: [
    {
      key: "rewardMultipliers",
      label: "Reward multipliers",
      type: "numberList",
      defaultValue: DEFAULT_REWARDS,
      min: 0,
      help:
        "One entry per wheel segment, as a multiple of the bet. Every segment is equally likely, so the odds come from how many times a multiplier appears — list 2 twice to make it twice as likely. The average of this list is exactly the wheel's expected return, which is the number the publish gate uses.",
    },
  ],

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

  /**
   * **Exact**, not an estimate. Every segment is equally likely — that is
   * the property the module's own docstring promises — so the expected
   * multiplier is the arithmetic mean of the reward table, and there is no
   * player decision and no accumulation to model.
   *
   * Reads the table through the same `rewards()` helper `start` uses, so a
   * malformed `rewardMultipliers` falls back to exactly the defaults the
   * round would actually pay. Deriving from a separately-parsed copy would
   * be the classic way for this number to drift from reality without
   * anything failing.
   */
  expectedReturnMultiplier(params: Record<string, unknown>): number {
    const table = rewards(params);
    return table.reduce((sum, multiplier) => sum + multiplier, 0) / table.length;
  },
};
