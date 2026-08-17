process.env.DISABLE_RATE_LIMIT = "true";
process.env.SECRETS_ENCRYPTION_KEY ??= "d".repeat(64);
process.env.BACKOFFICE_JWT_SECRET ??= "a-test-secret-long-enough-to-pass-the-guard";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { buildApp } from "../app.js";
import { TRANSACTION_CSV_COLUMNS } from "./routes.js";
import { signSession } from "../auth/jwt.js";
import { createUser } from "../auth/users.js";

/**
 * The finance report, against a real MongoDB.
 *
 * **Why not `fakeMongo`.** Two things here are properties of the database
 * rather than of this code, and the stand-in models neither faithfully:
 * the `$group` aggregation that produces the summary, and range
 * comparisons against BSON `Date` values. A report that sums money is
 * exactly the wrong place to be trusting a stand-in — F1 and F9 were both
 * "the fake agreed with us and Mongo did not".
 *
 * There is a second reason, specific to this route. `transactions.createdAt`
 * is written by the ledger as a real BSON `Date`, while
 * `shared-types`' `Transaction` interface declares it a `string`. The
 * cursor and both range bounds compare against it, so the behaviour that
 * matters is Mongo's, not TypeScript's.
 *
 * What this suite cannot establish: that the CSV opens correctly in a
 * spreadsheet. The escaping is pinned in `csv.test.ts`; whether Excel
 * agrees is not something a test here can answer.
 *
 * Skips when Mongo is unreachable, so a laptop without Docker still
 * passes; the e2e job runs it for real.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";

let client: MongoClient | undefined;
let db: Db;
let app: FastifyInstance;
let skipReason = "";
let tokens: { ops: string; viewer: string; designer: string };

const OPERATOR = "report-test-operator";
const OTHER_OPERATOR = "report-test-other";
const PLAYER = "report-test-player";

/** Fixed timestamps, so range assertions are exact rather than relative to
 * when the suite happened to run. */
const MARCH_1 = new Date("2026-03-01T00:00:00.000Z");
const MARCH_15 = new Date("2026-03-15T00:00:00.000Z");
const MARCH_31 = new Date("2026-03-31T00:00:00.000Z");
const APRIL_15 = new Date("2026-04-15T00:00:00.000Z");

function transaction(overrides: Record<string, unknown>) {
  return {
    transactionId: randomUUID(),
    operatorId: OPERATOR,
    playerId: PLAYER,
    type: "debit",
    amount: 100,
    balanceAfter: 900,
    status: "completed",
    createdAt: MARCH_15,
    ...overrides,
  };
}

