import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createLogger } from "@slots-engine/logging";
import { createSocketServer, type SocketServer } from "./server.js";
import type { Connection, Session } from "./session.js";
import type { OriginPolicy } from "./origin.js";

/**
 * The connection lifecycle, driven through a real server on an ephemeral
 * port with a real `ws` client.
 *
 * `session.ts`, `rateLimit.ts`, `origin.ts` and `backendClient.ts` are each
 * well covered on their own. This file covers the thing that connects them,
 * which had no tests at all — and **F6 and F7 were both assembly bugs**: a
 * rate limiter registered so late it protected nothing, and an error handler
 * that flattened the limiter's 429 into a 500. In both cases every
 * individual piece was correct and the composition was not.
 *
 * A real socket rather than a mock, because the properties worth checking
 * here — a handshake refused before `connection` fires, a session entry
 * removed on close, a 1013 on the connection over the ceiling — are all
 * properties of `ws` behaving as the assembly assumes it does. A mock would
 * assert my belief about `ws` rather than `ws`.
 *
 * What these cannot establish:
 *
 *   - That `index.ts` passes the right values into the factory. It reads
 *     `SOCKET_MAX_CONNECTIONS` and calls `loadOriginPolicy` itself, and a
 *     typo there is invisible here.
 *   - That `connection.send` checks `readyState` before writing. Removing
 *     the check survives this suite: it only matters when an async
 *     `handleMessage` resolves *after* the client has already gone, which
 *     needs a live backend to provoke, and `ws` tolerates a write to a
 *     closing socket rather than throwing. The guard prevents a wasted
 *     serialise, not a crash.
 *   - The `maxPayload` ceiling — see the note in "the payload ceiling".
 */

const logger = createLogger("game-socket-test");

/** Quiet: these tests deliberately trigger the warn/error paths. */
const silentLogger = {
  ...logger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as typeof logger;

const policy = (allowed: string[]): OriginPolicy => ({ allowed, requireAllowlist: false });

let running: SocketServer | undefined;

/** Starts the server on an ephemeral port and returns its URL. */
async function start(options: Partial<Parameters<typeof createSocketServer>[0]> = {}) {
  const sessions = options.sessions ?? new Map<Connection, Session>();
  const server = createSocketServer({
    originPolicy: policy(["http://localhost:9104"]),
    logger: silentLogger,
    maxConnections: 5000,
    ...options,
    sessions,
  });
  running = server;

  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = server.httpServer.address() as AddressInfo;

  return { ...server, sessions, url: `ws://127.0.0.1:${port}`, port };
}

afterEach(async () => {
  if (!running) return;
  for (const client of running.wss.clients) client.terminate();
  await new Promise<void>((resolve) => running!.wss.close(() => resolve()));
  await new Promise<void>((resolve) => running!.httpServer.close(() => resolve()));
  running = undefined;
});

/** Resolves when the socket opens, or rejects with the handshake's status. */
function open(url: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`handshake ${res.statusCode}`)));
    socket.once("error", (err) => reject(err));
  });
}

/** The next message the server sends, parsed. Times out rather than
 * hanging, for the same reason as `nextClose`. */
