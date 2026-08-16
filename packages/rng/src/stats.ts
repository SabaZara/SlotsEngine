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

/**
 * Wald–Wolfowitz runs test: count how many times the sequence crosses its
 * own median, and compare that to how many crossings a random sequence of
 * the same composition would make.
 *
 * **What it adds that the three tests above do not.** They are all
 * *distributional* — they ask whether values, integers or consecutive pairs
 * land where they should. This one asks about **order**, over the whole
 * stream rather than at lag 1. A sequence can have a perfect histogram and
 * a clean pair grid while still being sorted into long blocks, and runs is
 * the standard test that names that failure.
 *
 * Honest scope, measured rather than assumed: three streams built
 * specifically to evade the existing suite (a sorted sweep, a block-ordered
 * stream, and strict alternation) were all caught by `serialCorrelation`
 * anyway — its 16×16 contingency grid detects *any* structure in
 * consecutive pairs, not merely linear correlation, which makes it stronger
 * than the scalar lag-1 coefficient this test is usually paired with. So
 * this is added for **certification completeness** — a reviewer expects a
 * runs test by name, and its absence invites a question the other three
 * cannot answer — not because a detection hole was demonstrated. That
 * distinction is recorded in docs/TODO.md rather than overstated here.
 *
 * The statistic is reported as z², which is chi-squared with one degree of
 * freedom, so this returns the same `TestResult` shape as its siblings and
 * inherits the two-sided band. That is deliberate: a runs count far *below*
 * expectation means blocking, and far *above* means alternation, and both
 * are defects. A one-sided pass — what the reference uses — would wave one
 * of them through.
 */
export function runsAboveBelowMedian(seed: string, draws: number, algorithm?: RngAlgorithmId): TestResult {
  const rng = createRng(seed, algorithm);

  // Split at 0.5 rather than at the sample median. For a generator claiming
  // uniformity on [0,1) the theoretical median IS 0.5, and using the sample
  // median would make the test partly self-referential: a generator that
  // emitted only values in [0.9, 0.91) would split its own output evenly and
  // score a perfect runs count on a stream with no spread at all. The
  // frequency test owns "are the values in the right place"; this one owns
  // "are they in a plausible order", and it should not quietly re-check the
  // former with a weaker instrument.
  let above = 0;
  let runs = 1;
  let previous = rng.next() >= 0.5;
  if (previous) above++;

  for (let i = 1; i < draws; i++) {
    const isAbove = rng.next() >= 0.5;
    if (isAbove !== previous) runs++;
    if (isAbove) above++;
    previous = isAbove;
  }

  const below = draws - above;

  // Degenerate composition: every draw fell on one side, so there is exactly
  // one run and the variance below is zero. This is a catastrophic failure,
  // not a pass — but it must not be reported by dividing by zero. The
  // frequency test will also fail on such a stream; this states it here too
  // rather than returning NaN and letting the band decide by accident.
  if (above === 0 || below === 0) {
    return {
      name: `runs about the median (${draws} draws)`,
      statistic: Number.POSITIVE_INFINITY,
      degreesOfFreedom: 1,
      pValue: 0,
      passed: false,
    };
  }

  const expectedRuns = (2 * above * below) / draws + 1;
  const variance = (2 * above * below * (2 * above * below - draws)) / (draws * draws * (draws - 1));
  const zScore = (runs - expectedRuns) / Math.sqrt(variance);

  // z² is exactly chi-squared with df=1, so the existing p-value path
  // applies unchanged — no second numerical method to keep correct, and the
  // tail precision won by F22/item J comes along for free.
  //
  // The *statistic* is what carries a catastrophic verdict, not the p-value:
  // a genuinely broken generator reaches |z| ≈ 447 here, and exp(-z²/2)
  // underflows the double range past |z| ≈ 38. That floor is IEEE's, not
  // the arrangement defect item J fixed, and `passed` is decided by the band
  // rather than by the printed zero either way.
  return evaluate(`runs about the median (${draws} draws)`, zScore * zScore, 1);
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
    runsAboveBelowMedian(seed, draws, algorithm),
  ];
  return {
    seed,
    algorithm: algorithm ?? DEFAULT_RNG_ALGORITHM,
    generatedAt: new Date().toISOString(),
    results,
    passed: aggregatePassed(results),
  };
}
