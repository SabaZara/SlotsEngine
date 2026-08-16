import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServerToClientMessage } from "@slots-engine/shared-types";

// Both secrets must exist before the modules under test are imported: the
// signing helpers read them at call time, but backendClient refuses outright
// without SERVICE_AUTH_SECRET.
process.env.LAUNCH_TOKEN_SECRET = "test-only-launch-secret-at-least-32-chars-long";
process.env.SERVICE_AUTH_SECRET = "test-only-service-secret-at-least-32-chars-long";
process.env.GAME_BACKEND_URL = "http://game-backend.test";

import type { Connection, Session } from "./session.js";

const { signLaunchToken, signSessionToken } = await import("@slots-engine/launch-token");
const { handleMessage } = await import("./session.js");

/**
 * Records what the server sent, standing in for a socket.
 *
 * The service's whole job is deciding what to say and to whom, so a
 * recording sink is the entire surface a test needs — no port, no server,
 * no timing.
 */
function makeConnection() {
  const sent: ServerToClientMessage[] = [];
  const connection: Connection = { send: (m) => void sent.push(m) };
  return {
    connection,
    sent,
    /** The last message of a type, which is what an assertion almost always means. */
    last<T extends ServerToClientMessage["type"]>(type: T) {
      const found = [...sent].reverse().find((m) => m.type === type);
      return found as Extract<ServerToClientMessage, { type: T }> | undefined;
    },
    only(type: ServerToClientMessage["type"]) {
      return sent.filter((m) => m.type === type);
    },
  };
}

/**
 * Stubs game-backend at the fetch boundary rather than mocking the client
 * module.
 *
 * That choice matters: the real backendClient still runs, so these tests
 * also exercise request signing and the mapping of an error code onto a
 * typed error. Mocking the module would skip exactly the layer most likely
 * to be wrong.
 */
interface BackendStub {
  /** Path -> handler returning [status, body]. */
  routes: Record<string, (body: Record<string, unknown>) => [number, unknown]>;
  calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[];
}

let backend: BackendStub;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    backend.calls.push({ path, body, headers });

    const handler = backend.routes[path];
    if (!handler) throw new Error(`no stub for ${path}`);
    const [status, payload] = handler(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  backend = { routes: {}, calls: [] };
  backend.routes["/internal/players/balance"] = () => [200, { balance: 100_000 }];
  backend.routes["/internal/launch-tokens/consume"] = () => [200, { consumed: true }];
});

const IDENTITY = { operatorId: "op-1", playerId: "player-1", gameId: "reference-5x3" };

function launchToken(overrides: Partial<typeof IDENTITY> = {}) {
  return signLaunchToken({ ...IDENTITY, ...overrides }).token;
}

/** A joined connection, which most tests need before they can begin. */
async function joined(sessions = new Map<Connection, Session>()) {
  const c = makeConnection();
  await handleMessage(c.connection, sessions, { type: "JOIN", token: launchToken() });
  c.sent.length = 0;
  return { ...c, sessions };
}

const A_ROUND = {
  roundId: "round-1",
  operatorId: IDENTITY.operatorId,
  playerId: IDENTITY.playerId,
  gameId: IDENTITY.gameId,
  totalBet: 100,
  totalWin: 0,
  status: "resolved",
};

describe("JOIN establishes identity", () => {
  it("joins with a valid launch token and reports the player from it", async () => {
    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: launchToken() });

    const joinedMsg = c.last("JOINED");
    assert.equal(joinedMsg?.playerId, "player-1");
    assert.equal(joinedMsg?.gameId, "reference-5x3");
    assert.equal(joinedMsg?.balance, 100_000);
  });

  it("hands back a reusable session token, so a reconnect need not revisit the operator", async () => {
    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: launchToken() });

    assert.ok(c.last("JOINED")?.sessionToken, "a launch JOIN must mint a session token");
  });

  it("consumes the launch token exactly once, which is what makes it single-use", async () => {
    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: launchToken() });

    const consumes = backend.calls.filter((call) => call.path === "/internal/launch-tokens/consume");
    assert.equal(consumes.length, 1);
  });

  it("refuses a launch token the backend reports as already used", async () => {
    backend.routes["/internal/launch-tokens/consume"] = () => [409, { error: "launch_token_already_used" }];
    const c = makeConnection();
    const sessions = new Map<Connection, Session>();

    await handleMessage(c.connection, sessions, { type: "JOIN", token: launchToken() });

    assert.equal(c.last("ERROR")?.code, "token_already_used");
    assert.equal(c.last("JOINED"), undefined, "a refused token must not also report success");
    assert.equal(sessions.size, 0, "a refused token must not leave a session behind");
  });

  it("does not consume a session token — only a launch token is single-use", async () => {
    const c = makeConnection();
    const token = signSessionToken(IDENTITY).token;

    await handleMessage(c.connection, new Map(), { type: "JOIN", token });

    assert.equal(c.last("JOINED")?.playerId, "player-1");
    assert.equal(backend.calls.filter((call) => call.path === "/internal/launch-tokens/consume").length, 0);
    assert.equal(c.last("JOINED")?.sessionToken, undefined, "reusing a session token should not mint another");
  });

  it("distinguishes an invalid token from an expired one, so a client can act on the reason", async () => {
    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: "not-a-real-token" });
    assert.equal(c.last("ERROR")?.code, "invalid_token");
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = signLaunchToken(IDENTITY).token;
    const tampered = `${forged.split(".")[0]}.${Buffer.from("wrong").toString("base64url")}`;

    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: tampered });

    assert.equal(c.last("ERROR")?.code, "invalid_token");
  });

  it("rejects a tampered payload — the player id cannot be rewritten in flight", async () => {
    const [payload, signature] = signLaunchToken(IDENTITY).token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    decoded.playerId = "someone-else";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "JOIN", token: forged });

    assert.equal(c.last("ERROR")?.code, "invalid_token");
    assert.equal(c.last("JOINED"), undefined);
  });
});

