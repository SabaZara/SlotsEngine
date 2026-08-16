/**
 * Every monetary amount on this platform (bet options, totalBet, totalWin,
 * transaction amount/balanceAfter, player balance) is an **integer** count
 * of the currency's smallest unit ("minor units" — cents for USD/EUR, the
 * only unit at all for JPY), never a raw IEEE754 major-unit float. This is
 * the standard real-money-ledger convention and what a certification
 * reviewer expects: floats compound rounding error across many
 * transactions, and a fractional `$inc` corrupts a balance silently.
 *
 * Scope boundary (deliberate): `currency` is denomination/display metadata
 * on `GameDefinition` — it tells the UI how to format a game's integer
 * amounts for a human, and how to convert a designer's major-unit input
 * into minor units for storage. It does NOT partition wallets:
 * `Player.balance` has no currency field, on the assumption that one
 * operator's wallet operates in one consistent currency. True
 * multi-currency wallets are a separate architectural change.
 */

export type CurrencyCode = string;

export const DEFAULT_CURRENCY: CurrencyCode = "USD";

/**
 * Decimal exponent (minor units = 10^exponent per major unit) per ISO 4217
 * code. Covers the currencies most likely to matter for a real-money
 * operator; deliberately not exhaustive — see `minorUnitsFor`'s fallback.
 */
const CURRENCY_MINOR_UNIT_EXPONENT: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, CHF: 2, CNY: 2, INR: 2, BRL: 2, MXN: 2, ZAR: 2, SEK: 2, NOK: 2, PLN: 2, GEL: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

/**
 * Minor units per one major unit of `currency` (100 for USD, 1 for JPY).
 * Falls back to 100 for any unknown code rather than throwing: a typo'd or
 * exotic currency code on a game config shouldn't crash evaluation, and the
 * authoring UI is the real gate on which codes are ever used.
 */
export function minorUnitsFor(currency: CurrencyCode): number {
  const exponent = CURRENCY_MINOR_UNIT_EXPONENT[currency] ?? 2;
  return 10 ** exponent;
}

/**
 * Converts a human-entered major-unit amount (a form's "10.50") into the
 * integer minor-unit amount stored everywhere else (1050 for USD). Only
 * ever used at the edges — internal code never sees a major-unit float.
 */
export function toMinorUnits(majorAmount: number, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return Math.round(majorAmount * minorUnitsFor(currency));
}

/** Inverse of `toMinorUnits` — for display only. */
export function fromMinorUnits(minorAmount: number, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return minorAmount / minorUnitsFor(currency);
}

/** Formats an integer minor-unit amount as a major-unit string with the
 * currency's correct decimal places (`formatMoney(1050, "USD")` -> "10.50",
 * `formatMoney(1000, "JPY")` -> "1000"). Adds no symbol — callers that want
 * one prepend it themselves. */
export function formatMoney(minorAmount: number, currency: CurrencyCode = DEFAULT_CURRENCY): string {
  const exponent = Math.log10(minorUnitsFor(currency));
  return fromMinorUnits(minorAmount, currency).toFixed(exponent);
}

/**
 * Splits an integer `total` (minor units) into `n` integer parts summing to
 * exactly `total` — the largest-remainder method. Used to divide a spin's
 * `totalBet` across `n` paylines without losing or gaining a fractional
 * minor unit (`totalBet / n` is almost never an integer). The first
 * `total % n` parts get one extra unit each; which parts get it is
 * deterministic by index and not a fairness concern, since paylines already
 * differ in which positions they cover.
 */
export function splitIntegerEvenly(total: number, n: number): number[] {
  if (!Number.isInteger(total) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`splitIntegerEvenly requires an integer total and a positive integer n, got total=${total} n=${n}`);
  }
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}