function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply within ${timeoutMs}ms`)), timeoutMs);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("closed before replying"));
    });
  });
}

/**
 * The close code the server used, for a socket it is expected to close.
 *
 * Rejects rather than waiting forever. Without the timeout a server that
 * *fails* to close the socket hangs the run instead of failing it — which
 * is precisely what a broken ceiling looks like, so the failure mode of the
 * test must not be "no output for ten minutes".
 */
function nextClose(socket: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no close within ${timeoutMs}ms`)), timeoutMs);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("the health endpoint", () => {
  it("answers on the same port the socket listens on", async () => {
    // One port for both, so a container health check needs no second
    // listener and no websocket client.
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "game-socket", status: "ok" });
  });

  it("answers /health/ready, so the deploy can check one path across services", async () => {
    // game-backend and backoffice-api both serve /health/ready, and the
    // deploy's health check curls that path. This service answered 404 on
    // it until an actual deploy exposed the inconsistency.
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "game-socket", status: "ready" });
  });

  it("404s anything else, rather than serving it", async () => {
    const { port } = await start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/../etc/passwd`)).status, 404);
  });
});

describe("the handshake", () => {
  it("accepts a connection from an allowed origin", async () => {
    // Load-bearing: without it, the refusal test below would pass against a
    // server that refused everything.
    const { url } = await start();
    const socket = await open(url, { origin: "http://localhost:9104" });

    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  });

  it("accepts a connection with no Origin, since only browsers send one", async () => {
    const { url } = await start();
    const socket = await open(url);

    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  });

  it("refuses a disallowed origin with 403, before the connection exists", async () => {
    // F8's guarantee. Refused at `verifyClient`, so a rejected browser never
    // reaches `connection` and never costs a limiter, a session entry or a
    // socket.
    const { url, wss } = await start();

    await assert.rejects(() => open(url, { origin: "https://evil.example" }), /handshake 403/);
    assert.equal(wss.clients.size, 0, "a refused handshake must not leave a client behind");
  });

  it("does not create a session entry for a refused handshake", async () => {
    const { url, sessions } = await start();

    await assert.rejects(() => open(url, { origin: "https://evil.example" }), /handshake 403/);
    assert.equal(sessions.size, 0);
  });
});

describe("the concurrent connection ceiling", () => {
  it("closes a connection over the ceiling with 1013", async () => {
    // Message rate limiting does nothing about a client that simply opens
    // more sockets, and each one costs memory whether or not it ever
    // authenticates.
    const { url } = await start({ maxConnections: 1 });

    const first = await open(url);
    const second = await open(url);

    assert.equal(await nextClose(second), 1013, "the connection over the limit must be told the server is busy");
    assert.equal(first.readyState, WebSocket.OPEN, "the connection under the limit must survive");
    first.close();
  });

  it("admits connections up to the ceiling", async () => {
    // The check is `> maxConnections`, so the ceiling is inclusive. Pinned
    // because an off-by-one here refuses a legitimate client.
    const { url } = await start({ maxConnections: 2 });

    const first = await open(url);
    const second = await open(url);

    // Neither should close on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(first.readyState, WebSocket.OPEN);
    assert.equal(second.readyState, WebSocket.OPEN);

    first.close();
    second.close();
  });

  it("accepts a new connection again once one closes", async () => {
    // The ceiling counts live sockets, not sockets ever opened. If closing
    // did not free a slot, the service would degrade to refusing everyone
    // after enough churn.
    const { url } = await start({ maxConnections: 1 });

    const first = await open(url);
    await new Promise<void>((resolve) => {
      first.once("close", () => resolve());
      first.close();
    });
    // Give the server's own close handler a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const replacement = await open(url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replacement.readyState, WebSocket.OPEN, "a freed slot must be reusable");
    replacement.close();
  });
});

describe("message handling", () => {
  it("answers malformed JSON with bad_json rather than closing or crashing", async () => {
    const { url } = await start();
    const socket = await open(url);

    socket.send("this is not json");
    const reply = await nextMessage(socket);

    assert.equal(reply.type, "ERROR");
    assert.equal(reply.code, "bad_json");
    assert.equal(socket.readyState, WebSocket.OPEN, "a bad message must not drop the connection");
    socket.close();
  });

  it("survives a message that parses to something without a type", async () => {
    // `message?.type ?? ""` — the limiter must be handed a string whatever
    // arrives. `null` and a bare array both parse successfully.
    const { url } = await start();
    const socket = await open(url);

    for (const payload of ["null", "[]", '{"no":"type"}', "42"]) {
      socket.send(payload);
      const reply = await nextMessage(socket);
      assert.equal(reply.type, "ERROR", `expected an error reply for ${payload}`);
    }

    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  });

  it("rate limits a flood, and says how long to wait", async () => {
    // The limiter's own thresholds are `rateLimit.test.ts`'s subject. What
    // is checked here is that it is actually wired in front of dispatch —
    // exactly the wiring F6 got wrong on the HTTP side, where a limiter was
    // registered too late to protect anything.
    const { url } = await start();
    const socket = await open(url);

    const replies: Record<string, unknown>[] = [];
    // Rejects rather than hanging: a limiter that is wired out sends no
    // `rate_limited` at all, and that must fail the test rather than stall
    // the run.
    const collected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no rate_limited reply within 3000ms")), 3000);
      socket.on("message", (raw) => {
        replies.push(JSON.parse(raw.toString()));
        if (replies.some((r) => r.code === "rate_limited")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    for (let i = 0; i < 200; i++) socket.send(JSON.stringify({ type: "SPIN", betAmount: 100 }));
    await collected;

    const limited = replies.find((r) => r.code === "rate_limited")!;
    assert.equal(limited.type, "ERROR");
    // Fractional by design — `retryAfterSeconds` rounds to a tenth, so a
    // client waiting out a short burst is not told to sleep a whole second.
    assert.match(
      String(limited.message),
      /Retry in \d+(\.\d+)?s/,
      "a limited client needs a reason to back off",
    );
    socket.close();
  });

  it("does not move money for a message that never authenticated", async () => {
    // Identity is keyed by connection and populated only from a verified
    // token. A SPIN before any AUTH has no player to charge.
    const { url, sessions } = await start();
    const socket = await open(url);

    socket.send(JSON.stringify({ type: "SPIN", betAmount: 100 }));
    const reply = await nextMessage(socket);

    assert.equal(reply.type, "ERROR");
    assert.equal(sessions.size, 0, "an unauthenticated spin must not create a session");
    socket.close();
  });
});

describe("the payload ceiling", () => {
  /**
   * NOT covered, deliberately: that a frame over `maxPayload` (64KB) is
   * refused. Removing the option survives this suite, and it is the one
   * mutation here left uncaught.
   *
   * Three attempts to test it all ended up testing `ws` rather than this
   * assembly. The client applies `maxPayload` to what it receives as well,
   * so with the default it throws locally before the server's verdict is
   * visible; raising the client's ceiling moves the failure to a
   * synchronous `RangeError` out of `socket.send` that escapes before any
   * listener is attached. Each fix made the test more about `ws`'s internal
   * ordering and less about the server.
   *
   * The judgement: `maxPayload` is a single `ws` option whose enforcement is
   * `ws`'s own well-tested responsibility, and the assembly's part in it is
   * one line that is visible on inspection. That makes it a poor use of a
   * fragile test. Recorded here rather than left as a silent gap — if this
   * option is ever removed, no test in this repo will notice.
   */
  it("accepts an ordinary message comfortably under the ceiling", async () => {
    // The direction that IS worth pinning: the limit must not be so tight
    // that a normal message is refused.
    const { url } = await start();
    const socket = await open(url);

    socket.send(JSON.stringify({ type: "PING" }));
    const reply = await nextMessage(socket);

    assert.equal(reply.type, "PONG");
    socket.close();
  });
});

describe("cleanup on close", () => {
  it("removes the session entry when a client disconnects", async () => {
    // Without this the map grows for the lifetime of the process, holding a
    // player identity for every socket that ever connected — a slow leak of
    // exactly the data that must not linger.
    //
    // The session is seeded against the server's OWN `Connection` object,
    // captured via `onConnection`. That matters: keying on a hand-made
    // object would test nothing, since `sessions.delete` is called with the
    // real one. An earlier version of this test asserted on
    // `wss.clients.size` instead and let the "never clean up" mutation
    // survive.
    const sessions = new Map<Connection, Session>();
    const connections: Connection[] = [];
    const { url } = await start({ sessions, onConnection: (c) => connections.push(c) });

    const socket = await open(url);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(connections.length, 1, "the server must have made one Connection");
    sessions.set(connections[0], { operatorId: "op-1", playerId: "p-1", gameId: "reference-5x3" });
    assert.equal(sessions.size, 1);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(sessions.size, 0, "a disconnected client's identity must not stay in the map");
  });

  it("removes only the disconnecting client's session, leaving others alone", async () => {
    // The delete is keyed by connection, so one client leaving must not
    // disturb anyone else's identity.
    const sessions = new Map<Connection, Session>();
    const connections: Connection[] = [];
    const { url } = await start({ sessions, onConnection: (c) => connections.push(c) });

    const first = await open(url);
    const second = await open(url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connections.length, 2);

    sessions.set(connections[0], { operatorId: "op-1", playerId: "p-1", gameId: "reference-5x3" });
    sessions.set(connections[1], { operatorId: "op-1", playerId: "p-2", gameId: "reference-5x3" });

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(sessions.size, 1);
    assert.equal(sessions.get(connections[1])?.playerId, "p-2", "the remaining client keeps its identity");
    second.close();
  });

  it("leaves no client registered after every connection closes", async () => {
    const { url, wss } = await start();

    const sockets = await Promise.all([open(url), open(url), open(url)]);
    assert.equal(wss.clients.size, 3);

    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close();
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(wss.clients.size, 0);
  });
});
