/**
 * Regularized incomplete gamma function, needed to turn a chi-squared
 * statistic into a real p-value. Implemented here rather than pulled from a
 * dependency because a certification reviewer will read this file: the
 * series/continued-fraction split below is the standard Numerical Recipes
 * treatment, and it is short enough to check by hand.
 */

const MAX_ITERATIONS = 300;
const EPSILON = 1e-14;
/** Near the smallest normalized double — guards the continued fraction
 * against a zero denominator without perturbing any real result. */
const TINY = 1e-300;

/** Natural log of the gamma function (Lanczos approximation, g=7, n=9). */
export function logGamma(x: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula — the approximation above is only valid for x >= 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = coefficients[0];
  const t = z + 7.5;
  for (let i = 1; i < coefficients.length; i++) {
    a += coefficients[i] / (z + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Lower regularized incomplete gamma P(s, x), via its series expansion.
 * Converges quickly for x < s + 1. */
function lowerSeries(s: number, x: number): number {
  let sum = 1 / s;
  let term = sum;
  for (let n = 1; n < MAX_ITERATIONS; n++) {
    term *= x / (s + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

/** Upper regularized incomplete gamma Q(s, x), via the modified Lentz
 * continued fraction. Converges quickly for x >= s + 1, where the series
 * above does not. */
function upperContinuedFraction(s: number, x: number): number {
  let b = x + 1 - s;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITERATIONS; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
}

function assertDomain(s: number, x: number, name: string): void {
  if (x < 0 || s <= 0) throw new Error(`${name} requires s > 0 and x >= 0, got s=${s} x=${x}`);
}

/**
 * Upper regularized incomplete gamma Q(s, x) = Γ(s,x)/Γ(s). This is the
 * chi-squared survival function once s = df/2 and x = statistic/2, and it
 * is the p-value the certification report publishes.
 *
 * **This is the primitive, and `lowerRegularizedGamma` is defined in terms
 * of it — not the reverse.** The direction matters and used to be the other
 * way round, which cost the report every p-value below ~1e-16 (TODO item J).
 * When the continued fraction is the accurate method, returning it directly
 * preserves that accuracy; reaching it as `1 - (1 - Q)` does not. Doubles
 * are spaced ~2.2e-16 apart just below 1, so any Q smaller than that
 * collapses to exactly 0 the moment it is subtracted from 1 — the true value
 * is computed correctly and then thrown away by the arithmetic that reports
 * it. Measured before the change: df=10 at χ²=400 returned 0 where the true
 * probability is 9.4e-80.
 *
 * No verdict was ever wrong (`passed` is a band around 0.005, and 0 fails it
 * exactly as 1e-17 does), but a report whose whole purpose is to be checked
 * by an outside reviewer must not print a computed 0 that no continuous
 * distribution can actually produce.
 */
export function upperRegularizedGamma(s: number, x: number): number {
  assertDomain(s, x, "upperRegularizedGamma");
  if (x === 0) return 1;
  // Each method is used only where it converges: the series below s + 1,
  // the continued fraction at or above it. Only the series branch needs a
  // subtraction, and there Q is near 1, where the spacing of doubles is
  // ~1e-16 relative — harmless.
  return x < s + 1 ? 1 - lowerSeries(s, x) : upperContinuedFraction(s, x);
}

/**
 * Lower regularized incomplete gamma P(s, x) = γ(s,x)/Γ(s).
 *
 * The complement of the above, and it carries the loss of precision that
 * `upperRegularizedGamma` used to: for a very small Q, P is 1 to within
 * rounding and cannot express the difference. That is inherent to the
 * quantity rather than to this arrangement — a cumulative probability
 * indistinguishable from 1 *is* 1 in double precision — and it is the
 * harmless direction, because nothing here reports a p-value through P.
 */
export function lowerRegularizedGamma(s: number, x: number): number {
  assertDomain(s, x, "lowerRegularizedGamma");
  if (x === 0) return 0;
  return x < s + 1 ? lowerSeries(s, x) : 1 - upperContinuedFraction(s, x);
}
