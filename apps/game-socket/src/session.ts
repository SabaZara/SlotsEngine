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
  LimitExceededError,
  consumeLaunchToken,
  getBalance,
  recover,
  spin,
  startBonus,
  stepBonus,
} from "./backendClient.js";

export interface Session {
  operatorId: string;
  playerId: string;
  gameId: string;
  /** Set while a bonus round from a triggering spin is in progress. Only
   * one bonus session is ever active per connection. */
  activeBonusSessionId?: string;
}

/**
 * Everything this module needs from a connection, which is only the ability
 * to send a message and to look up whoever is on the other end.
 *
 * Stated as an interface rather than taking a `WebSocket` so the decision
 * logic can be exercised without a socket, a port or a running server. The
 * point is not convenience: this is the code that decides who a player is,
 * and it should be testable without standing up the thing it protects.
 */
export interface Connection {
  send(message: ServerToClientMessage): void;
}

/** Identity keyed by connection — see the note in `index.ts`. */
export type SessionStore = Map<Connection, Session>;

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
export async function resolveSessionFromToken(
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
 * What a player is told when a limit refuses their bet.
 *
 * Built here rather than passed through from the backend because it is
 * presentation, and the backend deliberately answers in codes. Two rules
 * it follows, both deliberate:
 *
 * - **It names the period**, because "you have reached your limit" invites
 *   the player to try again in a minute. "Your daily limit" tells them when
 *   to come back, which is the honest answer and the one that stops them
 *   retrying.
 * - **It mentions remaining headroom only when there is some.** Saying "you
 *   can still stake 0" is worse than saying nothing, and a smaller-bet
 *   suggestion against an exhausted limit reads as a way around it.
 *
 * Amounts stay in minor units here. The client formats money for display —
 * it knows the game's currency and this service does not, and guessing
 * would be the USD-default bug one layer earlier.
 */
function limitMessage(err: LimitExceededError): string {
  const kind = err.code === "loss_limit_reached" ? "loss" : "stake";
  const period = err.period ?? "current";
  const base = `You have reached your ${period} ${kind} limit.`;

  return err.remaining !== undefined && err.remaining > 0
    ? `${base} You can still bet up to ${err.remaining} this period.`
    : base;
}

/**
 * Starts the bonus round immediately when a spin triggered one — the client
 * never asks for it. The outcome was already decided server-side by the
 * spin; requiring a client action to open it would only add a way for the
 * two to disagree.
 */
async function autoStartBonusIfTriggered(
  connection: Connection,
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

  connection.send({ type: "BONUS_STEP_RESULT", bonusState: result.publicState });

  if (result.done) {
    connection.send({
      type: "BALANCE_UPDATE",
      balance: result.balanceAfter ?? (await getBalance(session.operatorId, session.playerId)),
    });
  } else {
    session.activeBonusSessionId = result.publicState.bonusSessionId;
  }
}

export async function handleMessage(
  connection: Connection,
  sessions: SessionStore,
  message: ClientToServerMessage,
): Promise<void> {
  if (message.type === "PING") {
    connection.send({ type: "PONG" });
    return;
  }

  if (message.type === "JOIN") {
    const result = await resolveSessionFromToken(message.token);
    if (!result.ok) {
      connection.send({ type: "ERROR", code: result.code, message: result.message });
      return;
    }
    sessions.set(connection, result.session);
    connection.send({
      type: "JOINED",
      playerId: result.session.playerId,
      gameId: result.session.gameId,
      balance: await getBalance(result.session.operatorId, result.session.playerId),
      ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
    });
    return;
  }

  const session = sessions.get(connection);
  if (!session) {
    connection.send({ type: "ERROR", code: "not_joined", message: "Send JOIN before any other message." });
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
      connection.send({ type: "SPIN_RESULT", round });
      connection.send({ type: "BALANCE_UPDATE", balance: balanceAfter });
      await autoStartBonusIfTriggered(connection, session, round);
    } catch (err) {
      if (err instanceof LimitExceededError) {
        // Checked before InsufficientFundsError because the two must never
        // be conflated: this player has money and is choosing not to be
        // able to spend it. The message says so plainly and offers no way
        // around it — no "top up", no "try a smaller bet" unless there is
        // genuinely room left.
        connection.send({
          type: "ERROR",
          code: err.code,
          message: limitMessage(err),
        });
        return;
      }
      if (err instanceof InsufficientFundsError) {
        connection.send({ type: "ERROR", code: "insufficient_funds", message: "Not enough balance for this bet." });
        return;
      }
      if (err instanceof InvalidBetAmountError) {
        connection.send({ type: "ERROR", code: "invalid_bet_amount", message: "That bet amount isn't offered by this game." });
        return;
      }
      if (err instanceof GameNotFoundError) {
        connection.send({ type: "ERROR", code: "game_not_found", message: `Unknown game '${session.gameId}'.` });
        return;
      }
      throw err;
    }
    return;
  }

  if (message.type === "BONUS_STEP") {
    if (!session.activeBonusSessionId) {
      connection.send({ type: "ERROR", code: "no_active_bonus", message: "No bonus session in progress." });
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
      connection.send({ type: "BONUS_STEP_RESULT", bonusState: result.publicState });
      if (result.done) {
        session.activeBonusSessionId = undefined;
        connection.send({
          type: "BALANCE_UPDATE",
          balance: result.balanceAfter ?? (await getBalance(session.operatorId, session.playerId)),
        });
      }
    } catch (err) {
      if (err instanceof InvalidBonusActionError) {
        connection.send({ type: "ERROR", code: "invalid_bonus_action", message: err.message });
        return;
      }
      if (err instanceof BonusSessionAbandonedError) {
        session.activeBonusSessionId = undefined;
        connection.send({ type: "ERROR", code: "bonus_session_abandoned", message: "That bonus round timed out." });
        return;
      }
      if (err instanceof BonusSessionNotFoundError) {
        session.activeBonusSessionId = undefined;
        connection.send({ type: "ERROR", code: "bonus_session_not_found", message: "Bonus session no longer exists." });
        return;
      }
      throw err;
    }
    return;
  }

  if (message.type === "ROUND_RECOVER") {
    const result = await recover(session.operatorId, session.playerId, message.roundId);
    if (!result) {
      connection.send({ type: "ERROR", code: "no_round_found", message: "No round to recover." });
      return;
    }
    connection.send({ type: "ROUND_RECOVERED", round: result.round });
    return;
  }
}
