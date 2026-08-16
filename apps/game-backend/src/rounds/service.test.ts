import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { InsufficientFundsError } from "@slots-engine/ledger";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../testing/fakeMongo.js";
import { InvalidBetAmountError, recoverRound, spinRound } from "./service.js";

const OPERATOR = "op-1";
const PLAYER = "player-1";

function setup(balance = 100_000) {
  const { db, client, raw } = fakeMongo();
  raw.collection("players").insertOne({ operatorId: OPERATOR, playerId: PLAYER, balance, updatedAt: new Date() });
  return { db, client, raw };
}

const spinInput = (overrides: Record<string, unknown> = {}) => ({
  operatorId: OPERATOR,
  playerId: PLAYER,
  totalBet: 100,
  ...overrides,
});

describe("spinRound", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("debits the bet and records a resolved round", async () => {
    const { round, balanceAfter } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());

    assert.equal(round.status, "resolved");
    assert.equal(round.totalBet, 100);
    assert.equal(round.operatorId, OPERATOR);
    assert.equal(round.playerId, PLAYER);
    // Net movement is the win minus the bet, whatever the spin produced.
    assert.equal(balanceAfter, 100_000 - 100 + (round.evaluation?.totalWin ?? 0));
  });

  it("stores the seed and algorithm, so the round can be replayed for audit", async () => {
    const { round } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    assert.equal(typeof round.seed, "string");
    assert.equal(round.seed.length, 64, "a 32-byte seed, hex encoded");
    assert.equal(round.rngAlgorithm, "xoshiro256ss-d16");
  });

  it("records the game version the round actually ran under", async () => {
    const { round } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    assert.equal(round.gameVersion, REFERENCE_GAME.version);
  });

  it("rejects a bet the game does not offer, before any money moves", async () => {
    await assert.rejects(
      () => spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput({ totalBet: 137 })),
      InvalidBetAmountError,
    );
    const player = await ctx.raw.collection("players").findOne({ operatorId: OPERATOR, playerId: PLAYER });
    assert.equal(player?.balance, 100_000, "an invalid bet must not touch the balance");
    assert.equal(ctx.raw.collection("transactions").all().length, 0);
  });

  it("refuses a spin the player cannot afford", async () => {
    const poor = setup(50);
    await assert.rejects(
      () => spinRound(poor.db, poor.client, REFERENCE_GAME, spinInput()),
      InsufficientFundsError,
    );
  });

  it("writes a debit transaction for every spin", async () => {
    const { round } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const debit = await ctx.raw.collection("transactions").findOne({ transactionId: `${round.roundId}:debit` });
    assert.equal(debit?.amount, 100);
    assert.equal(debit?.type, "debit");
  });

  it("writes a credit only when the spin actually won", async () => {
    // Spin until each case has been observed, so both branches are covered
    // without depending on a lucky first draw.
    let sawWin = false;
    let sawLoss = false;
    for (let i = 0; i < 60 && !(sawWin && sawLoss); i++) {
      const { round } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
      const credit = await ctx.raw.collection("transactions").findOne({ transactionId: `${round.roundId}:credit` });
      if ((round.evaluation?.totalWin ?? 0) > 0) {
        sawWin = true;
        assert.equal(credit?.amount, round.evaluation?.totalWin);
      } else {
        sawLoss = true;
        assert.equal(credit, null, "a losing spin must not write a credit");
      }
    }
    assert.ok(sawWin && sawLoss, "expected both a win and a loss within 60 spins");
  });

  it("replays the original round for a retried clientRequestId, without charging twice", async () => {
    const first = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput({ clientRequestId: "req-1" }));
    const second = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput({ clientRequestId: "req-1" }));

    assert.equal(second.round.roundId, first.round.roundId, "a retry must return the original round");
    assert.deepEqual(second.round.evaluation, first.round.evaluation);
    const debits = ctx.raw.collection("transactions").all().filter((t) => t.type === "debit");
    assert.equal(debits.length, 1, "a retry must not debit a second time");
  });

  it("survives a concurrent double-submit of the same clientRequestId", async () => {
    // Both callers race; the unique index decides. The loser's transaction
    // rolls back, so the correct answer is the winning round — not an error.
    const [a, b] = await Promise.all([
      spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput({ clientRequestId: "req-concurrent" })),
      spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput({ clientRequestId: "req-concurrent" })),
    ]);
    assert.equal(a.round.roundId, b.round.roundId);
    assert.equal(ctx.raw.collection("rounds").all().length, 1);
  });

  it("treats spins without a clientRequestId as independent", async () => {
    const a = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const b = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    assert.notEqual(a.round.roundId, b.round.roundId);
    assert.equal(ctx.raw.collection("rounds").all().length, 2);
  });

  it("never produces a fractional balance", async () => {
    for (let i = 0; i < 30; i++) {
      const { balanceAfter } = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
      assert.ok(Number.isInteger(balanceAfter), `balance ${balanceAfter} is not an integer`);
    }
  });

  it("keeps the ledger reconciled with the balance across many spins", async () => {
    // The property that actually matters: the balance must equal the
    // starting balance plus every credit minus every debit, exactly.
    for (let i = 0; i < 50; i++) {
      await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    }
    const transactions = ctx.raw.collection("transactions").all();
    const net = transactions.reduce(
      (sum, t) => sum + (t.type === "credit" ? (t.amount as number) : -(t.amount as number)),
      0,
    );
    const player = await ctx.raw.collection("players").findOne({ operatorId: OPERATOR, playerId: PLAYER });
    assert.equal(player?.balance, 100_000 + net);
  });
});

describe("recoverRound", () => {
  it("returns the most recent round when none is named", async () => {
    const ctx = setup();
    await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const latest = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const recovered = await recoverRound(ctx.db, OPERATOR, PLAYER);
    assert.equal(recovered?.roundId, latest.round.roundId);
  });

  it("returns a specific round by id", async () => {
    const ctx = setup();
    const first = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const recovered = await recoverRound(ctx.db, OPERATOR, PLAYER, first.round.roundId);
    assert.equal(recovered?.roundId, first.round.roundId);
  });

  it("never re-rolls — recovery only re-reads what was already decided", async () => {
    const ctx = setup();
    const original = await spinRound(ctx.db, ctx.client, REFERENCE_GAME, spinInput());
    const recovered = await recoverRound(ctx.db, OPERATOR, PLAYER, original.round.roundId);
    assert.deepEqual(recovered?.evaluation, original.round.evaluation);
    assert.equal(recovered?.seed, original.round.seed);
  });

  it("returns null when a player has no rounds", async () => {
    const ctx = setup();
    assert.equal(await recoverRound(ctx.db, OPERATOR, "nobody"), null);
  });
});
