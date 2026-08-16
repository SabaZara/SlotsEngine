import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@slots-engine/logging";
import type { ClientToServerMessage, ServerToClientMessage } from "@slots-engine/shared-types";
import { handleMessage, type Connection, type Session } from "./session.js";
import { ConnectionLimiter } from "./rateLimit.js";
import { assertOriginPolicy, isOriginAllowed, loadOriginPolicy } from "./origin.js";

const logger = createLogger("game-socket");
const PORT = Number(process.env.PORT ?? 9003);
/** Concurrent socket ceiling. Generous for a single instance; the point is
 * that "unbounded" is not a number. */
const MAX_CONNECTIONS = Number(process.env.SOCKET_MAX_CONNECTIONS ?? 5000);

/**
 * **Identity lives here, keyed by connection — never in a client message.**
 *
 * This map is the single most important structural fact in the system. A
 * client can name a bet amount; it can never name a player. Every value on
 * the money path other than `betAmount` is read from this map, which is
 * populated only from a cryptographically verified token.
 *
 * The decision logic that reads and writes it lives in `session.ts`, which
 * knows nothing about sockets — so it can be tested without one.
 */
const sessions = new Map<Connection, Session>();

// Read and validated before anything binds a port, so a misconfigured
// service fails visibly at boot rather than serving with no origin check.
const originPolicy = loadOriginPolicy();
assertOriginPolicy(originPolicy);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "game-socket", status: "ok" }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 64 * 1024,
  // Refused at the handshake, so a rejected browser never reaches
  // `connection` and never costs a limiter, a session entry or a socket.
  // `ws` answers a false verdict with 401 and closes.
  verifyClient: ({ origin }, done) => {
    if (isOriginAllowed(origin, originPolicy)) {
      done(true);
      return;
    }
    // Logged because a burst of these is a signal worth seeing: it means a
    // page somewhere is pointing at this socket.
    logger.warn({ origin }, "refusing websocket handshake from disallowed origin");
    done(false, 403, "Forbidden origin");
  },
});

wss.on("connection", (socket: WebSocket) => {
  // A ceiling on concurrent sockets. Message rate limiting does nothing
  // about a client that simply opens more connections, and each one costs
  // memory whether or not it ever authenticates.
  if (wss.clients.size > MAX_CONNECTIONS) {
    logger.warn({ open: wss.clients.size }, "refusing connection over the concurrent limit");
    socket.close(1013, "server busy");
    return;
  }

  logger.info("client connected");

  const limiter = new ConnectionLimiter();

  // Adapts a real socket to the minimal interface the decision logic needs.
  const connection: Connection = {
    send(message: ServerToClientMessage) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
  };

  socket.on("message", (raw) => {
    let message: ClientToServerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      connection.send({ type: "ERROR", code: "bad_json", message: "Message must be valid JSON." });
      return;
    }

    // Checked before anything is dispatched, so a limited message costs a
    // JSON parse and nothing else — no database call, and no money moved.
    const verdict = limiter.check(message?.type ?? "");
    if (!verdict.allowed) {
      connection.send({
        type: "ERROR",
        code: "rate_limited",
        message: `Too many requests. Retry in ${verdict.retryAfter}s.`,
      });
      return;
    }

    handleMessage(connection, sessions, message).catch((err) => {
      // The detail is logged; the client is told nothing specific, since an
      // internal error message can disclose structure to a probing client.
      logger.error({ err }, "unhandled error processing message");
      connection.send({ type: "ERROR", code: "internal_error", message: "Something went wrong." });
    });
  });

  socket.on("close", () => {
    sessions.delete(connection);
    logger.info("client disconnected");
  });
});

httpServer.listen(PORT, () => {
  logger.info(`game-socket listening on :${PORT}`);
});
