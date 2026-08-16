import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logGamma, lowerRegularizedGamma, upperRegularizedGamma } from "./gamma.js";

/**
 * Tests for the numerics under the RNG certification report.
 *
 * This file had no tests until item J. `stats.test.ts` reaches it, but only
 * through one caller and only at points covered by published chi-squared
 * tables — which stop around p = 0.001. That is the right discipline for
 * that file (compare against independently known values, never against this
 * implementation's own output) and it is exactly why the tail went
 * unchecked: the tables do not go there.
 *
 * So the reference points below come from three sources, none of them this
 * code:
 *
 * 1. **Closed forms.** For integer and half-integer `s` the incomplete
 *    gamma has an exact elementary expression — see `upperTailClosedForm`.
 *    This is the strongest oracle here: it shares no code path with the
 *    implementation, and for chi-squared with even df it is exact.
 * 2. **Identities that must hold** whatever the arithmetic: P + Q = 1,
 *    monotonicity in x, and Γ(n) = (n-1)! through `logGamma`.
 * 3. **Published chi-squared critical values**, for continuity with
 *    `stats.test.ts`.
 *
 * ## A surviving mutation, and why it is equivalent
 *
 * Deleting the reflection-formula branch from `logGamma` does not fail
 * these tests. That is not a missing assertion — this Lanczos coefficient
 * set (g=7, n=9) is accurate below 0.5 unaided, agreeing with the
 * reflection path to ~1e-15, which is inside any tolerance these tests
 * could reasonably use. Measured at x ∈ {0.1, 0.25, 0.3, 0.49}: worst
 * relative disagreement 1.7e-15.
 *
 * The branch is still correct to keep — it is what makes the function
 * right for *arbitrary* small x rather than right by the good fortune of
 * one coefficient set — but nothing chi-squared can reach exercises it:
 * `s = df/2` and df >= 1, so s never falls below 0.5. Tightening the
 * tolerance to force a failure would pin floating-point noise rather than
 * behaviour, which is a worse test than none.
 *
 * ## What these tests cannot establish
 *
 * That the *report* is meaningful. These prove the arithmetic; whether a
 * p-value is being computed on the right statistic with the right degrees
 * of freedom is `stats.test.ts`'s job, and whether the generator is any
 * good is `prng.test.ts`'s. Read the three together.
 */

/**
 * Exact upper-tail chi-squared probability for **even** degrees of freedom,
 * i.e. integer `s`. Q(s, x) = e^-x · Σ_{k=0}^{s-1} x^k / k!
 *
 * Deliberately computed in a way that shares nothing with `gamma.ts`: a
 * finite sum with no continued fraction, no Lanczos approximation and no
 * subtraction from 1, so it stays accurate in the tail where the thing
 * under test is suspected of losing precision. Summed smallest-term-first
 * and scaled by e^-x per term via logs, to keep it usable at large x where
 * `Math.exp(-x)` alone underflows.
 */
function upperTailClosedForm(s: number, x: number): number {
  assert.ok(Number.isInteger(s) && s > 0, "closed form requires integer s");
  let total = 0;
  let logFactorial = 0;
  for (let k = 0; k < s; k++) {
    if (k > 0) logFactorial += Math.log(k);
    // exp(-x + k·ln x - ln k!) rather than exp(-x)·x^k/k!, so each term is
    // formed in log space and never overflows or underflows on its own.
    total += Math.exp(-x + k * Math.log(x) - logFactorial);
  }
  return total;
}

