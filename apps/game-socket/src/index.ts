import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@slots-engine/logging";
import type { ClientToServerMessage, ServerToClientMessage } from "@slots-engine/shared-types";
import { handleMessage, type Connection, type Session } from "./session.js";

const logger = createLogger("game-socket");
const PORT = Number(process.env.PORT ?? 9003);

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

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "game-socket", status: "ok" }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

wss.on("connection", (socket: WebSocket) => {
  logger.info("client connected");

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
