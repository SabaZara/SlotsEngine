import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { requireRole } from "../auth/middleware.js";
import { toCsv } from "./csv.js";
import {
  InvalidReportQueryError,
  buildTransactionFilter,
  clampLimit,
  formatCursor,
  parseCursor,
  parseDateRange,
} from "./query.js";

/**
 * Reading the money. Not changing it — every route here is a `GET`, and
 * nothing in this module writes.
 *
 * `operations` and `viewer` both qualify: reconciling an operator's
 * statement is ordinary finance and support work, and a read that carries
 * no credential and no personal data beyond ids is not the place to be
 * restrictive. Issuing a credential is the guarded operation; reading what
 * it did is not.
 */
const CAN_VIEW_REPORTS = requireRole("operations", "viewer");

/** The columns a CSV carries, in order. Explicit rather than derived from
 * the first row's keys: a derived header changes shape when an optional
 * field happens to be absent from row one, which silently shifts every
 * column in a file someone reconciles against.
 *
 * Exported so tests can locate a column by name rather than by a
 * hardcoded index — an index in a test is a second copy of this order,
 * and it goes wrong silently the first time a column is inserted. */
export const TRANSACTION_CSV_COLUMNS = [
  "transactionId",
  "operatorId",
  "playerId",
  "roundId",
  "type",
  "amount",
  "balanceAfter",
  "status",
  "createdAt",
];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * A CSV is a single bulk download rather than something a UI pages
 * through, so its ceiling is far higher — but it is still a ceiling, and
 * hitting it is **reported** rather than silent. A truncated financial
 * export that looks complete is the worst possible failure of this route:
 * the numbers reconcile against themselves and are simply missing rows.
 */
export const CSV_EXPORT_LIMIT = 50_000;

/**
 * The truncation decision, split out from the route so it can be tested.
 *
 * **It could not be, before.** The branch lived inline and the only way to
 * reach it was to export more than 50,000 rows, which no test does — so the
 * slice, the `x-truncated` header and the `# TRUNCATED` row had never
 * executed in the suite. That is exactly the gap the verification
 * standard's fifth entry is about: a ceiling nothing is ever refused by is
 * a ceiling nobody has demonstrated. And it matters here more than most,
 * because the whole purpose of these signals is that **a truncated
 * financial export must not look complete** — F31 is already the record of
 * that signal being broken in a way no test caught.
 *
 * Takes `limit` as an argument rather than reading the constant, so a test
 * can drive the boundary with three rows instead of fifty thousand and one.
 * The route passes `CSV_EXPORT_LIMIT`; nothing else changes.
 *
 * The caller fetches `limit + 1` rows, so "more than the cap matched" is
 * `rows.length > limit` — one extra row is the whole signal, and counting
 * separately would be a second query racing the first.
 */
export function decideCsvTruncation<T>(
  rows: readonly T[],
  limit: number,
): { truncated: boolean; exported: readonly T[]; notice?: string } {
  const truncated = rows.length > limit;
  return {
    truncated,
    // Sliced from the START, so the rows kept are the newest — the query
    // sorts `createdAt` descending, and someone reconciling a recent period
    // needs the recent end. Slicing from the other end would silently drop
    // exactly the rows they came for.
    exported: truncated ? rows.slice(0, limit) : rows,
    ...(truncated
      ? { notice: `# TRUNCATED: more than ${limit} rows matched. Narrow the date range.` }
      : {}),
  };
}

interface TransactionsQuery {
  operatorId?: string;
  playerId?: string;
  from?: string;
  to?: string;
  format?: string;
  limit?: string;
  cursor?: string;
}