before(async () => {
  try {
    client = new MongoClient(MONGO_URI, { ignoreUndefined: true, serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    skipReason = `no usable MongoDB at ${MONGO_URI} (${(err as Error).message.split("\n")[0]})`;
    client = undefined;
    return;
  }

  db = client.db(`report_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  app = await buildApp(db as never, createLogger("reports-test"));
  await app.ready();

  const make = async (email: string, roles: string[]) => {
    const user = await createUser(db as never, { email, password: "a-long-enough-password", roles: roles as never });
    return signSession({ userId: user.userId, email: user.email, roles: user.roles, tokenVersion: user.tokenVersion })
      .token;
  };
  tokens = {
    ops: await make("ops@example.com", ["operations"]),
    viewer: await make("viewer@example.com", ["viewer"]),
    designer: await make("designer@example.com", ["game_designer"]),
  };

  await db.collection("transactions").insertMany([
    transaction({ createdAt: MARCH_1, amount: 100, type: "debit" }),
    transaction({ createdAt: MARCH_15, amount: 250, type: "debit" }),
    transaction({ createdAt: MARCH_31, amount: 400, type: "credit" }),
    // Outside March — the row that proves a range filter is applied.
    transaction({ createdAt: APRIL_15, amount: 999, type: "debit" }),
    // A different operator, and a different player, so tenant scoping is
    // tested against a real neighbour rather than against an absence.
    transaction({ operatorId: OTHER_OPERATOR, createdAt: MARCH_15, amount: 5_000, type: "debit" }),
    // A second player under the SAME operator, deliberately dated outside
    // March. It exists to prove player scoping narrows an operator-wide
    // query — but placing it inside the reported range would also make it
    // a legitimate part of every operator-scoped March total, which is
    // what a first draft of this fixture did: four assertions failed, and
    // the code was right each time. A fixture row has to test one thing.
    transaction({ playerId: "someone-else", createdAt: APRIL_15, amount: 77, type: "debit" }),
  ]);
});

after(async () => {
  await app?.close();
  if (client) {
    await db.dropDatabase().catch(() => {});
    await client.close().catch(() => {});
  }
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function report(query: string, token = tokens.ops) {
  return app.inject({ method: "GET", url: `/v1/reports/transactions${query}`, headers: auth(token) });
}

describe("who may read the money", () => {
  it("lets operations read a report", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await report("")).statusCode, 200);
  });

  it("lets a viewer read one, because reconciling is ordinary support work", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await report("", tokens.viewer)).statusCode, 200);
  });

  it("refuses a game_designer, who has no reason to read the money", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await report("", tokens.designer)).statusCode, 403);
  });

  it("refuses an unauthenticated request", async function () {
    if (!client) return this.skip(skipReason);
    const response = await app.inject({ method: "GET", url: "/v1/reports/transactions" });
    assert.equal(response.statusCode, 401);
  });
});

describe("filtering", () => {
  it("scopes to one operator", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}`);
    const operators = new Set(response.json().transactions.map((t: { operatorId: string }) => t.operatorId));

    assert.deepEqual([...operators], [OPERATOR], "another operator's money must not appear");
  });

  it("scopes to one player", async function () {
    if (!client) return this.skip(skipReason);

    // The unscoped query must genuinely contain both players, or this
    // asserts nothing — a filter looks like it works when there was only
    // ever one value to return.
    const unscoped = await report(`?operatorId=${OPERATOR}`);
    const allPlayers = new Set(unscoped.json().transactions.map((t: { playerId: string }) => t.playerId));
    assert.equal(allPlayers.size, 2, "the premise: this operator has two players on record");

    const response = await report(`?operatorId=${OPERATOR}&playerId=${PLAYER}`);
    const players = new Set(response.json().transactions.map((t: { playerId: string }) => t.playerId));

    assert.deepEqual([...players], [PLAYER]);
  });

  it("applies a date range, inclusive at both ends", async function () {
    if (!client) return this.skip(skipReason);

    // The boundary rows are deliberately ON the bounds: an exclusive
    // comparison would drop the first and last day of every month someone
    // reports on, which is the kind of error that survives for years
    // because the totals still look plausible.
    const response = await report(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}`,
    );
    const amounts = response.json().transactions.map((t: { amount: number }) => t.amount).sort((a: number, b: number) => a - b);

    assert.deepEqual(amounts, [100, 250, 400], "March's three rows, and not April's");
  });

  it("refuses a malformed date rather than reporting an empty month", async function () {
    if (!client) return this.skip(skipReason);

    // The failure this route exists to avoid. `$gte: Invalid Date` matches
    // nothing, so without the guard a typo reads as "no transactions" —
    // and someone believes it.
    const response = await report("?from=last-tuesday");

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_from_date");
  });

  it("refuses a reversed range", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?from=${MARCH_31.toISOString()}&to=${MARCH_1.toISOString()}`);
    assert.equal(response.statusCode, 400);
  });
});

