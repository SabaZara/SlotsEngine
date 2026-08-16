import type { Rng } from "@slots-engine/rng";

export interface BonusStepInput {
  /** Integer minor units — the bet that triggered this bonus. Module
   * payouts are expressed as a multiple of it. */
  totalBet: number;
  /** The module's own progress state, as it left it last step. */
  state: Record<string, unknown>;
  /** Designer-supplied parameters from `BonusModuleConfig.params`. */
  params: Record<string, unknown>;
  /** Client-requested action ("pick", "spin", "cashout", ...). */
  action: string;
  payload?: Record<string, unknown>;
  /**
   * Seeded from the bonus session, never from fresh entropy at step time.
   * A module's randomness must be replayable for exactly the same audit
   * reason a spin's is — see `deriveStepRng`.
   */
  rng: Rng;
}

export interface BonusStepOutput {
  /** The module's state to persist for the next step. */
  state: Record<string, unknown>;
  /** True once the round is over and `totalWin` is final. */
  done: boolean;
  /** Integer minor units. Only meaningful when `done` is true. */
  totalWin: number;
  /** What the client is allowed to see — never the unrevealed remainder. */
  view: Record<string, unknown>;
}

export class InvalidBonusActionError extends Error {}

/**
 * A self-contained bonus round. A module owns its own state shape, its own
 * randomness usage and its own payout rule; game-backend only ever moves it
 * between `active`, `resolved` and `abandoned` and credits the final
 * `totalWin` exactly once.
 *
 * `start` and `step` must be **pure functions of their inputs** — same
 * state, params, action and rng in, same output out. That is what lets a
 * dispute be resolved by replay rather than by trusting a log.
 */
export interface BonusModule {
  moduleId: string;
  /** Called once when a spin triggers this module. A single-step module
   * (a wheel) may return `done: true` immediately. */
  start(input: Omit<BonusStepInput, "action" | "payload">): BonusStepOutput;
  /** Called for each client action on a multi-step module. */
  step(input: BonusStepInput): BonusStepOutput;
}
