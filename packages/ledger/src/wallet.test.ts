import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { fakeMongo } from "../../../apps/game-backend/src/testing/fakeMongo.js";
import {
  creditWithinSession,
  debitWithinSession,
  withLedgerTransaction,
  InsufficientFundsError,
  InvalidAmountError,
} from "./wallet.js";

/**
 * Direct tests for the ledger primitives.
 *
 * These were reached only through the spin and bonus paths before, which
 * means every case those paths do not happen to exercise — a float amount,
 * a credit to a player who does not exist yet, a duplicate id racing the
 * unique index — was untested on the code that moves all the money in the
 * system.
 *
 * **What this file cannot establish.** `fakeMongo` deliberately does not
 * model rollback: `withTransaction` runs the callback and lets a throw
 * propagate without undoing prior writes. So nothing here proves atomicity
 * across a multi-step operation — that needs a live database, and the
 * money-path load check is what covers it. What these tests do cover is
 * every decision `applyLedgerOp` makes on its own.
 */

const OPERATOR = "op-1";
const PLAYER = "player-1";

function setup(balance?: number) {
  const { db, client, raw } = fakeMongo();
  if (balance !== undefined) {
    raw.collection("players").insertOne({ operatorId: OPERATOR, playerId: PLAYER, balance, updatedAt: new Date() });
  }
  // The (operatorId, transactionId) unique index that the exactly-once
  // guarantee actually rests on is declared by `fakeMongo` itself, matching
  // the real schema — so these tests run against the same constraint the
  // shipped system has rather than a weaker one.
  return { db, client, raw };
}

const op = (overrides: Partial<Parameters<typeof debitWithinSession>[2]> = {}) => ({
  operatorId: OPERATOR,
  playerId: PLAYER,
  transactionId: "round-1:debit",
  amount: 100,
  ...overrides,
});

/** Runs one ledger op inside the fake's transaction plumbing. */
const run = <T>(ctx: ReturnType<typeof setup>, fn: (session: never) => Promise<T>) =>
  withLedgerTransaction(ctx.client as never, fn as never) as Promise<T>;

describe("amount validation — the check that stops a float corrupting the ledger", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(10_000);
  });

  for (const bad of [1.5, 0.1, 100.0001, -1, 0, NaN, Infinity]) {
    it(`refuses ${bad} before writing anything`, async () => {
      await assert.rejects(
        () => run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: bad }))),
        InvalidAmountError,
      );

      // The important half: it must refuse *before* any write, or a
      // rejected op still leaves a transaction row or a moved balance.
      assert.equal(ctx.raw.collection("transactions").all().length, 0, "a refused amount must write no transaction");
      const player = await ctx.raw.collection("players").findOne({ playerId: PLAYER });
      assert.equal(player?.balance, 10_000, "a refused amount must not move the balance");
    });
  }

  it("accepts a whole number of minor units", async () => {
    const result = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 1 })));
    assert.equal(result.balanceAfter, 9_999);
  });

  it("applies the same rule to credits, not only debits", async () => {
    await assert.rejects(
      () => run(ctx, (s) => creditWithinSession(ctx.db, s, op({ amount: 0.5, transactionId: "c1" }))),
      InvalidAmountError,
    );
  });
});

describe("debit", () => {
  it("moves the balance by exactly the amount", async () => {
    const ctx = setup(10_000);
    const result = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 250 })));

    assert.equal(result.balanceAfter, 9_750);
    assert.equal(result.alreadyProcessed, false);
  });

  it("refuses to overdraw, leaving the balance untouched", async () => {
    const ctx = setup(50);
    await assert.rejects(
      () => run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 }))),
      InsufficientFundsError,
    );

    const player = await ctx.raw.collection("players").findOne({ playerId: PLAYER });
    assert.equal(player?.balance, 50);
    assert.equal(ctx.raw.collection("transactions").all().length, 0);
  });

  it("allows spending the balance down to exactly zero", async () => {
    // The boundary: `<` not `<=`, so a player may spend their last unit.
    const ctx = setup(100);
    const result = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));
    assert.equal(result.balanceAfter, 0);
  });

  it("refuses a debit for a player who does not exist", async () => {
    // Treated as insufficient funds rather than a distinct "no such player"
    // error: from the money path's point of view they are the same answer,
    // and distinguishing them would tell a caller which player ids are real.
    //
    // Note the second assertion is weaker than it looks, and knowingly so.
    // It passes because the funds check rejects before the upsert is
    // reached, so it does NOT pin the `upsert: type === "credit"` flag —
    // flipping that to `upsert: true` keeps every test here green. That
    // flag is a second statement of a rule this check already enforces, not
    // live logic; see the comment on it in wallet.ts.
    const ctx = setup();
    await assert.rejects(() => run(ctx, (s) => debitWithinSession(ctx.db, s, op())), InsufficientFundsError);
    assert.equal(ctx.raw.collection("players").all().length, 0, "a refused debit must leave no player behind");
  });

  it("records a transaction carrying the resulting balance", async () => {
    const ctx = setup(10_000);
    await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 300, roundId: "round-1" })));

    const tx = await ctx.raw.collection("transactions").findOne({ transactionId: "round-1:debit" });
    assert.equal(tx?.type, "debit");
    assert.equal(tx?.amount, 300, "the transaction records the amount, always positive");
    assert.equal(tx?.balanceAfter, 9_700, "and the balance it produced, for reconciliation");
    assert.equal(tx?.roundId, "round-1");
    assert.equal(tx?.status, "completed");
  });

  it("omits roundId entirely when the op is not round-scoped", async () => {
    // Written as an absent key rather than `undefined`, so the stored
    // document does not carry a null field the schema does not expect.
    const ctx = setup(10_000);
    await run(ctx, (s) => debitWithinSession(ctx.db, s, op()));

    const tx = await ctx.raw.collection("transactions").findOne({ transactionId: "round-1:debit" });
    assert.ok(!("roundId" in (tx as object)), "an absent roundId must not be stored as a key");
  });
});

