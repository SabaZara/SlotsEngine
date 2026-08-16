import { upperRegularizedGamma } from "./gamma.js";
import { createRng, DEFAULT_RNG_ALGORITHM, rollInt, type RngAlgorithmId } from "./prng.js";
import { generateSeed } from "./seed.js";

/**
 * Statistical test suite for the draw sequence in prng.ts. The point is not
 * to prove the generator is good — xoshiro256** is already well studied —
 * but to produce a report a certification lab can reproduce against *this*
 * implementation, catching an integration mistake (a folded seed, a biased
 * range reduction) that a literature citation alone would never reveal.
 *
 * A p-value here is the probability of seeing a deviation at least this
 * large from a genuinely uniform source. A *low* p-value is the suspicious
 * one; a very high one is not "extra random" either, which is why
 * `passed` checks a two-sided band rather than a floor.
 */

export interface TestResult {
  name: string;
  statistic: number;
  degreesOfFreedom: number;
  pValue: number;
  passed: boolean;
}

/** Two-sided significance band. A uniform source falls outside this ~1% of
 * the time by chance alone, so a single failure is a prompt to re-run with
 * a fresh seed, not proof of a defect. */
const ALPHA = 0.005;

function chiSquaredPValue(statistic: number, degreesOfFreedom: number): number {
  return upperRegularizedGamma(degreesOfFreedom / 2, statistic / 2);
}

/**
 * Applies the two-sided significance band to a statistic.
 *
 * Exported for testing, deliberately. Every input reachable through the
 * three public tests *passes* — `createRng` offers one algorithm, so a
 * broken generator cannot be injected, and chi-squared is robust enough
 * that no draw or bin count yields a genuine failure. With no failing
 * input, a band that always returned `true` would be indistinguishable
 * from a correct one, which is precisely the defect that would make this
 * whole report worthless as evidence.
 *
 * The alternative — leaving it private and untested — costs more than the
 * one line of exposed surface.
 */
export function evaluate(name: string, statistic: number, degreesOfFreedom: number): TestResult {
  const pValue = chiSquaredPValue(statistic, degreesOfFreedom);
  return { name, statistic, degreesOfFreedom, pValue, passed: pValue > ALPHA && pValue < 1 - ALPHA };
}

/**
 * Frequency test: bucket `draws` floats into `bins` equal intervals and
 * check the counts against a uniform expectation. Detects a generator whose
 * output clusters in part of the range.
 */
export function chiSquaredUniformity(seed: string, draws: number, bins = 100, algorithm?: RngAlgorithmId): TestResult {
  const rng = createRng(seed, algorithm);
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < draws; i++) {
    const bin = Math.min(bins - 1, Math.floor(rng.next() * bins));
    counts[bin]++;
  }
  const expected = draws / bins;
  const statistic = counts.reduce((acc, observed) => acc + (observed - expected) ** 2 / expected, 0);
  return evaluate(`chi-squared uniformity (${draws} draws, ${bins} bins)`, statistic, bins - 1);
}

/**
 * Uniformity of `rollInt` specifically, not just the underlying float. This
 * is the function that actually picks reel stops, and a range-reduction bug
 * (modulo bias, an off-by-one at the top of the range) would show up here
 * and nowhere else — the float test above would still pass cleanly.
 */
export function rollIntUniformity(seed: string, draws: number, maxExclusive: number, algorithm?: RngAlgorithmId): TestResult {
  const rng = createRng(seed, algorithm);
  const counts = new Array<number>(maxExclusive).fill(0);
  for (let i = 0; i < draws; i++) {
    counts[rollInt(rng, maxExclusive)]++;
  }
  const expected = draws / maxExclusive;
  const statistic = counts.reduce((acc, observed) => acc + (observed - expected) ** 2 / expected, 0);
  return evaluate(`rollInt uniformity (${draws} draws, range ${maxExclusive})`, statistic, maxExclusive - 1);
}

/**
 * Serial correlation test: bucket consecutive *pairs* of draws into a
 * `bins × bins` grid. A generator can be perfectly uniform in isolation
 * while still leaking its next value from its previous one — that shows up
 * as structure here and is invisible to a frequency test.
 */
export function serialCorrelation(seed: string, draws: number, bins = 16, algorithm?: RngAlgorithmId): TestResult {
  const rng = createRng(seed, algorithm);
  const counts = new Array<number>(bins * bins).fill(0);
  const pairs = Math.floor(draws / 2);
  for (let i = 0; i < pairs; i++) {
    const a = Math.min(bins - 1, Math.floor(rng.next() * bins));
    const b = Math.min(bins - 1, Math.floor(rng.next() * bins));
    counts[a * bins + b]++;
  }
  const expected = pairs / (bins * bins);
  const statistic = counts.reduce((acc, observed) => acc + (observed - expected) ** 2 / expected, 0);
  return evaluate(`serial correlation (${pairs} pairs, ${bins}x${bins} grid)`, statistic, bins * bins - 1);
}

export interface RngReport {
  seed: string;
  algorithm: RngAlgorithmId;
  generatedAt: string;
  results: TestResult[];
  passed: boolean;
}

/**
 * The report's verdict: the suite passes only if EVERY sub-test passed.
 *
 * Extracted as a pure function on purpose. Inline, this conjunction could
 * not be tested — all three sub-tests pass on a healthy generator, so
 * `every`, `some` and a hardcoded `true` agree on every input reachable
 * through `runRngTestSuite`, and injecting a generator that fails exactly
 * one turns out to be impractical: the three tests share a seed and a draw
 * stream, so a distortion large enough to fail one fails all of them
 * (measured across five deliberately-broken generators, not assumed).
 *
 * As a function taking constructed results it is checkable directly, which
 * is what makes "a report claiming success while a sub-test failed" — the
 * most misleading thing this artefact could produce — something a test can
 * catch. This is the second of the two fixes docs/TODO.md item 3d proposed.
 */
export function aggregatePassed(results: TestResult[]): boolean {
  return results.every((r) => r.passed);
}

/**
 * Runs the full suite against one fresh seed and returns a reproducible
 * report — the seed is included precisely so a reviewer can re-run it and
 * get identical numbers.
 */
export function runRngTestSuite(draws = 1_000_000, seed: string = generateSeed(), algorithm?: RngAlgorithmId): RngReport {
  const results = [
    chiSquaredUniformity(seed, draws, 100, algorithm),
    rollIntUniformity(seed, draws, 64, algorithm),
    serialCorrelation(seed, draws, 16, algorithm),
  ];
  return {
    seed,
    algorithm: algorithm ?? DEFAULT_RNG_ALGORITHM,
    generatedAt: new Date().toISOString(),
    results,
    passed: aggregatePassed(results),
  };
}
