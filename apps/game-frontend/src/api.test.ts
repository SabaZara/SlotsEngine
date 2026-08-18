import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameClient, gameIdFromLaunchToken, type GameClientEvents } from "./api.js";

/**
 * The socket client, and specifically the three things `docs/TODO.md`
 * section C singled out as worth checking:
 *
 *   1. **The client never computes a win amount** — it renders what the
 *      server sent. Anything else is a second source of truth for money.
 *   2. **A stored session token must never substitute for a missing launch
 *      token**, and the reverse: a launch token is single-use, so reusing
 *      one on reconnect would be refused and send the player back to the
 *      lobby.
 *   3. **The client survives a 1013 (busy) close and a refused handshake**,
 *      both of which became reachable when the socket gained a connection
 *      ceiling and an origin check.
 *
 * The review assessed a *different* codebase's frontend, so those findings
 * needed checking here rather than assuming. Two turned out better than
 * claimed: neither frontend touches `localStorage` OR `sessionStorage` — the
 * session token lives in memory only, which is stronger than the review
 * credited.
 *
 * A fake WebSocket rather than a real one: these are assertions about what
 * this class *sends and stores*, not about the wire. The socket's own
 * behaviour is `game-socket/src/server.test.ts`'s subject, against a real
 * server.
 *
 * One mutation survives and is equivalent: replacing
 * `...(payload ? { payload } : {})` with a bare `payload` key. `JSON.stringify`
 * drops `undefined` values, so both forms produce byte-identical output —
 * verified, not assumed. The conditional spread is still the better code
 * (the object is correct before serialisation, not only after), but no test
 * can observe the difference through a socket.
 */

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

/** A WebSocket stand-in that records what was sent and lets a test drive
 * the events a real one would fire. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000 });
  }

  /** Drives an event as the browser would. */
  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }

  /** Delivers a server message. */
  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  get messages(): SentMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentMessage);
  }
}

const originalWebSocket = globalThis.WebSocket;

// `globalThis.crypto` is defined and getter-only from Node 19 on, and
// already provides `randomUUID` — the same API the browser gives this
// client. Nothing to stub, and attempting to assign it throws.

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

/** A client plus a record of every event it raised. */
function setup() {
  const seen = {
    joined: [] as Array<{ playerId: string; balance: number }>,
    spins: [] as unknown[],
    balances: [] as number[],
    bonus: [] as unknown[],
    errors: [] as Array<{ code: string; message: string }>,
    disconnects: 0,
  };

  const events: GameClientEvents = {
    onJoined: (payload) => seen.joined.push(payload),
    onSpinResult: (round) => seen.spins.push(round),
    onBalance: (balance) => seen.balances.push(balance),
    onBonusState: (state) => seen.bonus.push(state),
    onError: (code, message) => seen.errors.push({ code, message }),
    onDisconnected: () => (seen.disconnects += 1),
  };

  const client = new GameClient("ws://localhost:9003", events);
  return { client, seen, socketAt: (i = 0) => FakeWebSocket.instances[i] };
}

/** Connects and completes a JOIN handshake. */
function connected(token = "launch-token-1", sessionToken = "session-token-1") {
  const harness = setup();
  harness.client.connect(token);
  const socket = harness.socketAt();
  socket.emit("open");
  socket.receive({ type: "JOINED", playerId: "player-1", balance: 10_000, sessionToken });
  return { ...harness, socket };
}

