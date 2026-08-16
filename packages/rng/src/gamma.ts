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

/** Lower regularized incomplete gamma P(s, x) = γ(s,x)/Γ(s). */
export function lowerRegularizedGamma(s: number, x: number): number {
  if (x < 0 || s <= 0) throw new Error(`lowerRegularizedGamma requires s > 0 and x >= 0, got s=${s} x=${x}`);
  if (x === 0) return 0;
  return x < s + 1 ? lowerSeries(s, x) : 1 - upperContinuedFraction(s, x);
}

/** Upper regularized incomplete gamma Q(s, x) = 1 - P(s, x). This is the
 * chi-squared survival function once s = df/2 and x = statistic/2. */
export function upperRegularizedGamma(s: number, x: number): number {
  return 1 - lowerRegularizedGamma(s, x);
}
