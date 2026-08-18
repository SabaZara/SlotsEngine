import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "@slots-engine/logging";
import type { ClientToServerMessage, ServerToClientMessage } from "@slots-engine/shared-types";
import { handleMessage, type Connection, type Session } from "./session.js";
import { ConnectionLimiter } from "./rateLimit.js";
import { isOriginAllowed, type OriginPolicy } from "./origin.js";

/**
 * The socket service's assembly, separated from `index.ts` so it can be
 * started on an ephemeral port by a test.
 *
 * The split follows `backoffice-api`'s `app.ts` / `index.ts`: everything
 * that wires pieces together lives in a factory, and the entry point only
 * reads configuration and calls it. `session.ts`, `rateLimit.ts` and
 * `origin.ts` were each well covered while this — the file that connects
 * them — was not, and F6 and F7 were both assembly bugs of exactly that
 * kind: every part correct, the composition wrong, and no test positioned
 * to see it.
 */
export interface SocketServerOptions {
  originPolicy: OriginPolicy;
  logger: Logger;
  /** Concurrent socket ceiling. The point is that "unbounded" is not a
   * number. */
  maxConnections: number;
  /** Shared with the caller in tests so identity can be inspected; a fresh
   * map otherwise. */
  sessions?: Map<Connection, Session>;
  /**
   * Called with the `Connection` created for each socket.
   *
   * Exists so a test can observe the session map's lifecycle without a
   * signed token and a live backend: establishing a session for real needs
   * both, but the property worth checking here is that the entry is
   * *removed* on close, which is independent of how it got there. Unused in
   * production.
   */
  onConnection?: (connection: Connection) => void;
}

export interface SocketServer {
  httpServer: Server;
  wss: WebSocketServer;
  sessions: Map<Connection, Session>;
}

export function createSocketServer(options: SocketServerOptions): SocketServer {
  const { originPolicy, logger, maxConnections } = options;

  /**
   * **Identity lives here, keyed by connection — never in a client message.**
   *
   * A client can name a bet amount; it can never name a player. Every value
   * on the money path other than `betAmount` is read from this map, which is
   * populated only from a cryptographically verified token.
   */
  const sessions = options.sessions ?? new Map<Connection, Session>();

  const httpServer = createServer((req, res) => {
    // Liveness: the process is up. Deliberately does not touch a dependency
    // — a liveness probe that fails on a downstream blip restarts a healthy
    // process and makes an outage worse.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "game-socket", status: "ok" }));
      return;
    }
    // Readiness, and it reports the same thing liveness does — on purpose.
    // This service owns no database handle and opens no connection at boot:
    // once it is listening it can accept a handshake, so there is nothing
    // further to prove. The path exists because every other service answers
    // /health/ready, and a deploy that health-checks a uniform path should
    // not have to special-case one service. Adding a real dependency here
    // means giving this branch something to check.
    if (req.url === "/health/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "game-socket", status: "ready" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 64 * 1024,
    // Refused at the handshake, so a rejected browser never reaches
    // `connection` and never costs a limiter, a session entry or a socket.
    // `ws` answers a false verdict with the status given here and closes.
    verifyClient: ({ origin }, done) => {
      if (isOriginAllowed(origin, originPolicy)) {
        done(true);
        return;
      }
      // Logged because a burst of these is a signal worth seeing: it means
      // a page somewhere is pointing at this socket.
      logger.warn({ origin }, "refusing websocket handshake from disallowed origin");
      done(false, 403, "Forbidden origin");
    },
  });

  wss.on("connection", (socket: WebSocket) => {
    // A ceiling on concurrent sockets. Message rate limiting does nothing
    // about a client that simply opens more connections, and each one costs
    // memory whether or not it ever authenticates.
    if (wss.clients.size > maxConnections) {
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

    options.onConnection?.(connection);

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
        // The detail is logged; the client is told nothing specific, since
        // an internal error message can disclose structure to a probing
        // client.
        logger.error({ err }, "unhandled error processing message");
        connection.send({ type: "ERROR", code: "internal_error", message: "Something went wrong." });
      });
    });

    socket.on("close", () => {
      // Without this the map grows for the lifetime of the process, holding
      // a player identity per socket that ever connected.
      sessions.delete(connection);
      logger.info("client disconnected");
    });
  });

  return { httpServer, wss, sessions };
}
