import { signServiceRequest } from "@slots-engine/service-auth";
import type { BonusPublicState, Round } from "@slots-engine/shared-types";

const BACKEND_URL = process.env.GAME_BACKEND_URL ?? "http://localhost:9002";
const CALLER = "game-socket";

export class BackendError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) {
    super(message ?? code);
    this.name = "BackendError";
  }
}

export class InsufficientFundsError extends BackendError {}
export class InvalidBetAmountError extends BackendError {}
/** A player-protection ceiling refused the bet. Deliberately its own type
 * rather than a flavour of `InsufficientFundsError`: the two need opposite
 * responses, and a client that offers a deposit prompt here would be
 * inviting a player past the limit they are protected by. */
export class LimitExceededError extends BackendError {
  constructor(
    code: string,
    status: number,
    message: string | undefined,
    readonly period: string | undefined,
    readonly remaining: number | undefined,
  ) {
    super(code, status, message);
  }
}
export class GameNotFoundError extends BackendError {}
export class BonusSessionNotFoundError extends BackendError {}
export class BonusSessionAbandonedError extends BackendError {}
export class InvalidBonusActionError extends BackendError {}
export class LaunchTokenAlreadyUsedError extends BackendError {}

/** Anything a backend error body may carry beyond code and message. Read
 * from the parsed payload rather than re-fetched, so a field the route
 * added is available here without a second round trip. */
interface ErrorDetail {
  period?: string;
  remaining?: number;
}

function toTypedError(code: string, status: number, message?: string, detail: ErrorDetail = {}): BackendError {
  switch (code) {
    case "stake_limit_reached":
    case "loss_limit_reached":
      return new LimitExceededError(code, status, message, detail.period, detail.remaining);
    case "insufficient_funds":
      return new InsufficientFundsError(code, status, message);
    case "invalid_bet_amount":
      return new InvalidBetAmountError(code, status, message);
    case "game_not_found":
      return new GameNotFoundError(code, status, message);
    case "bonus_session_not_found":
      return new BonusSessionNotFoundError(code, status, message);
    case "bonus_session_abandoned":
      return new BonusSessionAbandonedError(code, status, message);
    case "invalid_bonus_action":
      return new InvalidBonusActionError(code, status, message);
    case "launch_token_already_used":
      return new LaunchTokenAlreadyUsedError(code, status, message);
    default:
      return new BackendError(code, status, message);
  }
}

function secret(): string {
  const value = process.env.SERVICE_AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SERVICE_AUTH_SECRET must be set to at least 32 characters — internal calls are signed.");
  }
  return value;
}

/**
 * Calls game-backend's internal API with a signed request.
 *
 * The body is serialized exactly once and both signed and sent as that same
 * string. Re-serializing for the signature would risk a key-order or
 * whitespace difference producing a signature that doesn't match the bytes
 * actually transmitted — a bug that appears only intermittently.
 */
async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const rawBody = JSON.stringify(body);
  const headers = signServiceRequest({ secret: secret(), caller: CALLER, method: "POST", path, rawBody });

  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      period?: string;
      remaining?: number;
    };
    throw toTypedError(payload.error ?? "backend_error", response.status, payload.message, {
      period: payload.period,
      remaining: payload.remaining,
    });
  }

  return (await response.json()) as T;
}

export function spin(input: {
  operatorId: string;
  playerId: string;
  gameId: string;
  totalBet: number;
  clientRequestId?: string;
}): Promise<{ round: Round; balanceAfter: number }> {
  return call("/internal/rounds/spin", input);
}

export function recover(operatorId: string, playerId: string, roundId?: string): Promise<{ round: Round } | null> {
  return call<{ round: Round }>("/internal/rounds/recover", { operatorId, playerId, roundId }).catch((err) => {
    if (err instanceof BackendError && err.status === 404) return null;
    throw err;
  });
}

export async function getBalance(operatorId: string, playerId: string): Promise<number> {
  const { balance } = await call<{ balance: number }>("/internal/players/balance", { operatorId, playerId });
  return balance;
}

export function consumeLaunchToken(jti: string, expiresAt: number): Promise<{ consumed: boolean }> {
  return call("/internal/launch-tokens/consume", { jti, expiresAt });
}

export function startBonus(input: {
  operatorId: string;
  playerId: string;
  gameId: string;
  roundId: string;
  moduleId: string;
  totalBet: number;
}): Promise<{ publicState: BonusPublicState; done: boolean; balanceAfter?: number }> {
  return call("/internal/bonus/start", input);
}

export function stepBonus(input: {
  operatorId: string;
  playerId: string;
  gameId: string;
  bonusSessionId: string;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<{ publicState: BonusPublicState; done: boolean; balanceAfter?: number }> {
  return call("/internal/bonus/step", input);
}
