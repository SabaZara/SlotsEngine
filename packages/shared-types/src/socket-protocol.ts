import type { BonusPublicState } from "./bonus.js";
import type { Round } from "./round.js";

/**
 * The client never names a `playerId` or `operatorId` in any message —
 * identity comes from the signed token at JOIN and lives in a server-side
 * session map keyed by socket. The only client-controlled value on the
 * money path is `betAmount`, and it is validated against the game's own
 * `betOptions` allowlist before any debit.
 */
export type ClientToServerMessage =
  | { type: "JOIN"; token: string }
  | { type: "SPIN_REQUEST"; betAmount: number; clientRequestId?: string }
  | { type: "BONUS_STEP"; action: string; payload?: Record<string, unknown> }
  | { type: "ROUND_RECOVER"; roundId?: string }
  | { type: "PING" };

export type ServerToClientMessage =
  | {
      type: "JOINED";
      playerId: string;
      gameId: string;
      /** Integer minor units. */
      balance: number;
      /** Present only on the first JOIN with a launch token — the reusable
       * session token the client reconnects with thereafter. */
      sessionToken?: string;
    }
  | { type: "SPIN_RESULT"; round: Round }
  | { type: "BALANCE_UPDATE"; balance: number }
  | { type: "BONUS_STEP_RESULT"; bonusState: BonusPublicState }
  | { type: "ROUND_RECOVERED"; round: Round }
  | { type: "ERROR"; code: string; message: string }
  | { type: "PONG" };