describe("JOIN and the token it sends", () => {
  it("sends the launch token on a first connection", async () => {
    const { client, socketAt } = setup();
    client.connect("launch-token-1");
    const socket = socketAt();
    socket.emit("open");

    assert.deepEqual(socket.messages, [{ type: "JOIN", token: "launch-token-1" }]);
  });

  it("sends the SESSION token on a reconnect, not the launch token again", async () => {
    // A launch token is single-use. Sending it again after a reconnect is
    // refused by the backend, which would bounce the player back to the
    // casino lobby mid-session — the exact failure this substitution
    // prevents.
    const { client, socketAt } = connected("launch-token-1", "session-token-1");

    client.connect("launch-token-1");
    const second = socketAt(1);
    second.emit("open");

    assert.deepEqual(second.messages, [{ type: "JOIN", token: "session-token-1" }]);
  });

  it("keeps using the session token across repeated reconnects", async () => {
    const { client, socketAt } = connected("launch-token-1", "session-token-1");

    client.connect("launch-token-1");
    socketAt(1).emit("open");
    client.connect("launch-token-1");
    socketAt(2).emit("open");

    assert.deepEqual(socketAt(2).messages, [{ type: "JOIN", token: "session-token-1" }]);
  });

  it("falls back to the launch token when the server issued no session token", async () => {
    // The reverse of the substitution above: a stored token must never be
    // invented. If JOINED carried none, there is nothing to reuse and the
    // launch token is the only credential available.
    const { client, socketAt } = setup();
    client.connect("launch-token-1");
    const first = socketAt();
    first.emit("open");
    first.receive({ type: "JOINED", playerId: "player-1", balance: 10_000 });

    client.connect("launch-token-1");
    const second = socketAt(1);
    second.emit("open");

    assert.deepEqual(second.messages, [{ type: "JOIN", token: "launch-token-1" }]);
  });

  it("never writes the session token to browser storage", async () => {
    // A bearer token in localStorage or sessionStorage is readable by
    // anything else running on the page. It lives in memory only, and the
    // absence of any storage call is the property worth pinning — a future
    // "remember me" convenience is exactly how this regresses.
    const writes: string[] = [];
    const storage = {
      setItem: (key: string) => writes.push(key),
      getItem: () => null,
      removeItem: () => {},
    };
    (globalThis as { localStorage: unknown }).localStorage = storage;
    (globalThis as { sessionStorage: unknown }).sessionStorage = storage;

    try {
      connected("launch-token-1", "session-token-1");
      assert.deepEqual(writes, [], "no token may be written to browser storage");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe("what the client sends on the money path", () => {
  it("sends only a bet amount and a request id — never an identity", async () => {
    // The single most important property of this client. Identity lives
    // server-side, keyed to the socket and derived from a signed token; a
    // client that could name a player could spin someone else's balance.
    const { client, socket } = connected();
    client.spin(100);

    const spin = socket.messages.find((m) => m.type === "SPIN_REQUEST")!;

    assert.deepEqual(Object.keys(spin).sort(), ["betAmount", "clientRequestId", "type"]);
    for (const forbidden of ["playerId", "operatorId", "gameId", "balance", "token"]) {
      assert.equal(spin[forbidden], undefined, `a spin must never carry ${forbidden}`);
    }
  });

  it("sends a fresh request id per spin, so a retry is distinguishable from a new spin", async () => {
    const { client, socket } = connected();
    client.spin(100);
    client.spin(100);

    const ids = socket.messages.filter((m) => m.type === "SPIN_REQUEST").map((m) => m.clientRequestId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "two spins must not share an idempotency key");
  });

  it("sends a bonus step with no identity either", async () => {
    const { client, socket } = connected();
    client.bonusStep("pick", { tileIndex: 3 });

    const step = socket.messages.find((m) => m.type === "BONUS_STEP")!;
    assert.deepEqual(Object.keys(step).sort(), ["action", "payload", "type"]);
  });

  it("omits payload entirely when a bonus step has none", async () => {
    // `...(payload ? { payload } : {})` — an explicit `undefined` would
    // serialise away anyway, but an empty object would read as a payload
    // the module then has to interpret.
    const { client, socket } = connected();
    client.bonusStep("spin");

    const step = socket.messages.find((m) => m.type === "BONUS_STEP")!;
    assert.deepEqual(Object.keys(step).sort(), ["action", "type"]);
  });

  it("sends a round recovery with nothing but its type", async () => {
    const { client, socket } = connected();
    client.recoverRound();

    assert.deepEqual(
      socket.messages.find((m) => m.type === "ROUND_RECOVER"),
      { type: "ROUND_RECOVER" },
    );
  });
});

describe("what the client does with what it receives", () => {
  it("reports the server's balance rather than deriving one", async () => {
    // The client never computes a win. It renders what arrived, which is
    // why a rounding artefact in the UI can never become a money error.
    const { socket, seen } = connected();
    socket.receive({ type: "BALANCE_UPDATE", balance: 12_345 });

    assert.deepEqual(seen.balances, [12_345]);
  });

  it("passes a spin result through untouched", async () => {
    const { socket, seen } = connected();
    const round = { roundId: "r1", evaluation: { totalWin: 500 } };
    socket.receive({ type: "SPIN_RESULT", round });

    assert.deepEqual(seen.spins, [round]);
  });

  it("surfaces a server error with its code, so the UI can act on it", async () => {
    const { socket, seen } = connected();
    socket.receive({ type: "ERROR", code: "insufficient_funds", message: "Not enough balance." });

    assert.deepEqual(seen.errors, [{ code: "insufficient_funds", message: "Not enough balance." }]);
  });

  it("ignores a malformed message instead of throwing", async () => {
    // A parse error inside an event handler is an unhandled rejection that
    // takes the page's socket handling with it. Dropping the message keeps
    // the connection usable.
    const { socket, seen } = connected();

    socket.emit("message", { data: "not json at all" });
    socket.receive({ type: "BALANCE_UPDATE", balance: 999 });

    assert.deepEqual(seen.balances, [999], "the connection must still work after junk");
    assert.deepEqual(seen.errors, []);
  });

  it("ignores a message type it does not know", async () => {
    // Forward compatibility: a server that gains a message type must not
    // break older clients still in players' browsers.
    const { socket, seen } = connected();
    socket.receive({ type: "SOMETHING_NEW", data: 1 });

    assert.deepEqual(seen.errors, []);
    assert.equal(seen.balances.length, 0);
  });
});

describe("the connection lifecycle", () => {
  it("reports a disconnect when the server closes with 1013 (busy)", async () => {
    // Reachable since the socket gained a MAX_CONNECTIONS ceiling. The
    // client must notice and tell the UI rather than sitting on a dead
    // socket believing it is connected.
    const { socket, seen } = connected();
    socket.emit("close", { code: 1013, reason: "server busy" });

    assert.equal(seen.disconnects, 1);
  });

  it("reports a refused handshake as an error the UI can show", async () => {
    // Reachable since the socket gained an origin check (F8): a refused
    // handshake fires `error`, never `open`.
    const { client, socketAt, seen } = setup();
    client.connect("launch-token-1");
    socketAt().emit("error", {});

    assert.equal(seen.errors.length, 1);
    assert.equal(seen.errors[0].code, "connection_failed");
  });

  it("refuses to send on a socket that is not open, rather than throwing", async () => {
    // After a 1013 or a drop, a player pressing spin must get "not
    // connected" — not an exception that leaves the button dead.
    const { client, socket, seen } = connected();
    socket.readyState = FakeWebSocket.CLOSED;

    client.spin(100);

    assert.deepEqual(seen.errors, [{ code: "not_connected", message: "Not connected to the server." }]);
    assert.equal(
      socket.messages.filter((m) => m.type === "SPIN_REQUEST").length,
      0,
      "nothing may be sent on a closed socket",
    );
  });

  it("refuses to send before the connection has opened", async () => {
    const { client, seen } = setup();
    client.connect("launch-token-1");
    // No `open` yet — but the fake reports OPEN, so drive the real state.
    FakeWebSocket.instances[0].readyState = 0;

    client.spin(100);

    assert.equal(seen.errors[0]?.code, "not_connected");
  });

  it("closes the socket when asked", async () => {
    const { client, socket } = connected();
    client.close();

    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  });
});

describe("reading the game id out of a launch token", () => {
  const tokenFor = (payload: unknown) => {
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${b64}.signature-not-checked-here`;
  };

  it("reads the id the operator signed, rather than falling back to a default", () => {
    // The bug this pins: the id was read from a `gameId` query parameter
    // that a launch URL does not carry, so every game rendered as the
    // hardcoded reference-5x3 default — right board, wrong game.
    assert.equal(gameIdFromLaunchToken(tokenFor({ gameId: "gold-rush-5x3", playerId: "p" })), "gold-rush-5x3");
  });

  it("returns null for a token carrying no game id, rather than inventing one", () => {
    assert.equal(gameIdFromLaunchToken(tokenFor({ playerId: "p" })), null);
  });

  it("returns null for a malformed token rather than throwing into start-up", () => {
    // A throw here would kill the boot path before the caller's own guard
    // could report `invalid_token` in a way a player can act on.
    assert.equal(gameIdFromLaunchToken("not-a-token"), null);
    assert.equal(gameIdFromLaunchToken(""), null);
    assert.equal(gameIdFromLaunchToken("%%%.sig"), null);
  });

  it("ignores a non-string game id, which a hand-edited token could carry", () => {
    assert.equal(gameIdFromLaunchToken(tokenFor({ gameId: 42 })), null);
    assert.equal(gameIdFromLaunchToken(tokenFor({ gameId: "" })), null);
  });
});
