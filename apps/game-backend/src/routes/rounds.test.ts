// A player must be funded to spin at all. Set explicitly rather than
// inherited from a default: `INITIAL_PLAYER_BALANCE` now defaults to 0 so
// that forgetting to configure a money default costs nothing in production
// (docs/TODO.md item H), which makes funding a test player the test's own
// job. Set before the imports below, since the ledger reads it per call.
process.env.INITIAL_PLAYER_BALANCE = "1000000";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { signServiceRequest } from "@slots-engine/service-auth";
import { fakeMongo } from "../testing/fakeMongo.js";
import { buildApp } from "../app.js";
import { seedReferenceGame } from "../rounds/games.js";

/**
 * The money path's HTTP boundary, at the level of individual branches.
 *
 * The three e2e suites already exercise these routes and are real coverage —
 * but an e2e failure names a *flow* ("spin flow check failed at step 5"),
 * takes a running stack, and cannot practically enumerate the error mappings.
 * This file names the rule: each typed domain error maps to one specific
 * status code, and a client that gets a 402 must be able to tell it apart
 * from a 400.
 *
 * That distinction is not cosmetic on a money path. `insufficient_funds` is
 * a state the player can fix by depositing; `invalid_bet_amount` is a bug in
 * the caller. Collapsing them tells a funded player their client is broken,
 * or an out-of-funds player to retry forever.
 *
 * Requests are signed properly rather than bypassing service-auth, so these
 * exercise the same path a real call takes.
 *
 * What these cannot establish:
 *   - Concurrency. Idempotency under simultaneous callers is `e2e:load`'s
 *     job and rests on a real unique index; `fakeMongo` models no
 *     transaction, which is how F1 and F14 got in.
 *   - Behaviour under the real schema validator — F9's blind spot.
 */

const logger = createLogger("rounds-route-test");
const silentLogger = { ...logger, info: () => {}, warn: () => {}, error: () => {} } as unknown as typeof logger;

const SECRET = "a-test-service-secret-long-enough-to-pass";
const OPERATOR = "op-1";

async function setup(): Promise<FastifyInstance> {
  const { db, client } = fakeMongo();
  await seedReferenceGame(db as never);

  const app = await buildApp({
    db: db as never,
    client: client as never,
    serviceSecret: SECRET,
    logger: silentLogger,
    corsOrigins: ["http://localhost:9104"],
    // High enough that no test here trips the limiter; the limiter has its
    // own tests in app.test.ts.
    rateLimitMax: 100_000,
  });
  await app.ready();
  return app;
}

/** A correctly signed internal POST, as game-socket would make it. */
function post(app: FastifyInstance, path: string, body: unknown) {
  const rawBody = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      ...signServiceRequest({ secret: SECRET, caller: "game-socket", method: "POST", path, rawBody }),
    },
    payload: rawBody,
  });
}

const spin = (app: FastifyInstance, body: unknown) => post(app, "/internal/rounds/spin", body);

const validSpin = (overrides: Record<string, unknown> = {}) => ({
  operatorId: OPERATOR,
  playerId: `player-${Math.random().toString(36).slice(2)}`,
  gameId: "reference-5x3",
  totalBet: 100,
  ...overrides,
});

