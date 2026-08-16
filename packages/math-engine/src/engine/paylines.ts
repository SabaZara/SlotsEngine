import {
  DEFAULT_PAYLINE_WIN_RULE,
  splitIntegerEvenly,
  type GameDefinition,
  type WinLine,
} from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";
import { isWild, symbolRule, wildSubstitutes } from "./wild.js";

export interface PaylineResult {
  winLines: WinLine[];
  /** Integer minor units. */
  lineWinTotal: number;
}

interface LineMatch {
  anchorSymbol: string;
  matchedCount: number;
  positions: Array<{ reel: number; row: number }>;
  /** Product of every participating wild's own multiplier. */
  wildMultiplier: number;
}

/**
 * Walks one payline left to right and reports the longest run from reel 0.
 *
 * Two rules that are easy to get subtly wrong:
 *
 * 1. **A leading run of wilds does not anchor to "wild".** The run's paying
 *    symbol is the first non-wild it meets, because a wild standing in for
 *    a high symbol should pay that high symbol. A wild-only line falls back
 *    to the wild's own paytable, if it has one.
 * 2. **The run must start at reel 0.** Left-to-right is the convention
 *    these definitions assume; a matching run starting mid-grid pays
 *    nothing.
 */
function matchLine(matrix: Matrix, gameDef: GameDefinition, path: (number | null)[]): LineMatch | null {
  const cells: Array<{ reel: number; row: number; symbol: string }> = [];
  for (let reel = 0; reel < path.length && reel < matrix.length; reel++) {
    const row = path[reel];
    // A `null` entry means this reel is deliberately not part of the line's
    // pattern; the run ends here rather than skipping the reel, so a line's
    // length stays contiguous from reel 0.
    if (row === null) break;
    const symbol = matrix[reel]?.[row];
    if (symbol === undefined) break;
    cells.push({ reel, row, symbol });
  }
  if (cells.length === 0) return null;

  const anchorSymbol = cells.find((cell) => !isWild(gameDef, cell.symbol))?.symbol ?? cells[0].symbol;

  // A scatter pays on count anywhere, never as a line run — letting it
  // match here would pay it twice.
  if (symbolRule(gameDef, anchorSymbol)?.role === "scatter") return null;

  const positions: Array<{ reel: number; row: number }> = [];
  let wildMultiplier = 1;

  for (const cell of cells) {
    const matches = cell.symbol === anchorSymbol || wildSubstitutes(gameDef, cell.symbol, anchorSymbol);
    if (!matches) break;
    positions.push({ reel: cell.reel, row: cell.row });
    if (isWild(gameDef, cell.symbol)) {
      wildMultiplier *= symbolRule(gameDef, cell.symbol)?.wildConfig?.multiplier ?? 1;
    }
  }

  return positions.length === 0 ? null : { anchorSymbol, matchedCount: positions.length, positions, wildMultiplier };
}

/**
 * Evaluates every configured payline against the final grid.
 *
 * Each line is independently staked: `totalBet` is split across the lines
 * with `splitIntegerEvenly`, so the per-line stakes sum to exactly the
 * total with no minor unit created or lost to floating-point division. A
 * line's payout is its stake times the paytable multiplier for the matched
 * count, times any participating wild multipliers — then floored, because
 * a payout must be a whole minor unit and rounding up would pay money the
 * paytable never promised.
 */
export function evaluatePaylines(matrix: Matrix, gameDef: GameDefinition, totalBet: number): PaylineResult {
  if (gameDef.paylines.length === 0) return { winLines: [], lineWinTotal: 0 };

  const stakes = splitIntegerEvenly(totalBet, gameDef.paylines.length);
  const winLines: WinLine[] = [];

  for (let line = 0; line < gameDef.paylines.length; line++) {
    const match = matchLine(matrix, gameDef, gameDef.paylines[line]);
    if (!match) continue;

    const multiplier = symbolRule(gameDef, match.anchorSymbol)?.paytable?.[match.matchedCount];
    if (multiplier === undefined || multiplier <= 0) continue;

    const amount = Math.floor(stakes[line] * multiplier * match.wildMultiplier);
    if (amount <= 0) continue;

    winLines.push({
      line,
      symbol: match.anchorSymbol,
      count: match.matchedCount,
      amount,
      positions: match.positions,
    });
  }

  const rule = gameDef.paylineWinRule ?? DEFAULT_PAYLINE_WIN_RULE;
  if (rule === "highestOnly" && winLines.length > 1) {
    // Keep only the single best line. Reported as one win line rather than
    // all lines with zeroed amounts, so a client renders exactly what paid.
    const best = winLines.reduce((a, b) => (b.amount > a.amount ? b : a));
    return { winLines: [best], lineWinTotal: best.amount };
  }

  return { winLines, lineWinTotal: winLines.reduce((sum, w) => sum + w.amount, 0) };
}