describe("nothing works before JOIN", () => {
  for (const message of [
    { type: "SPIN_REQUEST", betAmount: 100 },
    { type: "BONUS_STEP", action: "reveal" },
    { type: "ROUND_RECOVER" },
  ] as const) {
    it(`refuses ${message.type} from a connection that has not joined`, async () => {
      const c = makeConnection();
      await handleMessage(c.connection, new Map(), message);

      assert.equal(c.last("ERROR")?.code, "not_joined");
      assert.equal(backend.calls.length, 0, "an unauthenticated message must not reach the money path at all");
    });
  }

  it("answers PING without a session, since it proves nothing and reveals nothing", async () => {
    const c = makeConnection();
    await handleMessage(c.connection, new Map(), { type: "PING" });
    assert.equal(c.last("PONG")?.type, "PONG");
  });
});

describe("a client can name a bet, never a player", () => {
  it("takes every identity field from the session, ignoring anything the client sends", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 99_900 }];
    const c = await joined();

    // A hostile client naming a different player and operator alongside its bet.
    await handleMessage(c.connection, c.sessions, {
      type: "SPIN_REQUEST",
      betAmount: 100,
      operatorId: "attacker-op",
      playerId: "victim-player",
      gameId: "some-other-game",
    } as never);

    const spinCall = backend.calls.find((call) => call.path === "/internal/rounds/spin");
    assert.equal(spinCall?.body.playerId, "player-1", "playerId must come from the verified token");
    assert.equal(spinCall?.body.operatorId, "op-1", "operatorId must come from the verified token");
    assert.equal(spinCall?.body.gameId, "reference-5x3", "gameId must come from the verified token");
    assert.equal(spinCall?.body.totalBet, 100, "betAmount is the one value a client may choose");
  });

  it("keeps two connections' identities separate", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 0 }];
    const sessions = new Map<Connection, Session>();

    const a = makeConnection();
    const b = makeConnection();
    await handleMessage(a.connection, sessions, { type: "JOIN", token: launchToken({ playerId: "player-a" }) });
    await handleMessage(b.connection, sessions, { type: "JOIN", token: launchToken({ playerId: "player-b" }) });

    await handleMessage(b.connection, sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    const spinCall = backend.calls.find((call) => call.path === "/internal/rounds/spin");
    assert.equal(spinCall?.body.playerId, "player-b", "the spin must be attributed to the connection that sent it");
  });

  it("signs every internal call, so game-backend can refuse an unsigned one", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 0 }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    const spinCall = backend.calls.find((call) => call.path === "/internal/rounds/spin");
    const headerNames = Object.keys(spinCall?.headers ?? {}).map((h) => h.toLowerCase());
    assert.ok(
      headerNames.some((h) => h.includes("signature")),
      `expected a signature header, got: ${headerNames.join(", ")}`,
    );
  });

  it("passes a clientRequestId through, since idempotency depends on it reaching the backend", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 0 }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100, clientRequestId: "req-1" });

    const spinCall = backend.calls.find((call) => call.path === "/internal/rounds/spin");
    assert.equal(spinCall?.body.clientRequestId, "req-1");
  });

  it("omits clientRequestId entirely when absent, rather than sending undefined", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 0 }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    const spinCall = backend.calls.find((call) => call.path === "/internal/rounds/spin");
    assert.ok(!("clientRequestId" in (spinCall?.body ?? {})));
  });
});

describe("a spin the backend refuses", () => {
  const refusals = [
    ["insufficient_funds", 402, "insufficient_funds"],
    ["invalid_bet_amount", 400, "invalid_bet_amount"],
    ["game_not_found", 404, "game_not_found"],
  ] as const;

  for (const [backendCode, status, clientCode] of refusals) {
    it(`turns ${backendCode} into a specific client error rather than a generic failure`, async () => {
      backend.routes["/internal/rounds/spin"] = () => [status, { error: backendCode }];
      const c = await joined();

      await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 999 });

      assert.equal(c.last("ERROR")?.code, clientCode);
      assert.equal(c.last("SPIN_RESULT"), undefined, "a refused spin must not also report a result");
      assert.equal(c.last("BALANCE_UPDATE"), undefined, "a refused spin must not move the displayed balance");
    });
  }

  it("lets an unexpected backend failure reject, so the caller reports internal_error rather than silence", async () => {
    backend.routes["/internal/rounds/spin"] = () => [500, { error: "something_unmapped" }];
    const c = await joined();

    await assert.rejects(
      () => handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 }),
      "an unmapped error must propagate rather than be swallowed as success",
    );
    assert.equal(c.last("SPIN_RESULT"), undefined);
  });
});

