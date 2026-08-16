import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { signServiceRequest } from "@slots-engine/service-auth";
import { PICK_BONUS_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../testing/fakeMongo.js";
import { buildApp } from "../app.js";
import { seedReferenceGame } from "../rounds/games.js";

/**
 * The bonus routes' HTTP boundary.
 *
 * The mapping worth isolating is **410 versus 404**, which is F12's
 * outcome: `bonus_session_abandoned` means the session genuinely existed and
 * timed out, while `bonus_session_not_found` means it never did. A player
 * asking where their bonus went deserves "that bonus round timed out" rather
 * than "no such session", and only the status code carries that difference
 * to the client.
 *
 * `PICK_BONUS_GAME` is seeded directly here rather than through
 * `SEED_TEST_FIXTURES`. It is a test instrument, not a game — its bonus
 * triggers constantly so a multi-step session is reachable in one spin
 * instead of a few hundred, which makes its return meaningless and is why
 * production refuses it.
 *
 * What these cannot establish:
 *   - The atomic claim under concurrent steps. Exactly one caller winning a
 *     step rests on a real `findOneAndUpdate` against real Mongo; that is
 *     `e2e:load` section 4, and `fakeMongo` models no transaction.
 *   - That the sweep ever runs. F12's fix was to stop depending on it —
 *     the deadline is checked on every read — and the abandoned test below
 *     backdates a session precisely to prove the read path refuses without
 *     any sweep having happened.
 */

const logger = createLogger("bonus-route-test");
const silentLogger = { ...logger, info: () => {}, warn: () => {}, error: () => {} } as unknown as typeof logger;

const SECRET = "a-test-service-secret-long-enough-to-pass";
const OPERATOR = "op-1";

async function setup() {
  const { db, client } = fakeMongo();
  await seedReferenceGame(db as never);
  // Seeded unconditionally: this suite needs a bonus that always triggers.
  await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
    .collection("games")
    .insertOne({ ...PICK_BONUS_GAME });

  const app = await buildApp({
    db: db as never,
    client: client as never,
    serviceSecret: SECRET,
    logger: silentLogger,
    corsOrigins: ["http://localhost:9104"],
    rateLimitMax: 100_000,
  });
  await app.ready();
  return { app, db };
}

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

/** Spins the pick-bonus game until a bonus triggers, returning the round. */
async function spinUntilBonus(app: FastifyInstance, playerId: string) {
  for (let i = 0; i < 50; i++) {
    const response = await post(app, "/internal/rounds/spin", {
      operatorId: OPERATOR,
      playerId,
      gameId: PICK_BONUS_GAME.gameId,
      totalBet: 100,
    });
    const round = (response.json() as { round: Record<string, unknown> }).round;
    const evaluation = round.evaluation as { bonusTriggered?: boolean; bonusModuleId?: string };
    if (evaluation?.bonusTriggered) return { round, moduleId: evaluation.bonusModuleId as string };
  }
  throw new Error("the pick-bonus fixture never triggered a bonus in 50 spins");
}

/** Starts a bonus session and returns its id. */
async function startSession(app: FastifyInstance, playerId: string) {
  const { round, moduleId } = await spinUntilBonus(app, playerId);
  const response = await post(app, "/internal/bonus/start", {
    operatorId: OPERATOR,
    playerId,
    gameId: PICK_BONUS_GAME.gameId,
    roundId: round.roundId,
    moduleId,
    totalBet: 100,
  });
  assert.equal(response.statusCode, 200, `starting a bonus should succeed, got ${response.body}`);
  // The session id is nested under `publicState`, which is the shape the
  // socket relays to the client — not a flat field on the response.
  const body = response.json() as {
    publicState: { bonusSessionId: string; status: string; view?: Record<string, unknown> };
    done: boolean;
  };
  return { bonusSessionId: body.publicState.bonusSessionId, done: body.done, publicState: body.publicState };
}

describe("POST /internal/bonus/start", () => {
  it("starts a session for a round that actually triggered a bonus", async () => {
    // Load-bearing: without a passing case every refusal below could pass
    // against a route that refused everything.
    const { app } = await setup();
    const session = await startSession(app, "player-start");
    await app.close();

    assert.ok(session.bonusSessionId, "a started bonus must name its session");
  });

  describe("the required fields", () => {
    for (const missing of ["operatorId", "playerId", "gameId", "roundId", "moduleId"]) {
      it(`refuses a start with no ${missing}`, async () => {
        const { app } = await setup();
        const body: Record<string, unknown> = {
          operatorId: OPERATOR,
          playerId: "p",
          gameId: PICK_BONUS_GAME.gameId,
          roundId: "r",
          moduleId: "m",
          totalBet: 100,
        };
        delete body[missing];

        const response = await post(app, "/internal/bonus/start", body);
        await app.close();

        assert.equal(response.statusCode, 400);
        assert.match(response.json().error, /required/);
      });
    }

    it("refuses a fractional or non-positive bet, as the spin route does", async () => {
      // A bonus is scored as a multiple of the triggering bet, so a bad bet
      // here corrupts a payout rather than a stake.
      const { app } = await setup();

      for (const totalBet of [100.5, 0, -100, undefined, "100"]) {
        const response = await post(app, "/internal/bonus/start", {
          operatorId: OPERATOR,
          playerId: "p",
          gameId: PICK_BONUS_GAME.gameId,
          roundId: "r",
          moduleId: "m",
          totalBet,
        });
        assert.equal(response.statusCode, 400, `totalBet ${String(totalBet)} must be refused`);
        assert.match(response.json().error, /positive integer in minor units/);
      }
      await app.close();
    });
  });

  it("maps an unknown game to 404", async () => {
    const { app } = await setup();
    const response = await post(app, "/internal/bonus/start", {
      operatorId: OPERATOR,
      playerId: "p",
      gameId: "no-such-game",
      roundId: "r",
      moduleId: "m",
      totalBet: 100,
    });
    await app.close();

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "game_not_found");
  });

  it("requires a signature", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/bonus/start",
      payload: { operatorId: OPERATOR },
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});

describe("POST /internal/bonus/step", () => {
  it("advances a live session", async () => {
    const { app } = await setup();
    const session = await startSession(app, "player-step");

    const response = await post(app, "/internal/bonus/step", {
      operatorId: OPERATOR,
      playerId: "player-step",
      gameId: PICK_BONUS_GAME.gameId,
      bonusSessionId: session.bonusSessionId,
      action: "pick",
      payload: { tileIndex: 0 },
    });
    await app.close();

    assert.equal(response.statusCode, 200, `a valid step should succeed, got ${response.body}`);
  });

  describe("the required fields", () => {
    for (const missing of ["operatorId", "playerId", "gameId", "bonusSessionId", "action"]) {
      it(`refuses a step with no ${missing}`, async () => {
        const { app } = await setup();
        const body: Record<string, unknown> = {
          operatorId: OPERATOR,
          playerId: "p",
          gameId: PICK_BONUS_GAME.gameId,
          bonusSessionId: "s",
          action: "pick",
        };
        delete body[missing];

        const response = await post(app, "/internal/bonus/step", body);
        await app.close();

        assert.equal(response.statusCode, 400);
        assert.match(response.json().error, /required/);
      });
    }
  });

  describe("the typed error mappings", () => {
    it("maps an unknown game to 404", async () => {
      const { app } = await setup();
      const response = await post(app, "/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId: "p",
        gameId: "no-such-game",
        bonusSessionId: "s",
        action: "pick",
      });
      await app.close();

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "game_not_found");
    });

    it("maps a session that never existed to 404 bonus_session_not_found", async () => {
      const { app } = await setup();
      const response = await post(app, "/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId: "p",
        gameId: PICK_BONUS_GAME.gameId,
        bonusSessionId: "no-such-session",
        action: "pick",
      });
      await app.close();

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "bonus_session_not_found");
    });

    it("maps an expired session to 410, not 404 — F12's distinction", async () => {
      // The session genuinely existed and timed out, which is a different
      // thing for a client to explain to a player than "no such session".
      //
      // The deadline is backdated directly and the sweep is never run, which
      // is the point of F12's fix: expiry is a property of the data, not of
      // a process being alive. If this route depended on the sweep, this
      // test would get a 200 and a paid-out bonus.
      const { app, db } = await setup();
      const playerId = "player-expired";
      const session = await startSession(app, playerId);

      await (
        db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } }
      )
        .collection("bonusSessions")
        .updateOne(
          { bonusSessionId: session.bonusSessionId },
          { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } },
        );

      const response = await post(app, "/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId,
        gameId: PICK_BONUS_GAME.gameId,
        bonusSessionId: session.bonusSessionId,
        action: "pick",
        payload: { tileIndex: 0 },
      });
      await app.close();

      assert.equal(response.statusCode, 410, "an expired session must be 410, distinguishable from 404");
      assert.equal(response.json().error, "bonus_session_abandoned");
    });

    it("keeps the expired session's row intact rather than deleting it", async () => {
      // Deliberate, and the reason the TTL index in TODO item 5 was the
      // wrong fix: `abandoned` is a meaningful state, not garbage. Deleting
      // the row would turn a precise 410 into "no such session", which is
      // strictly worse information on a money path.
      const { app, db } = await setup();
      const playerId = "player-expired-row";
      const session = await startSession(app, playerId);

      await (
        db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } }
      )
        .collection("bonusSessions")
        .updateOne(
          { bonusSessionId: session.bonusSessionId },
          { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } },
        );

      await post(app, "/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId,
        gameId: PICK_BONUS_GAME.gameId,
        bonusSessionId: session.bonusSessionId,
        action: "pick",
        payload: { tileIndex: 0 },
      });

      const row = await (
        db as never as { collection: (n: string) => { findOne: (f: unknown) => Promise<unknown> } }
      )
        .collection("bonusSessions")
        .findOne({ bonusSessionId: session.bonusSessionId });
      await app.close();

      assert.ok(row, "the row must survive so a returning player gets a precise answer");
    });

    it("maps an invalid action to 400 with a reason", async () => {
      // A client sending a nonsense action gets told what was wrong; unlike
      // an internal error, this is safe to explain because the client
      // supplied it.
      const { app } = await setup();
      const playerId = "player-bad-action";
      const session = await startSession(app, playerId);

      const response = await post(app, "/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId,
        gameId: PICK_BONUS_GAME.gameId,
        bonusSessionId: session.bonusSessionId,
        action: "definitely-not-a-real-action",
      });
      await app.close();

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_bonus_action");
      assert.ok(response.json().message, "an invalid action should say what was wrong");
    });
  });

  it("does not let one player step another player's session", async () => {
    // The identity boundary at the route level. The session id alone must
    // not be enough to advance — and to pay out — someone else's bonus.
    const { app } = await setup();
    const session = await startSession(app, "player-owner");

    const response = await post(app, "/internal/bonus/step", {
      operatorId: OPERATOR,
      playerId: "player-thief",
      gameId: PICK_BONUS_GAME.gameId,
      bonusSessionId: session.bonusSessionId,
      action: "pick",
      payload: { tileIndex: 0 },
    });
    await app.close();

    assert.notEqual(response.statusCode, 200, "another player's session must not be steppable");
  });

  it("requires a signature", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/bonus/step",
      payload: { operatorId: OPERATOR },
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});