describe("paging", () => {
  it("returns newest first", async function () {
    if (!client) return this.skip(skipReason);

    const rows = (await report(`?operatorId=${OPERATOR}`)).json().transactions as Array<{ createdAt: string }>;
    const times = rows.map((row) => new Date(row.createdAt).getTime());

    assert.deepEqual([...times].sort((a, b) => b - a), times, "rows must be in descending date order");
  });

  it("reports there is more, and hands back a cursor that reaches it", async function () {
    if (!client) return this.skip(skipReason);

    const first = await report(`?operatorId=${OPERATOR}&limit=2`);
    assert.equal(first.json().count, 2);
    assert.equal(first.json().hasMore, true);
    assert.ok(first.json().nextCursor, "a cursor must be offered when there is another page");

    const second = await report(
      `?operatorId=${OPERATOR}&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );

    const firstIds = first.json().transactions.map((t: { transactionId: string }) => t.transactionId);
    const secondIds = second.json().transactions.map((t: { transactionId: string }) => t.transactionId);
    assert.equal(
      secondIds.some((id: string) => firstIds.includes(id)),
      false,
      "the second page must not repeat the first",
    );
  });

  it("omits the cursor on the last page, so a caller knows to stop", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&limit=1000`);
    assert.equal(response.json().hasMore, false);
    assert.equal(response.json().nextCursor, undefined);
  });

  it("keeps a cursor inside the requested range", async function () {
    if (!client) return this.skip(skipReason);

    // Page two of a March report must not show April. The cursor is an
    // upper bound within the range, not a replacement for it.
    const first = await report(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}&limit=1`,
    );
    const second = await report(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}&limit=10` +
        `&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );

    const dates = (second.json().transactions as Array<{ createdAt: string }>).map((r) => new Date(r.createdAt));
    assert.equal(
      dates.every((date) => date <= MARCH_31),
      true,
      "no row past the requested range may appear on a later page",
    );
  });

  it("bounds an absurd limit rather than serving the collection", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&limit=999999`);
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().count <= 1000);
  });

  it("refuses a mangled cursor rather than serving an empty page", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&cursor=garbage`);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_cursor");
  });

  it("returns every row when several share a timestamp, paged one at a time", async function () {
    if (!client) return this.skip(skipReason);

    // The failure this pins is silent: `createdAt` is millisecond
    // resolution, so concurrent play ties on it, and a cursor of
    // `createdAt < last` skips every row in that millisecond — including
    // ones no page returned. Against real Mongo rather than a stand-in
    // because the sort order under a tie is the database's behaviour, and
    // that is exactly what is being relied on.
    const operator = "tie-test-operator";
    const sameInstant = new Date("2026-06-01T09:00:00.000Z");
    const ids = ["tie-a", "tie-b", "tie-c"];

    await db.collection("transactions").insertMany(
      ids.map((transactionId) => ({
        transactionId,
        operatorId: operator,
        playerId: "tie-player",
        type: "debit",
        amount: 100,
        balanceAfter: 900,
        status: "completed",
        createdAt: sameInstant,
      })),
    );

    // Page size 1, so every step has to cross the tie rather than swallow
    // it inside one page.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const query = `?operatorId=${operator}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = (await report(query)).json();
      seen.push(...body.transactions.map((t: { transactionId: string }) => t.transactionId));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    assert.deepEqual([...seen].sort(), ids, "every tied row must appear on exactly one page");
    assert.equal(new Set(seen).size, seen.length, "and none of them twice");
  });
});

