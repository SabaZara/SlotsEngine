import type { GameDefinition, SymbolRule } from "@slots-engine/shared-types";
import type { Matrix } from "./matrix.js";

export function symbolRule(gameDef: GameDefinition, symbol: string): SymbolRule | undefined {
  return gameDef.symbols.find((s) => s.symbol === symbol);
}

export function isWild(gameDef: GameDefinition, symbol: string): boolean {
  return symbolRule(gameDef, symbol)?.role === "wild";
}

/**
 * Whether `wildSymbol` may stand in for `targetSymbol`.
 *
 * A wild never substitutes a scatter or bonus trigger unless that symbol's
 * id is explicitly listed — this is the default posture of real games, and
 * getting it wrong silently inflates RTP by paying scatter lines that
 * shouldn't exist.
 */
export function wildSubstitutes(gameDef: GameDefinition, wildSymbol: string, targetSymbol: string): boolean {
  const rule = symbolRule(gameDef, wildSymbol);
  if (rule?.role !== "wild" || !rule.wildConfig) return false;
  if (wildSymbol === targetSymbol) return true;

  const { substitutesFor } = rule.wildConfig;
  if (Array.isArray(substitutesFor)) return substitutesFor.includes(targetSymbol);
  return symbolRule(gameDef, targetSymbol)?.role === "regular";
}

export interface ExpandResult {
  matrix: Matrix;
  /** Reels filled by an expanding wild this spin. Empty, not absent, when
   * none expanded — a client uses this to play a distinct reveal. */
  expandedReels: number[];
}

/**
 * Fills a whole reel with the wild symbol when an `expanding` wild lands
 * anywhere on it. Applied BEFORE payline evaluation, so downstream
 * evaluation needs no special case: it just sees a reel of wilds.
 *
 * Returns a copy rather than mutating, so the caller can persist both the
 * raw and final grids — an auditor comparing them can see exactly what the
 * expansion changed.
 */
export function applyExpandingWild(matrix: Matrix, gameDef: GameDefinition): ExpandResult {
  const result: Matrix = matrix.map((column) => [...column]);
  const expandedReels: number[] = [];

  for (let reel = 0; reel < result.length; reel++) {
    const expanding = result[reel].find((symbol) => symbolRule(gameDef, symbol)?.wildConfig?.expanding === true);
    if (expanding === undefined) continue;
    result[reel] = result[reel].map(() => expanding);
    expandedReels.push(reel);
  }

  return { matrix: result, expandedReels };
}