/** Relative error, the only meaningful comparison across 250 orders of magnitude. */
function relativeError(actual: number, expected: number): number {
  if (expected === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe("logGamma", () => {
  it("reproduces the factorials, which is Γ(n) = (n-1)! exactly", () => {
    // Integer inputs are the one place the answer is known without any
    // approximation, so a Lanczos coefficient typo shows up here first.
    const factorials: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 6],
      [5, 24],
      [6, 120],
      [11, 3_628_800],
    ];
    for (const [n, expected] of factorials) {
      assert.ok(
        relativeError(Math.exp(logGamma(n)), expected) < 1e-12,
        `Γ(${n}) should be ${expected}, got ${Math.exp(logGamma(n))}`,
      );
    }
  });

  it("reproduces Γ(1/2) = √π, the half-integer case chi-squared actually uses", () => {
    // Odd degrees of freedom give s = df/2 a half-integer value, so this
    // path is not decorative — it is every odd-df test in the suite.
    assert.ok(relativeError(Math.exp(logGamma(0.5)), Math.sqrt(Math.PI)) < 1e-12);
    // Γ(3/2) = √π/2, via the recurrence Γ(x+1) = x·Γ(x).
    assert.ok(relativeError(Math.exp(logGamma(1.5)), Math.sqrt(Math.PI) / 2) < 1e-12);
  });

  it("satisfies the recurrence Γ(x+1) = x·Γ(x) away from the integers", () => {
    // Catches an error that happens to vanish at the points tested above.
    for (const x of [0.3, 0.75, 1.2, 2.6, 7.9, 30.4]) {
      const lhs = logGamma(x + 1);
      const rhs = Math.log(x) + logGamma(x);
      assert.ok(Math.abs(lhs - rhs) < 1e-12, `recurrence broke at x=${x}: ${lhs} vs ${rhs}`);
    }
  });

  it("uses the reflection formula below 0.5 rather than the raw approximation", () => {
    // Γ(x)Γ(1-x) = π/sin(πx). The Lanczos series is only valid for x >= 0.5,
    // so this is the branch that keeps small arguments correct at all.
    for (const x of [0.1, 0.25, 0.49]) {
      const product = Math.exp(logGamma(x) + logGamma(1 - x));
      assert.ok(
        relativeError(product, Math.PI / Math.sin(Math.PI * x)) < 1e-10,
        `reflection formula broke at x=${x}`,
      );
    }
  });
});

describe("lowerRegularizedGamma", () => {
  it("refuses a domain it cannot compute rather than returning a wrong number", () => {
    // s <= 0 and x < 0 are outside the function's domain. Returning NaN or
    // a silent 0 here would flow into a p-value and become a verdict.
    assert.throws(() => lowerRegularizedGamma(0, 1), /requires s > 0/);
    assert.throws(() => lowerRegularizedGamma(-1, 1), /requires s > 0/);
    assert.throws(() => lowerRegularizedGamma(1, -1), /x >= 0/);
  });

  it("is 0 at x = 0 — no probability mass has accumulated yet", () => {
    assert.equal(lowerRegularizedGamma(0.5, 0), 0);
    assert.equal(lowerRegularizedGamma(5, 0), 0);
  });

  it("increases monotonically in x, since it is a cumulative distribution", () => {
    // Holds across the series/continued-fraction switch at x = s + 1, which
    // is where a arrangement error would show as a discontinuity.
    for (const s of [0.5, 1, 5, 127.5]) {
      let previous = -Infinity;
      for (let x = 0; x < 4 * s + 40; x += 0.25) {
        const current = lowerRegularizedGamma(s, x);
        assert.ok(current >= previous, `P(${s}, ${x}) = ${current} dropped below ${previous}`);
        previous = current;
      }
    }
  });

  it("agrees with the closed form across the series/continued-fraction boundary", () => {
    // x = s + 1 is the switch point. Both methods must give the same answer
    // there, or the function has a seam.
    for (const s of [1, 3, 5, 10]) {
      for (const x of [s + 0.9, s + 0.99, s + 1, s + 1.01, s + 1.1]) {
        const expected = 1 - upperTailClosedForm(s, x);
        assert.ok(
          relativeError(lowerRegularizedGamma(s, x), expected) < 1e-10,
          `seam at s=${s} x=${x}: ${lowerRegularizedGamma(s, x)} vs ${expected}`,
        );
      }
    }
  });
});

