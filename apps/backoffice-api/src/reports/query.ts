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

/** `YYYY-MM-DD` with no time part — the form the report UI asks for, and
 * the only form that gets widened to cover its whole day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

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
    // A date with no time means the whole of that day, because that is what
    // the person typing it means. `new Date("2026-03-31")` is midnight, and
    // the filter applies `$lte`, so taking it literally silently drops every
    // transaction on the last day of the range — a March report asked for as
    // `2026-03-01`..`2026-03-31` would be missing March 31st entirely, with
    // totals that still tie against the rows shown and so give no sign
    // anything is absent. Same family as the `Invalid Date` case above: the
    // wrong answer is the dangerous one precisely because it looks right.
    //
    // Only a date-only string is widened. An explicit timestamp is a caller
    // who has said what they mean, and moving it would be the mistake.
    range.to = DATE_ONLY.test(to) ? new Date(parsed.getTime() + DAY_MS - 1) : parsed;
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

/**
 * Where a page stopped: the last row's timestamp *and* its id.
 *
 * The id is the half that keeps rows from disappearing. `createdAt` is
 * written as `new Date()`, so it is only millisecond-resolution and two
 * transactions genuinely collide on it under concurrent play. A cursor that
 * carried the timestamp alone had to ask for `createdAt < cursor`, which
 * skips *every* row sharing that millisecond — including ones the previous
 * page never returned. A money report would silently omit a real ledger
 * movement, with totals that still tie against the rows shown.
 */
export interface Cursor {
  createdAt: Date;
  transactionId: string;
}

/** Renders a cursor for the wire. The `|` separator is safe because an ISO
 * timestamp cannot contain one, so the split below is unambiguous no matter
 * what an id holds. */
export function formatCursor(createdAt: Date, transactionId: string): string {
  return `${createdAt.toISOString()}|${transactionId}`;
}

/**
 * Parses the opaque paging cursor from a previous page's `nextCursor`.
 * Refused when unparseable, so a mangled cursor is an error rather than a
 * silently empty next page.
 *
 * A bare timestamp with no `|` is still accepted, as a cursor issued by the
 * previous single-key version of this route: rejecting it would turn a page
 * someone had open across a deploy into an error. It pages by timestamp
 * alone and so can still skip a tie — the tie-break needs an id the old
 * cursor never carried.
 */
export function parseCursor(cursor: string | undefined): Cursor | undefined {
  if (cursor === undefined || cursor === "") return undefined;

  const separator = cursor.indexOf("|");
  const timestamp = separator === -1 ? cursor : cursor.slice(0, separator);
  const transactionId = separator === -1 ? "" : cursor.slice(separator + 1);

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidReportQueryError("invalid_cursor", "cursor must be an ISO date from a previous page's nextCursor.");
  }
  return { createdAt: parsed, transactionId };
}

export interface TransactionFilterInput {
  operatorId?: string;
  playerId?: string;
  range: DateRange;
  /** Where the previous page stopped. Everything strictly after it in the
   * sort order is excluded — see the tie-break note below. */
  before?: Cursor;
}

/**
 * Builds the Mongo filter.
 *
 * `before` and `range.to` both constrain the same field, so they are
 * combined rather than one overwriting the other — a cursor must not widen
 * a range the caller asked for. Getting this wrong would make page two of
 * a March report include April.
 *
 * The cursor clause is an `$or`, not a plain `$lt`, and that is the whole
 * point of it. The sort is `createdAt` descending then `transactionId`
 * descending, so "after the cursor" means *either* strictly older, *or* the
 * same instant with a smaller id. A plain `createdAt < cursor` skips every
 * row sharing the cursor's millisecond, and `createdAt` has only
 * millisecond resolution, so concurrent transactions collide and one
 * silently never appears on any page.
 */
export function buildTransactionFilter(input: TransactionFilterInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (input.operatorId) filter.operatorId = input.operatorId;
  if (input.playerId) filter.playerId = input.playerId;

  const createdAt: Record<string, Date> = {};
  if (input.range.from) createdAt.$gte = input.range.from;
  if (input.range.to) createdAt.$lte = input.range.to;

  if (input.before) {
    // The range still wins where it is tighter — a cursor must never widen
    // what the caller asked for.
    const ceiling = input.range.to && input.range.to < input.before.createdAt ? input.range.to : input.before.createdAt;

    if (ceiling < input.before.createdAt) {
      // The range cut in below the cursor, so the cursor's own instant is
      // already out of scope and there is no tie left to break.
      createdAt.$lte = ceiling;
    } else {
      // The upper bound now lives entirely inside the `$or`, so it is
      // removed from the shared clause — leaving both would constrain
      // `createdAt` twice at the top level, and the second would win.
      delete createdAt.$lte;
      const lowerBound = createdAt.$gte ? { $gte: createdAt.$gte } : {};
      filter.$or = [
        { createdAt: { ...lowerBound, $lt: ceiling } },
        { createdAt: ceiling, transactionId: { $lt: input.before.transactionId } },
      ];
      return filter;
    }
  }

  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;
  return filter;
}
