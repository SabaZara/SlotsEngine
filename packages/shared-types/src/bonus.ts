import type { BonusModuleId } from "./game-definition.js";

/**
 * `active` -> `resolved` | `abandoned`. A session credits exactly once, on
 * the transition into `resolved` — see game-backend's bonus/session.ts for
 * how that transition is made atomic (a conditional `findOneAndUpdate`
 * that only one concurrent caller can win, never a read-then-write).
 */
export type BonusSessionStatus = "active" | "resolved" | "abandoned";

export interface BonusSession {
  bonusSessionId: string;
  operatorId: string;
  playerId: string;
  gameId: string;
  roundId: string;
  moduleId: BonusModuleId;
  status: BonusSessionStatus;
  /** Integer minor units — the bet that triggered this bonus, which module
   * payouts are expressed as a multiple of. */
  totalBet: number;
  /** Integer minor units. Only meaningful once `status === "resolved"`. */
  totalWin: number;
  /** Module-owned progress state. Opaque to everything outside the module. */
  moduleState: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

/** The redacted view of a bonus session a client is allowed to see. Never
 * carries `moduleState` wholesale — a module decides what to reveal. */
export interface BonusPublicState {
  bonusSessionId: string;
  moduleId: BonusModuleId;
  status: BonusSessionStatus;
  /** Integer minor units, present once resolved. */
  totalWin?: number;
  /** Module-defined presentation payload (wheel segment index, revealed
   * tiles, and so on) — never the unrevealed remainder. */
  view: Record<string, unknown>;
}