describe("POST /internal/rounds/spin", () => {
  it("resolves a round for a valid request", async () => {
    // Load-bearing: without it, every rejection below would pass against a
    // route that refused everything.
    const app = await setup();
    const response = await spin(app, validSpin());
    await app.close();

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      round: { roundId: string; evaluation: { totalWin: number } };
      balanceAfter: number;
    };
    assert.ok(body.round.roundId, "a resolved spin must name its round");
    assert.ok(
      Number.isInteger(body.round.evaluation.totalWin),
      "totalWin must be integer minor units",
    );
    assert.ok(Number.isInteger(body.balanceAfter), "balanceAfter must be integer minor units");
  });

  describe("the required identity fields", () => {
    // The client can name a bet; it can never name a player — but the
    // socket must still supply all three, and a missing one is the caller's
    // bug rather than a server error.
    for (const missing of ["operatorId", "playerId", "gameId"]) {
      it(`refuses a request with no ${missing}`, async () => {
        const app = await setup();
        const body = validSpin();
        delete (body as Record<string, unknown>)[missing];

        const response = await spin(app, body);
        await app.close();

        assert.equal(response.statusCode, 400);
        assert.match(response.json().error, /required/);
      });
    }

    it("refuses an empty string as an identity, not just a missing key", async () => {
      // `!operatorId` catches both, and an empty operator would otherwise
      // create a player under a blank tenant.
      const app = await setup();
      const response = await spin(app, validSpin({ operatorId: "" }));
      await app.close();

      assert.equal(response.statusCode, 400);
    });

    it("refuses a request with an empty JSON body without throwing", async () => {
      // `request.body ?? {}` — the route must answer 400 rather than throw
      // a TypeError destructuring undefined, which would turn a malformed
      // call into a 500.
      //
      // Note a body-less request never gets this far: the signature covers
      // the body, so sending none fails service-auth with 401 first.
      // Measured, not assumed. That is correct — the signed empty object
      // below is the case this route actually has to handle.
      const app = await setup();
      const response = await spin(app, {});
      await app.close();

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /required/);
    });
  });

  describe("the bet amount", () => {
    it("refuses a fractional bet, which would corrupt the ledger", async () => {
      // Money is always integer minor units. A float reaches the ledger as
      // a fractional $inc and silently corrupts a balance — checked at the
      // boundary so the bad value travels no further.
      const app = await setup();
      const response = await spin(app, validSpin({ totalBet: 100.5 }));
      await app.close();

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /integer/);
    });

    it("refuses zero and negative bets at the boundary, before the domain", async () => {
      // A negative bet is a credit dressed as a spin.
      //
      // The status alone does not pin this: a zero bet that slipped past
      // the boundary check would still be refused by the domain as
      // `invalid_bet_amount`, also a 400. Asserting on the *message* is
      // what distinguishes "rejected here" from "rejected later" — and
      // relaxing `<= 0` to `< 0` survived until this did.
      const app = await setup();

      for (const totalBet of [0, -100]) {
        const response = await spin(app, validSpin({ totalBet }));
        assert.equal(response.statusCode, 400, `totalBet ${totalBet} must be refused`);
        assert.match(
          response.json().error,
          /positive integer in minor units/,
          `totalBet ${totalBet} must be refused at the boundary, not by the domain`,
        );
      }
      await app.close();
    });

    it("refuses a missing or non-numeric bet", async () => {
      const app = await setup();

      for (const totalBet of [undefined, "100", null, Number.NaN]) {
        const response = await spin(app, validSpin({ totalBet }));
        assert.equal(response.statusCode, 400, `totalBet ${String(totalBet)} must be refused`);
      }
      await app.close();
    });

    it("refuses a bet the game does not offer, as invalid_bet_amount", async () => {
      // Distinct from a malformed bet: this one is a well-formed integer the
      // client invented. The client cannot choose its own stake.
      const app = await setup();
      const response = await spin(app, validSpin({ totalBet: 137 }));
      await app.close();

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_bet_amount");
    });
  });

  describe("the typed error mappings", () => {
    it("maps an unknown game to 404, not to a generic failure", async () => {
      const app = await setup();
      const response = await spin(app, validSpin({ gameId: "no-such-game" }));
      await app.close();

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "game_not_found");
    });

    it("maps insufficient funds to 402, distinct from a bad request", async () => {
      // The distinction that matters most here. 402 is a state the player
      // can fix by depositing; 400 says their client is broken. A player
      // told the wrong one either retries forever or stops trying.
      //
      // The balance is set directly rather than gambled down. Draining by
      // spinning is a random walk at ~95% return, so it terminates only
      // probabilistically — the same problem `docs/TODO.md` item 8 records
      // for the load check, and a flaky test is worth less than a
      // deterministic one. 100 is a valid bet option and 50 cannot cover it.
      const { db, client } = fakeMongo();
      await seedReferenceGame(db as never);
      const app = await buildApp({
        db: db as never,
        client: client as never,
        serviceSecret: SECRET,
        logger: silentLogger,
        corsOrigins: ["http://localhost:9104"],
        rateLimitMax: 100_000,
      });
      await app.ready();

      const playerId = "broke-player";
      await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
        .collection("players")
        .insertOne({ operatorId: OPERATOR, playerId, balance: 50, updatedAt: new Date() });

      const response = await spin(app, validSpin({ playerId, totalBet: 100 }));
      await app.close();

      assert.equal(response.statusCode, 402);
      assert.equal(response.json().error, "insufficient_funds");
    });

    it("leaves the balance untouched when it refuses for insufficient funds", async () => {
      // A refused spin that still debited would be the worst outcome on
      // this path: the player pays for a round they never got.
      const { db, client } = fakeMongo();
      await seedReferenceGame(db as never);
      const app = await buildApp({
        db: db as never,
        client: client as never,
        serviceSecret: SECRET,
        logger: silentLogger,
        corsOrigins: ["http://localhost:9104"],
        rateLimitMax: 100_000,
      });
      await app.ready();

      const playerId = "broke-player-2";
      await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
        .collection("players")
        .insertOne({ operatorId: OPERATOR, playerId, balance: 50, updatedAt: new Date() });

      await spin(app, validSpin({ playerId, totalBet: 100 }));
      const after = await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId });
      await app.close();

      assert.equal(after.json().balance, 50, "a refused spin must move no money");
    });

    it("keeps 402 separate from 400 in the response body, not only the status", async () => {
      const app = await setup();
      const badRequest = await spin(app, validSpin({ totalBet: 137 }));
      await app.close();

      assert.notEqual(badRequest.json().error, "insufficient_funds");
    });
  });

  describe("idempotency", () => {
    it("returns the original round for a repeated clientRequestId, charging once", async () => {
      // Sequential replay only — two callers at the same instant is a
      // different guarantee resting on a real unique index, which is F14
      // and belongs to e2e:load.
      const app = await setup();
      const body = validSpin({ clientRequestId: "req-1" });

      const first = await spin(app, body);
      const balanceAfterFirst = await post(app, "/internal/players/balance", {
        operatorId: OPERATOR,
        playerId: body.playerId,
      });
      const second = await spin(app, body);
      const balanceAfterSecond = await post(app, "/internal/players/balance", {
        operatorId: OPERATOR,
        playerId: body.playerId,
      });
      await app.close();

      assert.equal(second.statusCode, 200);
      assert.equal(
        (second.json() as { round: { roundId: string } }).round.roundId,
        (first.json() as { round: { roundId: string } }).round.roundId,
        "a retry must return the original round, not roll a new one",
      );
      assert.equal(
        balanceAfterSecond.json().balance,
        balanceAfterFirst.json().balance,
        "a retry must not move the balance again",
      );
    });

    it("treats distinct clientRequestIds as distinct spins", async () => {
      const app = await setup();
      const playerId = "player-distinct";

      const first = await spin(app, validSpin({ playerId, clientRequestId: "req-a" }));
      const second = await spin(app, validSpin({ playerId, clientRequestId: "req-b" }));
      await app.close();

      assert.notEqual(
        (first.json() as { round: { roundId: string } }).round.roundId,
        (second.json() as { round: { roundId: string } }).round.roundId,
      );
    });
  });

  it("requires a signature, like every internal route", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/rounds/spin",
      payload: validSpin(),
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});

