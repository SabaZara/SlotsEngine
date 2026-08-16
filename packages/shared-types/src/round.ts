import type { BonusModuleId } from "./game-definition.js";

export type RoundStatus = "open" | "resolved" | "recovered" | "voided";

export interface WinLine {
  line: number;
  symbol: string;
  count: number;
  /** Integer minor units of the game's `currency` — see money.ts. */
  amount: number;
  positions: Array<{ reel: number; row: number }>;
}

export interface RoundEvaluation {
  winLines: WinLine[];
  /** Integer minor units — see money.ts. */
  lineWinTotal: number;
  /** Integer minor units — see money.ts. */
  scatterAmount: number;
  /** Integer minor units — see money.ts. */
  totalWin: number;
  bonusTriggered: boolean;
  bonusModuleId?: BonusModuleId;
}

/**
 * A single round's full lifecycle record. `seed` and `rngAlgorithm` are
 * stored so the outcome can be deterministically re-derived for an audit —
 * a round is never re-rolled, only replayed.
 */
export interface Round {
  roundId: string;
  operatorId: string;
  playerId: string;
  gameId: string;
  gameVersion: number;
  /** Integer minor units — see money.ts. */
  totalBet: number;
  seed: string;
  /** Which RNG algorithm produced this round's draw sequence from `seed`.
   * Required to replay a historical round exactly after the platform
   * default changes — stored per round rather than assumed. */
  rngAlgorithm: string;
  resultMatrix?: string[][];
  /** Reel indices expanded by a landed expanding wild this spin (already
   * reflected in `resultMatrix`) — a presentation hint so a client can play
   * a distinct reveal on those reels. Empty array, not absent, when a spin
   * had no expanding wild. */
  expandedReels?: number[];
  evaluation?: RoundEvaluation;
  status: RoundStatus;
  createdAt: string;
  resolvedAt?: string;
  /**
   * Echoes the socket protocol's `SPIN_REQUEST.clientRequestId` when the
   * round was created from one. A retried request with the same id must
   * return this exact round rather than spinning again — enforced by the
   * unique `(operatorId, playerId, clientRequestId)` index.
   */
  clientRequestId?: string;
}

/** Source-of-truth balance held for a player under one operator. */
export interface Player {
  operatorId: string;
  playerId: string;
  /** Integer minor units — see money.ts. No currency field, deliberately:
   * one operator's wallet is assumed to operate in one consistent currency
   * (see money.ts for the full scope boundary). */
  balance: number;
  updatedAt: string;
}
