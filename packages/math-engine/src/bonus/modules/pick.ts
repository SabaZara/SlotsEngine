import { rollInt } from "@slots-engine/rng";
import type { BonusModule, BonusStepInput, BonusStepOutput } from "../types.js";
import { InvalidBonusActionError } from "../types.js";

const DEFAULT_REWARDS = [1, 2, 3, 5, 8, 12, 20, 40];
const DEFAULT_TILE_COUNT = 9;
/** How many tiles end the round when revealed. */
const DEFAULT_BLANK_COUNT = 2;

interface PickState {
  /** Prize behind each tile; `null` marks a round-ending blank. Decided in
   * full at `start` and never touched again — see the note below. */
  tiles: Array<number | null>;
  revealed: number[];
  accumulated: number;
  done: boolean;
}

function config(params: Record<string, unknown>): { rewards: number[]; tileCount: number; blankCount: number } {
  const rawRewards = Array.isArray(params.rewardMultipliers)
    ? params.rewardMultipliers.filter((v): v is number => typeof v === "number" && v >= 0)
    : [];
  const tileCount = typeof params.tileCount === "number" && params.tileCount >= 2 ? Math.floor(params.tileCount) : DEFAULT_TILE_COUNT;
  const blankCount = typeof params.blankCount === "number" && params.blankCount >= 1 ? Math.floor(params.blankCount) : DEFAULT_BLANK_COUNT;
  return {
    rewards: rawRewards.length > 0 ? rawRewards : DEFAULT_REWARDS,
    tileCount,
    // Always leave at least one prize tile, whatever a designer configures.
    blankCount: Math.min(blankCount, tileCount - 1),
  };
}

function readState(state: Record<string, unknown>): PickState {
  const tiles = state.tiles;
  if (!Array.isArray(tiles)) throw new InvalidBonusActionError("pick session has no tile layout");
  return {
    tiles: tiles as Array<number | null>,
    revealed: Array.isArray(state.revealed) ? (state.revealed as number[]) : [],
    accumulated: typeof state.accumulated === "number" ? state.accumulated : 0,
    done: state.done === true,
  };
}

/**
 * Multi-step pick-a-prize: reveal tiles one at a time, accumulating, until
 * a blank ends the round or every prize tile is found.
 *
 * **The entire tile layout is decided at `start`, not per pick.** This is
 * the load-bearing design decision in the module. If a tile's value were
 * rolled at reveal time, the outcome would depend on the ORDER and TIMING
 * of client actions, and two concurrent step requests could each roll a
 * different prize — the exact failure the reference implementation had, and
 * the reason a session's recorded win could disagree with what was actually
 * paid. Deciding everything up front makes `step` a pure lookup: replaying
 * the same picks against the same start state always produces the same
 * total, no matter how the calls interleave.
 */
export const pickModule: BonusModule = {
  moduleId: "pick",

  start({ params, rng }): BonusStepOutput {
    const { rewards, tileCount, blankCount } = config(params);

    const tiles: Array<number | null> = [];
    for (let i = 0; i < tileCount - blankCount; i++) {
      tiles.push(rewards[rollInt(rng, rewards.length)]);
    }
    for (let i = 0; i < blankCount; i++) tiles.push(null);

    // Fisher-Yates, drawing from the same seeded stream — so the layout is
    // as replayable as the prizes themselves.
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = rollInt(rng, i + 1);
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }

    const state: PickState = { tiles, revealed: [], accumulated: 0, done: false };
    return {
      state: { ...state },
      done: false,
      totalWin: 0,
      // Only the tile COUNT is revealed — never `tiles` itself, which would
      // hand the client the entire outcome in advance.
      view: { tileCount: tiles.length, revealed: [], picks: [], accumulatedMultiplier: 0 },
    };
  },

  step({ totalBet, state: rawState, action, payload, rng: _rng }: BonusStepInput): BonusStepOutput {
    const state = readState(rawState);
    if (state.done) throw new InvalidBonusActionError("this bonus session is already finished");
    if (action !== "pick") throw new InvalidBonusActionError(`unsupported action '${action}' — the pick module accepts 'pick'`);

    const index = typeof payload?.tileIndex === "number" ? payload.tileIndex : -1;
    if (!Number.isInteger(index) || index < 0 || index >= state.tiles.length) {
      throw new InvalidBonusActionError(`tileIndex ${index} is out of range`);
    }
    if (state.revealed.includes(index)) {
      throw new InvalidBonusActionError(`tile ${index} has already been revealed`);
    }

    const prize = state.tiles[index];
    const revealed = [...state.revealed, index];
    const accumulated = state.accumulated + (prize ?? 0);

    const remainingPrizes = state.tiles.filter((tile, i) => tile !== null && !revealed.includes(i)).length;
    const done = prize === null || remainingPrizes === 0;
    const totalWin = done ? Math.floor(totalBet * accumulated) : 0;

    const next: PickState = { tiles: state.tiles, revealed, accumulated, done };
    return {
      state: { ...next },
      done,
      totalWin,
      view: {
        tileCount: state.tiles.length,
        revealed,
        // Only the tiles actually turned over, in the order they were
        // picked. The unrevealed remainder stays server-side even after the
        // round ends, so a replayed view can't leak a future layout.
        picks: revealed.map((i) => ({ tileIndex: i, multiplier: state.tiles[i] })),
        accumulatedMultiplier: accumulated,
        ...(done ? { totalWin } : {}),
      },
    };
  },
};
