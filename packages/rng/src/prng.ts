/**
 * Deterministic draw sequence derived from a stored seed. The seed itself
 * comes from OS entropy (see seed.ts); this layer is intentionally
 * deterministic and documented so:
 *   1. A round's outcome can be replayed byte-for-byte from its seed for
 *      audit or dispute resolution.
 *   2. The exact algorithm can be handed to a certification lab alongside a
 *      statistical test report, rather than relying on an opaque platform
 *      RNG nobody can inspect.
 *
 * Unpredictable *before* the spin, reproducible *after* — those aren't in
 * tension, and together they are the whole basis of provable fairness.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
}

/**
 * Which algorithm a given seed's draw sequence was generated with. Recorded
 * on every round so that replaying a historical round stays exact even
 * after the platform default changes — a real regulatory requirement, and
 * far cheaper to carry from the start than to retrofit once rounds exist.
 */
/**
 * The `-d16` suffix is not decoration: the 16-draw warm-up in
 * `xoshiro256ss` below is part of this algorithm's identity, because a
 * sequence generated with it differs from one generated without it. Any
 * future change to the seeding, the scrambler, or the discard count must
 * take a NEW id and keep the old one readable, or previously stored rounds
 * stop replaying to their recorded outcome.
 */
export type RngAlgorithmId = "xoshiro256ss-d16";
export const DEFAULT_RNG_ALGORITHM: RngAlgorithmId = "xoshiro256ss-d16";

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

/**
 * splitmix64's mixing/finalizer step (no counter increment) — whitens a raw
 * 64-bit input into a well-distributed 64-bit output. Used to derive each of
 * xoshiro256**'s 4 state words independently from a slice of the real
 * 256-bit seed, so all of the seed's entropy is preserved in the
 * generator's live state and never collapsed to 64 bits then re-inflated.
 */
function splitmix64Mix(input: bigint): bigint {
  let z = input & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/**
 * xoshiro256** (Blackman & Vigna) — a well-studied, wide-state (256-bit)
 * PRNG. `seedBytes` must be exactly 32 bytes (the full output of
 * `generateSeed()`); each 8-byte slice becomes one state word after
 * whitening. A narrower internal state than the seed would overstate the
 * real outcome space to a certification reviewer, so the full 256 bits are
 * carried deliberately.
 */
function xoshiro256ss(seedBytes: Buffer): () => number {
  const s: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
  for (let i = 0; i < 4; i++) {
    let word = 0n;
    for (let b = 0; b < 8; b++) {
      word = (word << 8n) | BigInt(seedBytes[i * 8 + b]);
    }
    s[i] = splitmix64Mix(word);
  }
  // xoshiro256 requires a non-all-zero state; astronomically unlikely with
  // a real crypto seed, but guarded explicitly rather than assumed.
  if (s[0] === 0n && s[1] === 0n && s[2] === 0n && s[3] === 0n) s[0] = 1n;

  const next = function next(): number {
    const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;

    const t = (s[1] << 17n) & MASK64;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];

    s[2] ^= t;
    s[3] = rotl(s[3], 45n);

    // Top 53 bits of the 64-bit output become the float's mantissa — the
    // convention xoshiro's own authors suggest for [0,1) extraction, and
    // exactly IEEE754 double precision (2^53).
    return Number(result >> 11n) / 9007199254740992;
  };

  // Discard an initial block before handing the sequence to a caller.
  // xoshiro's scrambler derives each output from `s[1]` alone, so the first
  // few outputs reflect only part of the seed: two seeds differing solely in
  // their final bytes both emit 0 for the first two draws, which would make
  // near-identical seeds produce identical opening reel stops. Sixteen
  // rounds is well past the point every state word has propagated into
  // every other. This costs ~16 iterations per round — irrelevant next to a
  // Mongo transaction, and it runs before any outcome depends on it.
  for (let i = 0; i < 16; i++) next();

  return next;
}

/**
 * Build a deterministic RNG from a stored round seed (hex from
 * `generateSeed()`). Same seed + same algorithm always yields the same draw
 * sequence. Pass the algorithm stored on a historical `Round` to replay it
 * exactly as it actually happened.
 */
export function createRng(seed: string, algorithm: RngAlgorithmId = DEFAULT_RNG_ALGORITHM): Rng {
  const seedBytes = Buffer.from(seed, "hex");
  if (seedBytes.length !== 32) {
    throw new Error(`createRng: ${algorithm} requires a 32-byte (64 hex char) seed, got ${seedBytes.length} bytes`);
  }
  return { next: xoshiro256ss(seedBytes) };
}

/** Random integer in [0, maxExclusive). */
export function rollInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng.next() * maxExclusive);
}

/** Random float in [min, max). */
export function rollFloat(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}