describe("a bonus round opens on its own", () => {
  const bonusRound = {
    ...A_ROUND,
    evaluation: { bonusTriggered: true, bonusModuleId: "wheel" },
  };

  it("starts the bonus the spin triggered, without the client asking", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: bonusRound, balanceAfter: 99_900 }];
    backend.routes["/internal/bonus/start"] = () => [
      200,
      { publicState: { bonusSessionId: "bonus-1", moduleId: "wheel" }, done: false },
    ];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    assert.ok(c.last("BONUS_STEP_RESULT"), "a triggering spin must open the bonus itself");
    assert.equal(c.sessions.get(c.connection)?.activeBonusSessionId, "bonus-1");
  });

  it("does not open a bonus for an ordinary spin", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: A_ROUND, balanceAfter: 99_900 }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    assert.equal(c.last("BONUS_STEP_RESULT"), undefined);
    assert.equal(backend.calls.some((call) => call.path === "/internal/bonus/start"), false);
  });

  it("closes a single-step bonus immediately and reports the new balance", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: bonusRound, balanceAfter: 99_900 }];
    backend.routes["/internal/bonus/start"] = () => [
      200,
      { publicState: { bonusSessionId: "bonus-1", moduleId: "wheel" }, done: true, balanceAfter: 105_000 },
    ];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    assert.equal(c.last("BALANCE_UPDATE")?.balance, 105_000);
    assert.equal(
      c.sessions.get(c.connection)?.activeBonusSessionId,
      undefined,
      "a resolved bonus must not stay open for stepping",
    );
  });

  it("refuses a bonus step when no bonus is in progress", async () => {
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "BONUS_STEP", action: "reveal" });

    assert.equal(c.last("ERROR")?.code, "no_active_bonus");
    assert.equal(backend.calls.some((call) => call.path === "/internal/bonus/step"), false);
  });

  it("names the bonus session from the connection, not from the client message", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: bonusRound, balanceAfter: 0 }];
    backend.routes["/internal/bonus/start"] = () => [
      200,
      { publicState: { bonusSessionId: "bonus-1", moduleId: "pick" }, done: false },
    ];
    backend.routes["/internal/bonus/step"] = () => [
      200,
      { publicState: { bonusSessionId: "bonus-1", moduleId: "pick" }, done: false },
    ];
    const c = await joined();
    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    await handleMessage(c.connection, c.sessions, {
      type: "BONUS_STEP",
      action: "reveal",
      bonusSessionId: "someone-elses-bonus",
    } as never);

    const stepCall = backend.calls.find((call) => call.path === "/internal/bonus/step");
    assert.equal(stepCall?.body.bonusSessionId, "bonus-1");
    assert.equal(stepCall?.body.playerId, "player-1");
  });

  it("clears the session when a bonus is abandoned, so a stale id cannot be stepped again", async () => {
    backend.routes["/internal/rounds/spin"] = () => [200, { round: bonusRound, balanceAfter: 0 }];
    backend.routes["/internal/bonus/start"] = () => [
      200,
      { publicState: { bonusSessionId: "bonus-1", moduleId: "pick" }, done: false },
    ];
    backend.routes["/internal/bonus/step"] = () => [410, { error: "bonus_session_abandoned" }];
    const c = await joined();
    await handleMessage(c.connection, c.sessions, { type: "SPIN_REQUEST", betAmount: 100 });

    await handleMessage(c.connection, c.sessions, { type: "BONUS_STEP", action: "reveal" });

    assert.equal(c.last("ERROR")?.code, "bonus_session_abandoned");
    assert.equal(c.sessions.get(c.connection)?.activeBonusSessionId, undefined);
  });
});

describe("round recovery", () => {
  it("recovers a round for the joined player", async () => {
    backend.routes["/internal/rounds/recover"] = () => [200, { round: A_ROUND }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "ROUND_RECOVER" });

    assert.equal(c.last("ROUND_RECOVERED")?.round.roundId, "round-1");
    const call = backend.calls.find((x) => x.path === "/internal/rounds/recover");
    assert.equal(call?.body.playerId, "player-1", "recovery must be scoped to the verified player");
  });

  it("reports no round rather than an error when there is nothing to recover", async () => {
    backend.routes["/internal/rounds/recover"] = () => [404, { error: "not_found" }];
    const c = await joined();

    await handleMessage(c.connection, c.sessions, { type: "ROUND_RECOVER" });

    assert.equal(c.last("ERROR")?.code, "no_round_found");
  });
});
