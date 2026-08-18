process.env.DISABLE_RATE_LIMIT = "true";
process.env.SECRETS_ENCRYPTION_KEY ??= "c".repeat(64);
process.env.BACKOFFICE_JWT_SECRET ??= "a-test-secret-long-enough-to-pass-the-guard";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { buildApp } from "../app.js";
import { signSession } from "../auth/jwt.js";
import { createUser } from "../auth/users.js";

/**
 * The support lookup, against a real MongoDB.
 *
 * Real Mongo rather than `fakeMongo` for the same reason as the reports
 * suite: the sort-and-limit behaviour and the `Date` comparisons are the
 * database's, and this route's whole job is returning *the most recent*
 * activity. A stand-in that returns insertion order would make an ordering
 * bug invisible.
 *
 * What this cannot establish: that the data shown is enough to resolve a
 * real support case. That is a product question, and the answer changes
 * with the case. What is pinned is that the route shows the right player's
 * data, in the right order, and says when it is showing only part of it.
 *
 * Skips when Mongo is unreachable, so a laptop without Docker still
 * passes.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";

let client: MongoClient | undefined;
let db: Db;
let app: FastifyInstance;
let skipReason = "";
let tokens: { ops: string; viewer: string; designer: string };

const OPERATOR = "support-test-operator";
const OTHER_OPERATOR = "support-test-other";
const PLAYER = "support-test-player";

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

  db = client.db(`support_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  app = await buildApp(db as never, createLogger("support-test"));
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

  await db.collection("players").insertMany([
    { operatorId: OPERATOR, playerId: PLAYER, balance: 12_345 },
    // The same playerId under a different operator, holding a different
    // balance — so tenant scoping is tested against a real collision
    // rather than against an absence. Operators choose player ids
    // independently, so this is not a contrived case.
    { operatorId: OTHER_OPERATOR, playerId: PLAYER, balance: 99_999 },
  ]);

  // Dated deliberately out of insertion order, so "newest first" is a real
  // claim rather than an accident of how they were written.
  await db.collection("transactions").insertMany([
    {
      transactionId: "tx-middle",
      operatorId: OPERATOR,
      playerId: PLAYER,
      type: "debit",
      amount: 100,
      balanceAfter: 12_345,
      status: "completed",
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
    },
    {
      transactionId: "tx-newest",
      operatorId: OPERATOR,
      playerId: PLAYER,
      type: "credit",
      amount: 500,
      balanceAfter: 12_845,
      status: "completed",
      createdAt: new Date("2026-03-31T00:00:00.000Z"),
    },
    {
      transactionId: "tx-oldest",
      operatorId: OPERATOR,
      playerId: PLAYER,
      type: "debit",
      amount: 50,
      balanceAfter: 12_245,
      status: "completed",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
    {
      transactionId: "tx-other-operator",
      operatorId: OTHER_OPERATOR,
      playerId: PLAYER,
      type: "debit",
      amount: 7_777,
      balanceAfter: 92_222,
      status: "completed",
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
    },
  ]);

  await db.collection("rounds").insertMany([
    {
      roundId: "round-1",
      operatorId: OPERATOR,
      playerId: PLAYER,
      gameId: "reference-5x3",
      gameVersion: 1,
      totalBet: 100,
      seed: "seed-abc",
      rngAlgorithm: "xoshiro256ss-d16",
      status: "resolved",
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
    },
    {
      // A second round for the same player, dated NEWER than round-1 but
      // inserted after it — so insertion order and date order disagree.
      // Added because mutation testing showed the rounds sort was
      // unverified: with one round in the fixture, any ordering passes.
      roundId: "round-2",
      operatorId: OPERATOR,
      playerId: PLAYER,
      gameId: "reference-5x3",
      gameVersion: 1,
      totalBet: 200,
      seed: "seed-def",
      rngAlgorithm: "xoshiro256ss-d16",
      status: "resolved",
      createdAt: new Date("2026-03-25T00:00:00.000Z"),
    },
    {
      roundId: "round-other",
      operatorId: OTHER_OPERATOR,
      playerId: PLAYER,
      gameId: "reference-5x3",
      gameVersion: 1,
      totalBet: 999,
      seed: "seed-xyz",
      rngAlgorithm: "xoshiro256ss-d16",
      status: "resolved",
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
    },
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

async function lookup(operatorId: string, playerId: string, token = tokens.ops) {
  return app.inject({
    method: "GET",
    url: `/v1/support/players/${encodeURIComponent(operatorId)}/${encodeURIComponent(playerId)}`,
    headers: auth(token),
  });
}

describe("who may look a player up", () => {
  it("lets operations", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await lookup(OPERATOR, PLAYER)).statusCode, 200);
  });

  it("lets a viewer, because answering a player's question is support work", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await lookup(OPERATOR, PLAYER, tokens.viewer)).statusCode, 200);
  });

  it("refuses a game_designer", async function () {
    if (!client) return this.skip(skipReason);
    assert.equal((await lookup(OPERATOR, PLAYER, tokens.designer)).statusCode, 403);
  });

  it("refuses an unauthenticated request", async function () {
    if (!client) return this.skip(skipReason);
    const response = await app.inject({ method: "GET", url: `/v1/support/players/${OPERATOR}/${PLAYER}` });
    assert.equal(response.statusCode, 401);
  });
});

describe("what the lookup answers", () => {
  it("returns the player's balance", async function () {
    if (!client) return this.skip(skipReason);

    const response = await lookup(OPERATOR, PLAYER);
    assert.equal(response.json().player.balance, 12_345);
  });

  it("returns their recent transactions and rounds together", async function () {
    if (!client) return this.skip(skipReason);

    // One round trip, three collections. The point of the route.
    const body = (await lookup(OPERATOR, PLAYER)).json();
    assert.equal(body.recentTransactions.length, 3);
    assert.equal(body.recentRounds.length, 2);
  });

  it("orders transactions newest first, which is what 'recent' has to mean", async function () {
    if (!client) return this.skip(skipReason);

    // The rows were inserted middle, newest, oldest — so insertion order
    // and date order differ, and a route returning natural order would fail
    // here rather than passing by luck.
    const ids = (await lookup(OPERATOR, PLAYER)).json().recentTransactions.map((t: { transactionId: string }) => t.transactionId);
    assert.deepEqual(ids, ["tx-newest", "tx-middle", "tx-oldest"]);
  });

  it("orders rounds newest first, like the transactions beside them", async function () {
    if (!client) return this.skip(skipReason);

    // Found by mutation testing: reversing the rounds sort survived every
    // other test, because the fixture held a single round for this player
    // and one row is in order whatever the order is. The two rounds now
    // disagree between insertion order and date order, so this fails if the
    // sort is dropped or reversed.
    //
    // It matters for the same reason as the transactions above: a support
    // agent reads the top of the list as "what just happened".
    const ids = (await lookup(OPERATOR, PLAYER)).json().recentRounds.map((r: { roundId: string }) => r.roundId);
    assert.deepEqual(ids, ["round-2", "round-1"]);
  });

  it("carries the seed and algorithm, so 'was that spin fair' is answerable", async function () {
    if (!client) return this.skip(skipReason);

    // The second question support gets. A round is replayable from exactly
    // these two fields; withholding them would mean every fairness query
    // needs a developer.
    const round = (await lookup(OPERATOR, PLAYER)).json().recentRounds.find(
      (r: { roundId: string }) => r.roundId === "round-1",
    );
    assert.equal(round.seed, "seed-abc");
    assert.equal(round.rngAlgorithm, "xoshiro256ss-d16");
  });

  it("says whether it is showing everything, rather than leaving it ambiguous", async function () {
    if (!client) return this.skip(skipReason);

    // A list of exactly the limit is ambiguous between "that is all" and
    // "there are more", and an agent reading the second as the first would
    // tell a customer something untrue.
    const body = (await lookup(OPERATOR, PLAYER)).json();
    assert.equal(body.truncated.transactions, false);
    assert.equal(body.truncated.rounds, false);
    assert.equal(body.limit, 50);
  });

  it("reports truncation when there is more history than it shows", async function () {
    if (!client) return this.skip(skipReason);

    const busyPlayer = `busy-${randomUUID().slice(0, 8)}`;
    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId: busyPlayer, balance: 0 });
    await db.collection("transactions").insertMany(
      Array.from({ length: 55 }, (_, i) => ({
        transactionId: `busy-tx-${i}`,
        operatorId: OPERATOR,
        playerId: busyPlayer,
        type: "debit",
        amount: 1,
        balanceAfter: 0,
        status: "completed",
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, i)),
      })),
    );

    const body = (await lookup(OPERATOR, busyPlayer)).json();
    assert.equal(body.recentTransactions.length, 50, "capped at the limit");
    assert.equal(body.truncated.transactions, true, "and says so");
  });
});

describe("tenant scoping", () => {
  it("never shows another operator's player of the same id", async function () {
    if (!client) return this.skip(skipReason);

    // The same playerId exists under both operators with different
    // balances, so a missing operator filter returns visibly wrong data
    // rather than nothing.
    const body = (await lookup(OPERATOR, PLAYER)).json();

    assert.equal(body.player.balance, 12_345, "not the other operator's 99,999");
    assert.equal(
      body.recentTransactions.some((t: { transactionId: string }) => t.transactionId === "tx-other-operator"),
      false,
    );
    assert.equal(
      body.recentRounds.some((r: { roundId: string }) => r.roundId === "round-other"),
      false,
    );
  });

  it("looks up the same id under the other operator independently", async function () {
    if (!client) return this.skip(skipReason);

    const body = (await lookup(OTHER_OPERATOR, PLAYER)).json();
    assert.equal(body.player.balance, 99_999);
  });

  it("reports an unknown player as not found", async function () {
    if (!client) return this.skip(skipReason);

    // A 404 is safe here, unlike on the operator-facing API: this route is
    // behind an authenticated backoffice session, so the caller is entitled
    // to know the player does not exist.
    const response = await lookup(OPERATOR, "no-such-player");
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "player_not_found");
  });
});

describe("play limits on the lookup", () => {
  it("returns the player's limits and their current usage", async function () {
    if (!client) return this.skip(skipReason);

    // Support's third question — "I have money, why was I refused?" —
    // cannot be answered from a balance and a transaction list. Both the
    // ceiling and the counter have to come back, or the agent sees funds
    // and no reason for the refusal.
    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR,
      playerId: PLAYER,
      limits: [{ period: "daily", maxStake: 10_000 }],
    });
    await db.collection("playerLimitUsage").insertOne({
      operatorId: OPERATOR,
      playerId: PLAYER,
      period: "daily",
      periodKey: "2026-08-18",
      staked: 7_500,
      won: 2_000,
    });

    const body = (await lookup(OPERATOR, PLAYER, tokens.ops)).json();

    assert.deepEqual(body.limits, [{ period: "daily", maxStake: 10_000 }]);
    assert.equal(body.limitUsage.length, 1);
    assert.equal(body.limitUsage[0].staked, 7_500);
    assert.equal(body.limitUsage[0].won, 2_000);
  });

  it("answers with empty arrays for a player who has no limits", async function () {
    if (!client) return this.skip(skipReason);

    // Unlimited is the normal state. Omitting the fields would make the
    // screen's rendering conditional on their presence rather than on their
    // contents, which is a second way to be wrong.
    const body = (await lookup(OTHER_OPERATOR, PLAYER, tokens.ops)).json();

    assert.deepEqual(body.limits, []);
    assert.deepEqual(body.limitUsage, []);
  });
});

describe("limits that are mid-change", () => {
  it("reports what is enforced now, not what is stored", async function () {
    if (!client) return this.skip(skipReason);

    // Nothing runs when a loosening matures, so the stored set lags what
    // the money path applies. An agent quoting the stored ceiling would
    // tell a customer they are limited to an amount the engine no longer
    // enforces — and every screen would look correct while they did it.
    const player = "support-matured-limit";
    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId: player, balance: 1_000 });
    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR,
      playerId: player,
      limits: [{ period: "daily", maxStake: 1_000 }],
      pending: {
        limits: [{ period: "daily", maxStake: 9_000 }],
        effectiveAt: Date.now() - 1_000,
        requestedAt: Date.now() - 90_000_000,
      },
    });

    const body = (await lookup(OPERATOR, player, tokens.ops)).json();

    assert.deepEqual(body.limits, [{ period: "daily", maxStake: 9_000 }], "the matured ceiling is what applies");
    assert.equal(body.pendingLimitChange, undefined, "and it is no longer waiting");
  });

  it("shows a raise that is still waiting, so an agent is not surprised by it", async function () {
    if (!client) return this.skip(skipReason);

    const player = "support-pending-limit";
    const effectiveAt = Date.now() + 3_600_000;
    await db.collection("players").insertOne({ operatorId: OPERATOR, playerId: player, balance: 1_000 });
    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR,
      playerId: player,
      limits: [{ period: "daily", maxStake: 1_000 }],
      pending: { limits: [{ period: "daily", maxStake: 9_000 }], effectiveAt, requestedAt: Date.now() },
    });

    const body = (await lookup(OPERATOR, player, tokens.ops)).json();

    assert.deepEqual(body.limits, [{ period: "daily", maxStake: 1_000 }], "still held to the old ceiling");
    assert.equal(body.pendingLimitChange?.effectiveAt, effectiveAt);
  });
});