describe("POST /internal/rounds/recover", () => {
  it("replays the most recent round rather than rolling a new one", async () => {
    // Recovery must never re-roll: a player who reconnects mid-spin sees
    // the outcome that was already paid, not a fresh one.
    const app = await setup();
    const playerId = "player-recover";
    const spun = await spin(app, validSpin({ playerId }));

    const recovered = await post(app, "/internal/rounds/recover", { operatorId: OPERATOR, playerId });
    await app.close();

    assert.equal(recovered.statusCode, 200);
    const original = (spun.json() as { round: Record<string, unknown> }).round;
    const replayed = (recovered.json() as { round: Record<string, unknown> }).round;

    assert.equal(replayed.roundId, original.roundId);
    assert.deepEqual(replayed.evaluation, original.evaluation, "the same round must pay the same");
    assert.deepEqual(replayed.resultMatrix, original.resultMatrix, "the same round must show the same reels");
    assert.equal(replayed.seed, original.seed, "a replay must not re-roll — same seed, same outcome");
  });

  it("recovers a specific round when one is named", async () => {
    const app = await setup();
    const playerId = "player-specific";
    const first = await spin(app, validSpin({ playerId }));
    await spin(app, validSpin({ playerId }));

    const roundId = (first.json() as { round: { roundId: string } }).round.roundId;
    const recovered = await post(app, "/internal/rounds/recover", { operatorId: OPERATOR, playerId, roundId });
    await app.close();

    assert.equal((recovered.json() as { round: { roundId: string } }).round.roundId, roundId);
  });

  it("404s a player who has never spun, rather than inventing a round", async () => {
    const app = await setup();
    const response = await post(app, "/internal/rounds/recover", {
      operatorId: OPERATOR,
      playerId: "never-played",
    });
    await app.close();

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "no_round_found");
  });

  it("does not return another player's round", async () => {
    // The identity boundary at the route level: recovery is scoped by
    // operator and player, and a roundId alone must not be enough.
    const app = await setup();
    const mine = await spin(app, validSpin({ playerId: "player-a" }));
    const roundId = (mine.json() as { round: { roundId: string } }).round.roundId;

    const response = await post(app, "/internal/rounds/recover", {
      operatorId: OPERATOR,
      playerId: "player-b",
      roundId,
    });
    await app.close();

    assert.equal(response.statusCode, 404, "another player's roundId must not resolve");
  });

  it("refuses a request missing an identity", async () => {
    const app = await setup();

    assert.equal((await post(app, "/internal/rounds/recover", { playerId: "p" })).statusCode, 400);
    assert.equal((await post(app, "/internal/rounds/recover", { operatorId: OPERATOR })).statusCode, 400);
    await app.close();
  });
});

