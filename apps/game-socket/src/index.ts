import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@slots-engine/logging";
import type { ClientToServerMessage, ServerToClientMessage } from "@slots-engine/shared-types";
import {
  ExpiredLaunchTokenError,
  InvalidLaunchTokenError,
  signSessionToken,
  verifyLaunchToken,
} from "@slots-engine/launch-token";
import {
  BonusSessionAbandonedError,
  BonusSessionNotFoundError,
  GameNotFoundError,
  InsufficientFundsError,
  InvalidBetAmountError,
  InvalidBonusActionError,
  LaunchTokenAlreadyUsedError,
  consumeLaunchToken,
  getBalance,
  recover,
  spin,
  startBonus,
  stepBonus,
} from "./backendClient.js";

const logger = createLogger("game-socket");
const PORT = Number(process.env.PORT ?? 9003);

interface Session {
  operatorId: string;
  playerId: string;
  gameId: string;
  /** Set while a bonus round from a triggering spin is in progress. Only
   * one bonus session is ever active per connection. */
  activeBonusSessionId?: string;
}

/**
 * **Identity lives here, keyed by socket — never in a client message.**
 *
 * This map is the single most important structural fact in the system. A
 * client can name a bet amount; it can never name a player. Every value on
 * the money path other than `betAmount` is read from this map, which is
 * populated only from a cryptographically verified token.
 */
const sessions = new Map<WebSocket, Session>();

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Establishes a session from a signed token.
 *
 * A `"launch"` token is single-use: it is consumed via game-backend, and on
 * success a reusable `"session"` token is minted and handed back so a later
 * reconnect doesn't have to go all the way back to the operator. A
 * `"session"` token is simply verified and reused.
 *
 * Returns a discriminated result rather than throwing, so a client gets a
 * specific reason — expired, invalid, already used — instead of one generic
 * failure it cannot act on.
 */
async function resolveSessionFromToken(
  token: string,
): Promise<{ ok: true; session: Session; sessionToken?: string } | { ok: false; code: string; message: string }> {
  let payload: ReturnType<typeof verifyLaunchToken>;
  try {
    payload = verifyLaunchToken(token);
  } catch (err) {
    if (err instanceof ExpiredLaunchTokenError) {
      return { ok: false, code: "token_expired", message: "This token has expired." };
    }
    if (err instanceof InvalidLaunchTokenError) {
      return { ok: false, code: "invalid_token", message: "This token is invalid." };
    }
    throw err;
  }

  const session: Session = { operatorId: payload.operatorId, playerId: payload.playerId, gameId: payload.gameId };

  if (payload.kind === "session") return { ok: true, session };

  try {
    await consumeLaunchToken(payload.jti, payload.exp);
  } catch (err) {
    if (err instanceof LaunchTokenAlreadyUsedError) {
      return { ok: false, code: "token_already_used", message: "This launch token has already been used." };
    }
    throw err;
  }

  return { ok: true, session, sessionToken: signSessionToken(session).token };
}

/**
 * Starts the bonus round immediately when a spin triggered one — the client
 * never asks for it. The outcome was already decided server-side by the
 * spin; requiring a client action to open it would only add a way for the
 * two to disagree.
 */
async function autoStartBonusIfTriggered(
  socket: WebSocket,
  session: Session,
  round: Awaited<ReturnType<typeof spin>>["round"],
): Promise<void> {
  if (!round.evaluation?.bonusTriggered || !round.evaluation.bonusModuleId) return;

  const result = await startBonus({
    operatorId: session.operatorId,
    playerId: session.playerId,
    gameId: session.gameId,
    roundId: round.roundId,
    moduleId: round.evaluation.bonusModuleId,
    totalBet: round.totalBet,
  });

  send(socket, { type: "BONUS_STEP_RESULT", bonusState: result.publicState });

  if (result.done) {
    send(socket, { type: "BALANCE_UPDATE", balance: result.balanceAfter ?? (await getBalance(session.operatorId, session.playerId)) });
  } else {
    session.activeBonusSessionId = result.publicState.bonusSessionId;
  }
}