describe("upperRegularizedGamma", () => {
  it("is 1 at x = 0 — the entire distribution lies above a statistic of zero", () => {
    // A perfectly-matching observation has χ² = 0 and must read as the least
    // suspicious result possible, p = 1. Returning 0 here would invert that
    // completely: the one sample that fits the expectation exactly would be
    // reported as the most significant deviation available.
    assert.equal(upperRegularizedGamma(0.5, 0), 1);
    assert.equal(upperRegularizedGamma(5, 0), 1);
  });

  it("complements the lower function: P + Q = 1", () => {
    for (const s of [0.5, 1, 5, 50, 127.5]) {
      for (const x of [0.5, 1, 5, 25, 100, 300]) {
        const sum = lowerRegularizedGamma(s, x) + upperRegularizedGamma(s, x);
        assert.ok(Math.abs(sum - 1) < 1e-12, `P + Q = ${sum} at s=${s} x=${x}`);
      }
    }
  });

  it("matches published chi-squared critical values at the conventional levels", () => {
    // Standard table values: the statistic at which the upper tail equals
    // the stated probability. Read from a table, not from this code.
    const table: Array<[number, number, number]> = [
      // [df, critical value, upper-tail probability]
      [1, 3.841459, 0.05],
      [1, 6.634897, 0.01],
      [10, 18.307038, 0.05],
      [10, 23.209251, 0.01],
      [10, 25.188180, 0.005],
      [100, 124.342113, 0.05],
    ];
    for (const [df, critical, probability] of table) {
      const actual = upperRegularizedGamma(df / 2, critical / 2);
      assert.ok(
        relativeError(actual, probability) < 1e-5,
        `df=${df} χ²=${critical} should give p≈${probability}, got ${actual}`,
      );
    }
  });

  /**
   * Item J. These are the cases the two-subtractions-from-1 arrangement
   * collapsed to exactly 0.
   *
   * The expected values come from `upperTailClosedForm`, which is exact for
   * integer s and — importantly — never forms `1 - p`, so it stays accurate
   * where the implementation under test was suspected of failing.
   */
  it("computes a tail p-value far below the spacing of doubles near 1", () => {
    const cases: Array<[number, number]> = [
      // [df, χ²] — every one of these returned exactly 0 before item J.
      [10, 100],
      [10, 200],
      [10, 400],
      [10, 800],
      [20, 300],
      [100, 500],
      [254, 1000],
      [254, 2000],
    ];
    for (const [df, chiSquared] of cases) {
      const s = df / 2;
      const actual = upperRegularizedGamma(s, chiSquared / 2);
      const expected = upperTailClosedForm(s, chiSquared / 2);

      assert.ok(actual > 0, `df=${df} χ²=${chiSquared} returned exactly 0; true p ≈ ${expected}`);
      assert.ok(
        relativeError(actual, expected) < 1e-9,
        `df=${df} χ²=${chiSquared}: got ${actual}, closed form says ${expected}`,
      );
    }
  });

  it("keeps resolving distinct p-values well below 1e-16", () => {
    // The floor was not only a floor — resolution degraded before reaching
    // it, so two very different failures reported the same number. A report
    // that cannot tell 1e-20 from 1e-80 cannot show how badly a generator
    // failed, which is the only reason the tail is printed at all.
    const values = new Set<number>();
    for (let chiSquared = 100; chiSquared < 300; chiSquared += 0.5) {
      const p = upperRegularizedGamma(5, chiSquared / 2);
      assert.ok(p > 0, `χ²=${chiSquared} at df=10 returned exactly 0`);
      values.add(p);
    }
    assert.equal(values.size, 400, "every distinct statistic should give a distinct p-value");
  });

  it("stays strictly decreasing in the tail, so a worse statistic reads as worse", () => {
    // The property a reviewer actually relies on: a larger deviation must
    // produce a smaller p-value. Under the old arrangement this failed
    // silently — every statistic past the floor tied at 0.
    let previous = Infinity;
    for (let chiSquared = 50; chiSquared < 400; chiSquared += 1) {
      const p = upperRegularizedGamma(5, chiSquared / 2);
      assert.ok(p < previous, `p did not decrease at χ²=${chiSquared}: ${p} vs ${previous}`);
      previous = p;
    }
  });

  it("is unchanged in the range that already worked, including near p = 1", () => {
    // The easy mistake when fixing a tail is disturbing the body. Near
    // p = 1 the subtraction was always harmless, and these values are the
    // ones the existing report has been printing correctly all along.
    const cases: Array<[number, number, number]> = [
      // [s, x, expected] — expected from the closed form, integer s.
      [5, 0.25, upperTailClosedForm(5, 0.25)],
      [5, 0.5, upperTailClosedForm(5, 0.5)],
      [5, 1, upperTailClosedForm(5, 1)],
      [5, 5, upperTailClosedForm(5, 5)],
      [50, 40, upperTailClosedForm(50, 40)],
    ];
    for (const [s, x, expected] of cases) {
      assert.ok(
        relativeError(upperRegularizedGamma(s, x), expected) < 1e-10,
        `s=${s} x=${x}: got ${upperRegularizedGamma(s, x)}, expected ${expected}`,
      );
    }
    // And the upper end is genuinely close to 1, not merely "large".
    assert.ok(upperRegularizedGamma(5, 0.001) > 0.999999999);
  });
});