describe("POST /internal/players/balance", () => {
  it("reports an integer balance for a first-time player", async () => {
    // `ensurePlayer` runs before the read, exactly as the spin path does.
    // Without it a first-time player is told 0 at JOIN and then sees their
    // first spin debit a funded balance — the number on screen disagreeing
    // with the number that pays.
    const app = await setup();
    const response = await post(app, "/internal/players/balance", {
      operatorId: OPERATOR,
      playerId: "brand-new-player",
    });
    await app.close();

    assert.equal(response.statusCode, 200);
    const { balance } = response.json() as { balance: number };
    assert.ok(Number.isInteger(balance), `balance ${balance} must be integer minor units`);
    assert.ok(balance > 0, "a first-time player is funded, and the read must say so");
  });

  it("reports the same balance the spin path debits from", async () => {
    // The invariant behind that comment: read and spin must agree.
    const app = await setup();
    const playerId = "player-balance";

    const before = (await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId })).json()
      .balance as number;
    const spun = await spin(app, validSpin({ playerId, totalBet: 100 }));
    const after = (await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId })).json()
      .balance as number;
    await app.close();

    const win = (spun.json() as { round: { evaluation: { totalWin: number } } }).round.evaluation.totalWin;
    assert.equal(after, before - 100 + win, "the balance must move by exactly win minus bet");
  });

  it("does not reset an existing balance on a repeated read", async () => {
    // `ensurePlayer` is an upsert that must never touch an existing
    // balance. If it did, every balance read would refund the player.
    const app = await setup();
    const playerId = "player-repeat-read";

    await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId });
    await spin(app, validSpin({ playerId, totalBet: 1000 }));
    const afterSpin = (await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId })).json()
      .balance as number;
    const afterSecondRead = (
      await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId })
    ).json().balance as number;
    await app.close();

    assert.equal(afterSecondRead, afterSpin, "reading a balance must not change it");
  });

  it("keeps balances separate per player and per operator", async () => {
    // Balances are set directly rather than moved by spinning. Comparing
    // two balances for inequality after a spin is a coin flip when the win
    // happens to equal the bet — which made this test flaky in the full
    // suite while passing in isolation. The wallets' independence is the
    // subject; the random walk was incidental.
    const { db, client } = fakeMongo();
    await seedReferenceGame(db as never);
    const app = await buildApp({
      db: db as never,
      client: client as never,
      serviceSecret: SECRET,
      logger: silentLogger,
      corsOrigins: ["http://localhost:9104"],
      rateLimitMax: 100_000,
    });
    await app.ready();

    const playerId = "shared-name";
    const players = (
      db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } }
    ).collection("players");
    await players.insertOne({ operatorId: OPERATOR, playerId, balance: 5_000, updatedAt: new Date() });
    await players.insertOne({ operatorId: "op-2", playerId, balance: 9_900, updatedAt: new Date() });

    const first = (await post(app, "/internal/players/balance", { operatorId: OPERATOR, playerId })).json()
      .balance as number;
    const second = (await post(app, "/internal/players/balance", { operatorId: "op-2", playerId })).json()
      .balance as number;
    await app.close();

    assert.equal(first, 5_000);
    assert.equal(second, 9_900, "the same playerId under a different operator is a different wallet");
  });

  it("refuses a request missing an identity", async () => {
    const app = await setup();

    assert.equal((await post(app, "/internal/players/balance", { playerId: "p" })).statusCode, 400);
    assert.equal((await post(app, "/internal/players/balance", { operatorId: OPERATOR })).statusCode, 400);
    await app.close();
  });
});
