// A player must be funded to spin at all. Set explicitly rather than
// inherited from a default: `INITIAL_PLAYER_BALANCE` now defaults to 0 so
// that forgetting to configure a money default costs nothing in production
// (docs/TODO.md item H), which makes funding a test player the test's own
// job. Set before the imports below, since the ledger reads it per call.
process.env.INITIAL_PLAYER_BALANCE = "1000000";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensurePlayer, getBalance } from "@slots-engine/ledger";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../testing/fakeMongo.js";
import { spinRound } from "./service.js";

const OPERATOR = "op-1";
const PLAYER = "new-player";

/**
 * Regression tests for a bug the end-to-end run caught and the unit tests
 * originally missed: `getBalance` returns 0 for a player who has no
 * document yet, but the spin path calls `ensurePlayer` first and funds
 * them. A client asking for a balance before its first spin was therefore
 * told 0, then watched its first spin debit from a funded balance — the
 * displayed number disagreeing with the number that actually paid.
 *
 * The unit tests missed it because every one of them seeded a player
 * first. Worth remembering: a fixture that sets up the happy state can hide
 * the bug that only exists before that state is reached.
 */
describe("balance for a player who has never spun", () => {
  it("reads the same starting balance the first spin will debit from", async () => {
    const { db, client } = fakeMongo();

    await ensurePlayer(db, OPERATOR, PLAYER);
    const balanceAtJoin = await getBalance(db, OPERATOR, PLAYER);

    const { balanceAfter, round } = await spinRound(db, client, REFERENCE_GAME, {
      operatorId: OPERATOR,
      playerId: PLAYER,
      totalBet: 100,
    });

    assert.ok(balanceAtJoin > 0, "a first-time player must be funded before their balance is reported");
    assert.equal(
      balanceAfter,
      balanceAtJoin - 100 + (round.evaluation?.totalWin ?? 0),
      "the balance shown at join must be the one the first spin moves",
    );
  });

  it("ensurePlayer never changes an existing balance", async () => {
    const { db, raw } = fakeMongo();
    raw.collection("players").insertOne({ operatorId: OPERATOR, playerId: PLAYER, balance: 4242, updatedAt: new Date() });

    // Called on every balance read, so it must be safe to repeat.
    await ensurePlayer(db, OPERATOR, PLAYER);
    await ensurePlayer(db, OPERATOR, PLAYER);

    assert.equal(await getBalance(db, OPERATOR, PLAYER), 4242);
  });

  it("does not create a player merely by reading an unknown balance", async () => {
    // `getBalance` itself stays a pure read; it is the route that decides
    // to ensure first. Keeping the read side-effect-free means an
    // administrative balance query can't conjure funded players.
    const { db, raw } = fakeMongo();
    assert.equal(await getBalance(db, OPERATOR, "someone-who-never-existed"), 0);
    assert.equal(raw.collection("players").all().length, 0);
  });
});