export function registerReportRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: TransactionsQuery }>(
    "/v1/reports/transactions",
    { preHandler: [CAN_VIEW_REPORTS] },
    async (request, reply) => {
      const { operatorId, playerId, from, to, format, limit: limitParam, cursor } = request.query ?? {};

      let range;
      let before;
      try {
        range = parseDateRange(from, to);
        before = parseCursor(cursor);
      } catch (err) {
        // A malformed input is the caller's mistake and they can fix it —
        // so it is a 400 naming the field, never an empty result set that
        // reads as "there were no transactions".
        if (err instanceof InvalidReportQueryError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }

      if (format === "csv") {
        // Cursor paging is meaningless for a bulk download, and accepting
        // it would imply a caller could page a CSV. The range still
        // applies.
        const filter = buildTransactionFilter({ operatorId, playerId, range });

        // One more than the cap, so "there were exactly this many" and
        // "there were more" are distinguishable. Counting separately would
        // be a second query racing the first.
        const rows = await db
          .collection("transactions")
          .find(filter, { projection: { _id: 0 } })
          .sort({ createdAt: -1 })
          .limit(CSV_EXPORT_LIMIT + 1)
          .toArray();

        const { truncated, exported, notice } = decideCsvTruncation(rows, CSV_EXPORT_LIMIT);

        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header("content-disposition", 'attachment; filename="transactions.csv"');
        // Announced in a header AND, below, as a comment row — a header is
        // invisible to someone who opens the file in a spreadsheet, which
        // is what most people do with it.
        if (truncated) reply.header("x-truncated", "true");

        const csv = toCsv([...exported], TRANSACTION_CSV_COLUMNS);
        return reply.send(notice ? `${csv}\n${notice}` : csv);
      }

      const limit = clampLimit(limitParam, DEFAULT_LIMIT, MAX_LIMIT);
      const filter = buildTransactionFilter({ operatorId, playerId, range, ...(before ? { before } : {}) });

      // Keyset paging on `createdAt`, not `skip`/`offset`. `skip` re-reads
      // and discards every preceding row, so page 500 costs 500 pages of
      // work — and worse, a row written between two requests shifts every
      // subsequent page, so a report can show a transaction twice or not at
      // all. A cursor is stable against concurrent writes, which a money
      // report has to be.
      // Sorted by the same compound key the cursor carries. `createdAt`
      // alone is not a total order — it is millisecond-resolution, so
      // concurrent transactions tie — and a keyset cursor over a
      // non-deterministic order drops rows. `transactionId` breaks the tie.
      const docs = await db
        .collection("transactions")
        .find(filter, { projection: { _id: 0 } })
        .sort({ createdAt: -1, transactionId: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = docs.length > limit;
      const transactions = hasMore ? docs.slice(0, limit) : docs;
      const last = transactions[transactions.length - 1];

      return reply.send({
        transactions,
        count: transactions.length,
        hasMore,
        // Only present when there IS another page, so a caller can loop on
        // its presence rather than comparing counts.
        ...(hasMore && last
          ? { nextCursor: formatCursor(new Date(last.createdAt as Date), String(last.transactionId)) }
          : {}),
      });
    },
  );

  /**
   * Totals for a range, which is the question a finance report is usually
   * actually asking: what did this operator take, and what did it pay out.
   *
   * Aggregated in the database rather than by summing a paged read, for
   * the obvious reason and a less obvious one: a client summing pages gets
   * a different answer depending on how far it paged, and would have no
   * way to know it had stopped early.
   */
  app.get<{ Querystring: TransactionsQuery }>(
    "/v1/reports/summary",
    { preHandler: [CAN_VIEW_REPORTS] },
    async (request, reply) => {
      const { operatorId, playerId, from, to } = request.query ?? {};

      let range;
      try {
        range = parseDateRange(from, to);
      } catch (err) {
        if (err instanceof InvalidReportQueryError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }

      const filter = buildTransactionFilter({ operatorId, playerId, range });

      const grouped = await db
        .collection("transactions")
        .aggregate([{ $match: filter }, { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } }])
        .toArray();

      const of = (type: string) => grouped.find((row) => row._id === type);
      // Integer minor units throughout, like every other money value here.
      //
      // **What these totals are, and are not.** `debit` and `credit` are
      // the only two movement types the ledger records, so `paidOut` sums
      // every credit — which includes an operator's `cash-in` deposits
      // alongside actual winnings. Measured on the live stack: an operator
      // with 1,200 staked showed 501,210 credited, of which 500,000 was
      // five deposits and only 1,210 was won.
      //
      // That is the honest sum of what the data records, and it is
      // deliberately not "corrected" here by guessing which credits were
      // wins: a deposit and a payout are genuinely indistinguishable in
      // `transactions` today, since neither carries a category. Splitting
      // them would need a field on the ledger write, which is a money-path
      // change and belongs in its own piece of work rather than being
      // inferred by a report. Until then this answers "what moved", not
      // "what was won" — see docs/TODO.md item 13.
      const debits = of("debit");
      const credits = of("credit");
      const staked = (debits?.total as number | undefined) ?? 0;
      const paidOut = (credits?.total as number | undefined) ?? 0;

      return reply.send({
        staked,
        paidOut,
        // The house's position, and deliberately named rather than left for
        // a caller to subtract: getting the sign the wrong way round is the
        // easiest mistake to make with this number, and it would be made
        // separately by every consumer.
        net: staked - paidOut,
        debitCount: (debits?.count as number | undefined) ?? 0,
        creditCount: (credits?.count as number | undefined) ?? 0,
      });
    },
  );
}
