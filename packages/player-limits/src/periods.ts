/**
 * Which window a stake counts against.
 *
 * **A period is identified by a string key, not by a pair of timestamps**,
 * and that is the decision the rest of this package rests on. A counter
 * keyed `2026-08-18` can be incremented with a single atomic `$inc` on a
 * document the writer does not have to read first — which is what lets the
 * limit check live *inside* the spin transaction rather than as a
 * read-then-write beside it. Storing `windowStart`/`windowEnd` instead
 * would mean reading the row to decide whether it had expired, and a
 * read-then-write is exactly the race this package exists to refuse.
 *
 * Rolling windows ("any 24 hours") are deliberately not offered. They
 * cannot be a keyed counter — every stake would have to be retained
 * individually and re-summed per bet — and the regulators that mandate
 * these limits specify calendar periods. See `docs/TODO.md` for the note
 * on what would change if a market ever requires one.
 */

export const LIMIT_PERIODS = ["daily", "weekly", "monthly"] as const;

export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/**
 * All period boundaries are **UTC**, deliberately and visibly.
 *
 * The alternative — the operator's local timezone — is defensible and is
 * what several regulators actually specify, but it cannot be added later by
 * changing this function alone: a counter key written under one timezone is
 * not comparable to one written under another, so a switch would silently
 * mix two meanings in the same collection. Recorded rather than hidden, so
 * that adding it is a migration rather than an edit. UTC is at least
 * unambiguous, and it matches every other timestamp in this system.
 */
export function periodKey(period: LimitPeriod, at: Date): string {
  if (Number.isNaN(at.getTime())) {
    // An `Invalid Date` would render as "NaN-NaN-NaN" and quietly become a
    // real counter key that every subsequent invalid date also shares —
    // one bucket accumulating unrelated stakes. Same family as F22: the
    // dangerous outcome is not a crash, it is a plausible wrong number.
    throw new RangeError("periodKey needs a valid date");
  }

  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;

  switch (period) {
    case "daily":
      return `${year}-${pad(month)}-${pad(at.getUTCDate())}`;
    case "monthly":
      return `${year}-${pad(month)}`;
    case "weekly":
      return isoWeekKey(at);
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * ISO-8601 week key, e.g. `2026-W34`.
 *
 * ISO weeks rather than "seven days from Sunday" because the naive form has
 * a boundary bug that is invisible until New Year: a week containing
 * 1 January belongs to whichever year holds most of it, so a key built from
 * `getUTCFullYear()` plus a week number can produce `2027-W01` for a date
 * in December — a counter that resets mid-week, handing a player a fresh
 * allowance. The year here comes from the week's own Thursday, which is the
 * ISO rule and the reason the algorithm looks indirect.
 */
function isoWeekKey(at: Date): string {
  // Copy: this must not mutate the caller's Date. Normalised to midnight so
  // the arithmetic below is in whole days and cannot be shifted by the time
  // of day the spin happened to land on.
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

  // ISO weeks run Monday(1)–Sunday(7); `getUTCDay()` gives Sunday as 0.
  const isoDay = thursday.getUTCDay() === 0 ? 7 : thursday.getUTCDay();

  // Step to the Thursday of this week. Thursday decides the week's year,
  // which is what makes the turn-of-year case come out right.
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);

  const weekYear = thursday.getUTCFullYear();
  const firstOfYear = Date.UTC(weekYear, 0, 1);
  const dayOfYear = (thursday.getTime() - firstOfYear) / 86_400_000;
  const week = Math.floor(dayOfYear / 7) + 1;

  return `${weekYear}-W${pad(week)}`;
}
