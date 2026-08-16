import type { GameDefinition } from "@slots-engine/shared-types";
import { rollInt, type Rng } from "@slots-engine/rng";

/** Column-major: `matrix[reel][row]`. Reels are the outer array because
 * every mechanic that operates on a whole reel (expanding wilds, per-reel
 * stops, reel-restricted symbols) becomes an index rather than a scan. */
export type Matrix = string[][];

export interface BuiltMatrix {
  /** The stop index chosen on each reel — persisted alongside the seed so a
   * replay can be checked at this intermediate stage, not only end to end. */
  stops: number[];
  matrix: Matrix;
}

/**
 * Turns a seeded RNG into the visible grid, by whichever generation mode
 * the game defines. Pure: same rng sequence + same definition always yields
 * the same grid, which is what makes a stored seed sufficient for replay.
 */
export function buildMatrix(gameDef: GameDefinition, rng: Rng): BuiltMatrix {
  return gameDef.reelGenerationMode === "weighted-symbol"
    ? buildFromWeights(gameDef, rng)
    : buildFromStrips(gameDef, rng);
}

/**
 * Reel-strip mode: pick one stop per reel and read `rows` consecutive
 * symbols from there, wrapping at the end of the strip. This is the
 * traditional physical-reel model — a symbol's frequency is how many times
 * it appears on the strip, so the strip itself is the game's math.
 */
function buildFromStrips(gameDef: GameDefinition, rng: Rng): BuiltMatrix {
  const { reels, rows } = gameDef.grid;
  const strips = gameDef.reelStrips;
  if (!strips || strips.length === 0) {
    throw new Error(`game '${gameDef.gameId}' uses reel-strip mode but defines no reelStrips`);
  }

  const stops: number[] = [];
  const matrix: Matrix = [];

  for (let reel = 0; reel < reels; reel++) {
    const strip = strips.find((s) => s.reelIndex === reel);
    if (!strip || strip.symbols.length === 0) {
      throw new Error(`game '${gameDef.gameId}' has no reel strip for reel ${reel}`);
    }
    const stop = rollInt(rng, strip.symbols.length);
    stops.push(stop);
    matrix.push(
      Array.from({ length: rows }, (_, row) => strip.symbols[(stop + row) % strip.symbols.length]),
    );
  }

  return { stops, matrix };
}

/**
 * Weighted-symbol mode: draw each visible cell independently from that
 * reel's weighted pool. Unlike strip mode there is no positional structure
 * — adjacent cells are independent — which makes a target RTP easier to
 * tune but removes the near-miss patterns a hand-built strip can encode.
 *
 * `stops` is recorded as the running draw index purely so the shape of a
 * replay record matches strip mode; it carries no reel-position meaning
 * here.
 */
function buildFromWeights(gameDef: GameDefinition, rng: Rng): BuiltMatrix {
  const { reels, rows } = gameDef.grid;
  const pools = gameDef.symbolWeights;
  if (!pools || pools.length === 0) {
    throw new Error(`game '${gameDef.gameId}' uses weighted-symbol mode but defines no symbolWeights`);
  }

  const stops: number[] = [];
  const matrix: Matrix = [];
  let draw = 0;

  for (let reel = 0; reel < reels; reel++) {
    const pool = pools[reel];
    if (!pool || pool.length === 0) {
      throw new Error(`game '${gameDef.gameId}' has no symbol weights for reel ${reel}`);
    }
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      throw new Error(`game '${gameDef.gameId}' reel ${reel} has non-positive total symbol weight`);
    }

    const column: string[] = [];
    for (let row = 0; row < rows; row++) {
      // Scale a [0,1) draw across the total weight, then walk the pool
      // subtracting as we go — an inverse-CDF pick that stays exact for
      // integer or fractional weights alike.
      let ticket = rng.next() * totalWeight;
      let chosen = pool[pool.length - 1].symbol;
      for (const entry of pool) {
        ticket -= entry.weight;
        if (ticket < 0) {
          chosen = entry.symbol;
          break;
        }
      }
      column.push(chosen);
      stops.push(draw++);
    }
    matrix.push(column);
  }

  return { stops, matrix };
}
