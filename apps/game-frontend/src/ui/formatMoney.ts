/**
 * Every amount crossing the wire is an integer count of minor units — 100
 * means 1.00. Formatting is the only place that division happens, and it
 * happens for display alone: no derived value is ever fed back to the
 * server, so a rounding artefact here can never become a money error.
 */

const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

const SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", GEL: "₾",
};

export function formatMoney(minorAmount: number, currency = "USD"): string {
  const exponent = MINOR_UNIT_EXPONENT[currency] ?? 2;
  const major = minorAmount / 10 ** exponent;
  const symbol = SYMBOLS[currency] ?? "";
  return `${symbol}${major.toFixed(exponent)}`;
}
