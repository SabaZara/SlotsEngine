import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeMongo } from "../../../apps/game-backend/src/testing/fakeMongo.js";
import { ensurePlayer, getBalance } from "./players.js";

/**
 * The starting balance a new player is created with.
 *
 * This is a money-path default, and it used to point the wrong way: it
 * granted 100,000 minor units when `INITIAL_PLAYER_BALANCE` was unset, which
 * quietly contradicted the comment above it AND defeated the boot guard next
 * door — `assertStartupConfig` refuses a positive value in production, so the
 * one configuration it pushed an operator toward was the one that still
 * handed out free money (item H in docs/TODO.md).
 *
 * The rule these tests exist to hold: **a missing configuration grants
 * nothing.** Forgetting to configure a money default must cost zero, not
 * a thousand currency units per player.
 *
 * What these cannot establish: behaviour under the real schema validator,
 * which is F9's blind spot — `fakeMongo` models none. The live-stack check
 * is recorded in the commit.
 */

const originalValue = process.env.INITIAL_PLAYER_BALANCE;

afterEach(() => {
  if (originalValue === undefined) delete process.env.INITIAL_PLAYER_BALANCE;
  else process.env.INITIAL_PLAYER_BALANCE = originalValue;
});

/** Creates a player under the given configuration and returns their balance. */
async function balanceWith(configured: string | undefined): Promise<number> {
  if (configured === undefined) delete process.env.INITIAL_PLAYER_BALANCE;
  else process.env.INITIAL_PLAYER_BALANCE = configured;

  const { db } = fakeMongo();
  await ensurePlayer(db as never, "op-1", "player-1");
  return getBalance(db as never, "op-1", "player-1");
}

describe("the starting balance", () => {
  it("grants nothing when INITIAL_PLAYER_BALANCE is unset", () => {
    // The whole point. In a real deployment a balance arrives via a cash-in
    // from the operator, so a default that grants anything is granting free
    // money to every player who ever connects.
    return balanceWith(undefined).then((balance) => assert.equal(balance, 0));
  });

  it("grants nothing for an explicit zero", async () => {
    assert.equal(await balanceWith("0"), 0);
  });

  it("grants the configured amount when one is set", async () => {
    // Local development sets this deliberately — compose passes
    // `${INITIAL_PLAYER_BALANCE:-100000}` — so the mechanism must still work.
    assert.equal(await balanceWith("100000"), 100_000);
  });

  it("grants nothing for a negative value rather than creating a debt", async () => {
    // A negative starting balance would put a player underwater before they
    // ever bet, and every affordability check against it would refuse.
    assert.equal(await balanceWith("-500"), 0);
  });

  it("grants nothing for a non-numeric value, rather than writing NaN", async () => {
    // `Number("abc")` is NaN. A NaN balance in `$setOnInsert` writes NaN to
    // the document, and every later comparison against it is false — the
    // player can neither bet nor be seen to have nothing.
    for (const junk of ["abc", "", "1e", "null"]) {
      const balance = await balanceWith(junk);
      assert.ok(Number.isFinite(balance), `INITIAL_PLAYER_BALANCE='${junk}' produced ${balance}`);
      assert.equal(balance, 0);
    }
  });

  it("floors a fractional value, because money is integer minor units", async () => {
    // A fractional balance reaches Mongo as a float and every later `$inc`
    // compounds the error — the exact corruption integer minor units exist
    // to prevent.
    const balance = await balanceWith("100.75");
    assert.equal(balance, 100);
    assert.ok(Number.isInteger(balance));
  });

  it("reads the configuration per call, not once at import", async () => {
    // Captured at module load, the value would depend on import order —
    // which makes it untestable and makes a deployment's behaviour depend on
    // when the module happened to be first required.
    assert.equal(await balanceWith("0"), 0);
    assert.equal(await balanceWith("5000"), 5_000);
    assert.equal(await balanceWith(undefined), 0);
  });
});

describe("ensurePlayer", () => {
  it("never touches an existing balance", async () => {
    // `$setOnInsert`, not `$set`. If this ever became a plain update, every
    // balance read on the spin path would refund the player to their
    // starting amount — and the read happens on every JOIN.
    process.env.INITIAL_PLAYER_BALANCE = "1000";
    const { db } = fakeMongo();

    await ensurePlayer(db as never, "op-1", "player-1");
    await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
      .collection("players")
      .updateOne({ operatorId: "op-1", playerId: "player-1" }, { $set: { balance: 250 } });

    await ensurePlayer(db as never, "op-1", "player-1");

    assert.equal(await getBalance(db as never, "op-1", "player-1"), 250, "an existing balance must survive");
  });

  it("does not re-grant the starting balance to a player who spent it", async () => {
    // The same property at its most dangerous value: a player who has bet
    // down to zero must not be topped back up by the next balance read.
    process.env.INITIAL_PLAYER_BALANCE = "1000";
    const { db } = fakeMongo();

    await ensurePlayer(db as never, "op-1", "player-1");
    await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
      .collection("players")
      .updateOne({ operatorId: "op-1", playerId: "player-1" }, { $set: { balance: 0 } });

    await ensurePlayer(db as never, "op-1", "player-1");

    assert.equal(await getBalance(db as never, "op-1", "player-1"), 0);
  });

  it("keeps one wallet per operator-and-player pair", async () => {
    // The same playerId under a different operator is a different person's
    // money.
    process.env.INITIAL_PLAYER_BALANCE = "1000";
    const { db } = fakeMongo();

    await ensurePlayer(db as never, "op-1", "shared-name");
    await ensurePlayer(db as never, "op-2", "shared-name");
    await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
      .collection("players")
      .updateOne({ operatorId: "op-1", playerId: "shared-name" }, { $set: { balance: 7 } });

    assert.equal(await getBalance(db as never, "op-1", "shared-name"), 7);
    assert.equal(await getBalance(db as never, "op-2", "shared-name"), 1_000);
  });
});

describe("getBalance", () => {
  it("reports zero for a player who does not exist, rather than throwing", async () => {
    // A balance query is a read: "no player" and "no money" are the same
    // answer to a caller, and throwing would turn a routine lookup into a
    // 500.
    const { db } = fakeMongo();
    assert.equal(await getBalance(db as never, "op-1", "nobody"), 0);
  });
});
