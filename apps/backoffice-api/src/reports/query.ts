/**
 * Turning query-string text into a database query, refusing anything it
 * cannot represent honestly.
 *
 * The rule this file exists to enforce: **a malformed input must be an
 * error, never an empty result.** `new Date("not-a-date")` is an
 * `Invalid Date`, and Mongo treats `$gte: Invalid Date` as matching
 * nothing rather than as a fault — so a typo in a date turns "show me
 * March" into "there were no transactions", which is a report someone acts
 * on. Same family as **F22**, where `Number("abc")` produced `NaN`, every
 * comparison against it was false, and a clamp meant to bound a page
 * silently returned the entire collection.
 */

export class InvalidReportQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

/** Parses an optional ISO date pair, throwing rather than silently
 * excluding everything. */
export function parseDateRange(from?: string, to?: string): DateRange {
  const range: DateRange = {};

  if (from !== undefined && from !== "") {
    const parsed = new Date(from);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidReportQueryError("invalid_from_date", `'${from}' is not a valid ISO date.`);
    }
    range.from = parsed;
  }

  if (to !== undefined && to !== "") {
    const parsed = new Date(to);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidReportQueryError("invalid_to_date", `'${to}' is not a valid ISO date.`);
    }
    range.to = parsed;
  }

  // Refused rather than returned as an empty result, for the same reason
  // as an unparseable date: a reversed range is a mistake someone made,
  // and reporting "no transactions" hides it.
  if (range.from && range.to && range.from > range.to) {
    throw new InvalidReportQueryError("invalid_date_range", "'from' is after 'to'.");
  }

  return range;
}

/**
 * Clamps a requested page size.
 *
 * Written as an explicit `Number.isFinite` check rather than
 * `Number(limit) || DEFAULT`, and the difference is F22 exactly. The `||`
 * form is the obvious one and it conflates three different inputs: `abc`
 * becomes `NaN` (falsy → default, which is *accidentally* right), and `0`
 * also becomes the default, so a caller asking for zero rows gets a
 * hundred. Worse, a `Math.min/Math.max` clamp applied to `NaN` evaluates
 * to `NaN`, and Mongo reads a `NaN` limit as **no limit at all** — the
 * exact bug F22 records, where a bounded page returned the whole
 * collection.
 *
 * So: anything not a finite number falls back to the default; anything
 * finite is clamped into range. The reference repo's equivalent uses the
 * `||` form.
 */
export function clampLimit(requested: string | undefined, defaultLimit: number, maxLimit: number): number {
  if (requested === undefined || requested === "") return defaultLimit;

  const parsed = Number(requested);
  if (!Number.isFinite(parsed)) return defaultLimit;

  // Truncated rather than rejected: `limit=10.5` is a caller being sloppy,
  // not a caller being wrong, and there is an unambiguous reading.
  return Math.min(maxLimit, Math.max(1, Math.floor(parsed)));
}

/** Parses the opaque paging cursor — an ISO timestamp from a previous
 * page's `nextCursor`. Refused when unparseable, so a mangled cursor is an
 * error rather than a silently empty next page. */
export function parseCursor(cursor: string | undefined): Date | undefined {
  if (cursor === undefined || cursor === "") return undefined;

  const parsed = new Date(cursor);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidReportQueryError("invalid_cursor", "cursor must be an ISO date from a previous page's nextCursor.");
  }
  return parsed;
}

export interface TransactionFilterInput {
  operatorId?: string;
  playerId?: string;
  range: DateRange;
  /** Exclusive upper bound for keyset paging — strictly older than this. */
  before?: Date;
}

/**
 * Builds the Mongo filter.
 *
 * `before` and `range.to` both constrain the same field, so they are
 * combined rather than one overwriting the other — a cursor must not widen
 * a range the caller asked for. Getting this wrong would make page two of
 * a March report include April.
 */
export function buildTransactionFilter(input: TransactionFilterInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (input.operatorId) filter.operatorId = input.operatorId;
  if (input.playerId) filter.playerId = input.playerId;

  const createdAt: Record<string, Date> = {};
  if (input.range.from) createdAt.$gte = input.range.from;
  if (input.range.to) createdAt.$lte = input.range.to;
  if (input.before) {
    // The tighter of the two wins. `$lt` and `$lte` can coexist in one
    // Mongo query, but relying on that would leave the intent unstated.
    createdAt.$lt = input.range.to && input.range.to < input.before ? input.range.to : input.before;
    if (createdAt.$lt && createdAt.$lte) delete createdAt.$lte;
  }

  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;
  return filter;
}