describe("credit", () => {
  it("adds to an existing balance", async () => {
    const ctx = setup(10_000);
    const result = await run(ctx, (s) => creditWithinSession(ctx.db, s, op({ amount: 500, transactionId: "c1" })));
    assert.equal(result.balanceAfter, 10_500);
  });

  it("creates the player when they do not exist yet", async () => {
    // A first cash-in is a legitimate way for a player to come into being.
    const ctx = setup();
    const result = await run(ctx, (s) => creditWithinSession(ctx.db, s, op({ amount: 700, transactionId: "c1" })));

    assert.equal(result.balanceAfter, 700);
    const player = await ctx.raw.collection("players").findOne({ playerId: PLAYER });
    assert.equal(player?.balance, 700);
  });
});

describe("idempotency — the same transactionId must never pay twice", () => {
  it("returns the original result without re-applying the balance change", async () => {
    const ctx = setup(10_000);
    const first = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));
    const second = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));

    assert.equal(first.alreadyProcessed, false);
    assert.equal(second.alreadyProcessed, true, "the retry must be reported as already processed");
    assert.equal(second.balanceAfter, first.balanceAfter, "and must report the original balance");

    const player = await ctx.raw.collection("players").findOne({ playerId: PLAYER });
    assert.equal(player?.balance, 9_900, "a retried debit must charge exactly once");
    assert.equal(ctx.raw.collection("transactions").all().length, 1);
  });

  it("is scoped per operator, so two operators may reuse an id", async () => {
    // The unique index is compound on (operatorId, transactionId). A
    // global id space would make one operator's ids collide with another's.
    const ctx = setup(10_000);
    ctx.raw
      .collection("players")
      .insertOne({ operatorId: "op-2", playerId: PLAYER, balance: 10_000, updatedAt: new Date() });

    await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));
    const other = await run(ctx, (s) =>
      debitWithinSession(ctx.db, s, { ...op({ amount: 100 }), operatorId: "op-2" }),
    );

    assert.equal(other.alreadyProcessed, false, "a different operator's identical id is a different transaction");
    assert.equal(ctx.raw.collection("transactions").all().length, 2);
  });

  it("does not let a credit reuse a debit's id", async () => {
    // `${roundId}:debit` and `${roundId}:credit` are distinct by
    // convention; this pins that the ids, not the types, are what separate
    // them — a credit reusing the debit's id must be treated as a replay.
    const ctx = setup(10_000);
    await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));
    const credit = await run(ctx, (s) => creditWithinSession(ctx.db, s, op({ amount: 100 })));

    assert.equal(credit.alreadyProcessed, true);
    const player = await ctx.raw.collection("players").findOne({ playerId: PLAYER });
    assert.equal(player?.balance, 9_900, "a reused id must not pay out");
  });

  it("is enforced by the unique index, not only by the in-flight check", async () => {
    // The read-then-write check cannot survive two callers interleaving, so
    // the index is the real backstop. Simulated here by inserting the
    // transaction row directly — the state a racing caller would have
    // created between this op's check and its write.
    const ctx = setup(10_000);
    await ctx.raw.collection("transactions").insertOne({
      transactionId: "round-1:debit",
      operatorId: OPERATOR,
      playerId: PLAYER,
      type: "debit",
      amount: 100,
      balanceAfter: 9_900,
      status: "completed",
      createdAt: new Date(),
    });

    const result = await run(ctx, (s) => debitWithinSession(ctx.db, s, op({ amount: 100 })));
    assert.equal(result.alreadyProcessed, true);
    assert.equal(result.balanceAfter, 9_900, "the replay reports the balance the original produced");
    assert.equal(ctx.raw.collection("transactions").all().length, 1, "no second row may be written");
  });
});

describe("withLedgerTransaction", () => {
  it("returns whatever the callback produced", async () => {
    const ctx = setup(10_000);
    const value = await withLedgerTransaction(ctx.client as never, async () => "done");
    assert.equal(value, "done");
  });

  it("propagates a throw rather than swallowing it", async () => {
    const ctx = setup(10_000);
    await assert.rejects(
      () =>
        withLedgerTransaction(ctx.client as never, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
  });

  it("refuses to return silently when the callback produced nothing", async () => {
    // A committed transaction with no result means the callback never ran
    // to completion. Returning `undefined` would hand the caller a value it
    // would treat as a balance.
    const ctx = setup(10_000);
    await assert.rejects(
      () => withLedgerTransaction(ctx.client as never, async () => undefined),
      /without producing a result/,
    );
  });
});