async function handleMessage(socket: WebSocket, message: ClientToServerMessage): Promise<void> {
  if (message.type === "PING") {
    send(socket, { type: "PONG" });
    return;
  }

  if (message.type === "JOIN") {
    const result = await resolveSessionFromToken(message.token);
    if (!result.ok) {
      send(socket, { type: "ERROR", code: result.code, message: result.message });
      return;
    }
    sessions.set(socket, result.session);
    send(socket, {
      type: "JOINED",
      playerId: result.session.playerId,
      gameId: result.session.gameId,
      balance: await getBalance(result.session.operatorId, result.session.playerId),
      ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
    });
    return;
  }

  const session = sessions.get(socket);
  if (!session) {
    send(socket, { type: "ERROR", code: "not_joined", message: "Send JOIN before any other message." });
    return;
  }

  if (message.type === "SPIN_REQUEST") {
    try {
      const { round, balanceAfter } = await spin({
        // Every identity field comes from the verified session, never from
        // the message. `betAmount` is the only client-supplied value, and
        // game-backend validates it against the game's own allowlist.
        operatorId: session.operatorId,
        playerId: session.playerId,
        gameId: session.gameId,
        totalBet: message.betAmount,
        ...(message.clientRequestId !== undefined ? { clientRequestId: message.clientRequestId } : {}),
      });
      send(socket, { type: "SPIN_RESULT", round });
      send(socket, { type: "BALANCE_UPDATE", balance: balanceAfter });
      await autoStartBonusIfTriggered(socket, session, round);
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        send(socket, { type: "ERROR", code: "insufficient_funds", message: "Not enough balance for this bet." });
        return;
      }
      if (err instanceof InvalidBetAmountError) {
        send(socket, { type: "ERROR", code: "invalid_bet_amount", message: "That bet amount isn't offered by this game." });
        return;
      }
      if (err instanceof GameNotFoundError) {
        send(socket, { type: "ERROR", code: "game_not_found", message: `Unknown game '${session.gameId}'.` });
        return;
      }
      throw err;
    }
    return;
  }

  if (message.type === "BONUS_STEP") {
    if (!session.activeBonusSessionId) {
      send(socket, { type: "ERROR", code: "no_active_bonus", message: "No bonus session in progress." });
      return;
    }
    try {
      const result = await stepBonus({
        operatorId: session.operatorId,
        playerId: session.playerId,
        gameId: session.gameId,
        bonusSessionId: session.activeBonusSessionId,
        action: message.action,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      });
      send(socket, { type: "BONUS_STEP_RESULT", bonusState: result.publicState });
      if (result.done) {
        session.activeBonusSessionId = undefined;
        send(socket, {
          type: "BALANCE_UPDATE",
          balance: result.balanceAfter ?? (await getBalance(session.operatorId, session.playerId)),
        });
      }
    } catch (err) {
      if (err instanceof InvalidBonusActionError) {
        send(socket, { type: "ERROR", code: "invalid_bonus_action", message: err.message });
        return;
      }
      if (err instanceof BonusSessionAbandonedError) {
        session.activeBonusSessionId = undefined;
        send(socket, { type: "ERROR", code: "bonus_session_abandoned", message: "That bonus round timed out." });
        return;
      }
      if (err instanceof BonusSessionNotFoundError) {
        session.activeBonusSessionId = undefined;
        send(socket, { type: "ERROR", code: "bonus_session_not_found", message: "Bonus session no longer exists." });
        return;
      }
      throw err;
    }
    return;
  }

  if (message.type === "ROUND_RECOVER") {
    const result = await recover(session.operatorId, session.playerId, message.roundId);
    if (!result) {
      send(socket, { type: "ERROR", code: "no_round_found", message: "No round to recover." });
      return;
    }
    send(socket, { type: "ROUND_RECOVERED", round: result.round });
    return;
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "game-socket", status: "ok" }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 });

wss.on("connection", (socket) => {
  logger.info("client connected");

  socket.on("message", (raw) => {
    let message: ClientToServerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "ERROR", code: "bad_json", message: "Message must be valid JSON." });
      return;
    }

    handleMessage(socket, message).catch((err) => {
      // The detail is logged; the client is told nothing specific, since an
      // internal error message can disclose structure to a probing client.
      logger.error({ err }, "unhandled error processing message");
      send(socket, { type: "ERROR", code: "internal_error", message: "Something went wrong." });
    });
  });

  socket.on("close", () => {
    sessions.delete(socket);
    logger.info("client disconnected");
  });
});

httpServer.listen(PORT, () => {
  logger.info(`game-socket listening on :${PORT}`);
});