describe("the CSV export", () => {
  it("serves a CSV with a header row and the right content type", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&format=csv`);

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] as string, /text\/csv/);
    assert.equal(response.body.split("\n")[0], "transactionId,operatorId,playerId,roundId,type,amount,balanceAfter,status,createdAt");
  });

  it("offers itself as a download rather than rendering in the browser", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&format=csv`);
    assert.match(response.headers["content-disposition"] as string, /attachment/);
  });

  it("applies the same filters as the JSON view", async function () {
    if (!client) return this.skip(skipReason);

    // A CSV that ignored the range would hand someone a file that
    // disagrees with the report they were just looking at.
    const response = await report(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}&format=csv`,
    );
    const rows = response.body.trim().split("\n").slice(1);

    assert.equal(rows.length, 3, "March's three rows");
    assert.equal(response.body.includes("999"), false, "April's row must not be in the file");
  });

  it("never carries another operator's rows", async function () {
    if (!client) return this.skip(skipReason);

    const response = await report(`?operatorId=${OPERATOR}&format=csv`);
    assert.equal(response.body.includes(OTHER_OPERATOR), false);
  });

  it("orders rows newest first, like the JSON view", async function () {
    if (!client) return this.skip(skipReason);

    // Found by mutation testing: reversing the CSV query's sort survived
    // every other test here, because the JSON ordering test does not touch
    // this code path and nothing else looked at row order in the file.
    //
    // It is not cosmetic. The export is capped, and the cap slices from the
    // end — so with the order reversed, a truncated export silently drops
    // the NEWEST transactions rather than the oldest, which is the opposite
    // of what someone reconciling a recent period needs. It would also
    // disagree with the on-screen report it was exported from.
    const response = await report(`?operatorId=${OPERATOR}&format=csv`);
    const createdAtColumn = TRANSACTION_CSV_COLUMNS.indexOf("createdAt");

    const times = response.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => new Date(line.split(",")[createdAtColumn]!).getTime());

    assert.ok(times.length > 1, "the premise: more than one row, or order is untestable");
    assert.deepEqual([...times].sort((a, b) => b - a), times, "the CSV must be newest-first");
  });
});

describe("the summary", () => {
  async function summary(query: string) {
    return app.inject({ method: "GET", url: `/v1/reports/summary${query}`, headers: auth(tokens.ops) });
  }

  it("totals stakes and payouts over a range", async function () {
    if (!client) return this.skip(skipReason);

    const response = await summary(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}`,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().staked, 350, "100 + 250 debits");
    assert.equal(response.json().paidOut, 400, "the single credit");
    assert.equal(response.json().debitCount, 2);
    assert.equal(response.json().creditCount, 1);
  });

  it("names the house's net position rather than leaving it to be derived", async function () {
    if (!client) return this.skip(skipReason);

    // Negative here — March paid out more than it took. Asserting the sign
    // deliberately: getting it backwards is the easiest mistake to make
    // with this number, and it would otherwise be made independently by
    // every consumer.
    const response = await summary(
      `?operatorId=${OPERATOR}&from=${MARCH_1.toISOString()}&to=${MARCH_31.toISOString()}`,
    );
    assert.equal(response.json().net, -50, "staked minus paid out");
  });

  it("reports zeroes for a range with no transactions, rather than failing", async function () {
    if (!client) return this.skip(skipReason);

    // An empty period is a legitimate answer, and a report that errors on
    // one is a report nobody can run on a quiet month.
    const response = await summary(`?operatorId=${OPERATOR}&from=2020-01-01&to=2020-01-31`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().staked, 0);
    assert.equal(response.json().paidOut, 0);
    assert.equal(response.json().net, 0);
  });

  it("scopes to one operator", async function () {
    if (!client) return this.skip(skipReason);

    const response = await summary(`?operatorId=${OTHER_OPERATOR}`);
    assert.equal(response.json().staked, 5_000, "only the other operator's single row");
  });

  it("counts a deposit as a payout, which is what the data actually records", async function () {
    if (!client) return this.skip(skipReason);

    // Pinning a known limitation rather than a desired behaviour, so it
    // cannot be mistaken for a bug later — and so that fixing it properly
    // has to change this test deliberately.
    //
    // `transactions` records only `debit` and `credit`, with no category,
    // so an operator's cash-in is indistinguishable from a win. Found on
    // the live stack: an operator with 1,200 staked reported 501,210 paid
    // out, of which 500,000 was five demo deposits. The report is not
    // wrong about what moved; it cannot answer "what was won" without a
    // field the ledger does not write. See docs/TODO.md item 13.
    const depositPlayer = `deposit-${randomUUID().slice(0, 8)}`;
    await db.collection("transactions").insertOne(
      transaction({ playerId: depositPlayer, type: "credit", amount: 100_000, createdAt: MARCH_15 }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/reports/summary?operatorId=${OPERATOR}&playerId=${depositPlayer}`,
      headers: auth(tokens.ops),
    });

    assert.equal(response.json().paidOut, 100_000, "a deposit lands in paidOut alongside genuine winnings");
    assert.equal(response.json().creditCount, 1);
  });

  it("refuses a malformed date here too", async function () {
    if (!client) return this.skip(skipReason);

    const response = await summary("?from=nonsense");
    assert.equal(response.statusCode, 400);
  });

  it("refuses a game_designer", async function () {
    if (!client) return this.skip(skipReason);

    const response = await app.inject({
      method: "GET",
      url: "/v1/reports/summary",
      headers: auth(tokens.designer),
    });
    assert.equal(response.statusCode, 403);
  });
});
