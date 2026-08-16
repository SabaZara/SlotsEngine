import type { GameDefinition } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { isWild, symbolRule, wildSubstitutes } from "./wild.js";

export interface ScatterResult {
  /** Integer minor units. */
  amount: number;
  /** Per-scatter-symbol counts, for presentation and for a simulation
   * report to break down where RTP comes from. */
  counts: Record<string, number>;
}

/**
 * Scatters pay on how many appear anywhere on the grid — position is
 * irrelevant, which is exactly what distinguishes them from a payline
 * symbol and why they are counted here rather than in the line walk.
 *
 * A payout is `multiplier × totalBet`, floored to a whole minor unit.
 */
export function evaluateScatter(matrix: Matrix, gameDef: GameDefinition, totalBet: number): ScatterResult {
  const scatters = gameDef.symbols.filter((s) => s.role === "scatter");
  if (scatters.length === 0) return { amount: 0, counts: {} };

  const counts: Record<string, number> = {};
  let amount = 0;

  for (const scatter of scatters) {
    let count = 0;
    for (const column of matrix) {
      for (const symbol of column) {
        if (symbol === scatter.symbol) {
          count++;
        } else if (
          scatter.scatterConfig?.wildCountsToward === true &&
          isWild(gameDef, symbol) &&
          wildSubstitutes(gameDef, symbol, scatter.symbol)
        ) {
          // Only counts when this scatter's id is explicitly listed on the
          // wild — `wildSubstitutes` never treats "all-regular" as covering
          // a scatter, so an opted-in game still needs a deliberate listing.
          count++;
        }
      }
    }

    counts[scatter.symbol] = count;
    const multiplier = scatter.scatterConfig?.payout?.[count];
    if (multiplier !== undefined && multiplier > 0) {
      amount += Math.floor(totalBet * multiplier);
    }
  }

  return { amount, counts };
}

/** Counts one symbol across the grid, honouring the symbol's own
 * `wildCountsToward` opt-in. Shared by bonus-trigger checking. */
export function countSymbol(matrix: Matrix, gameDef: GameDefinition, symbol: string, wildCounts: boolean): number {
  let count = 0;
  for (const column of matrix) {
    for (const cell of column) {
      if (cell === symbol) count++;
      else if (wildCounts && isWild(gameDef, cell) && wildSubstitutes(gameDef, cell, symbol)) count++;
    }
  }
  return count;
}

export { symbolRule };
