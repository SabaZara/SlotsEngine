import type { GameDefinition } from "@slots-engine/shared-types";
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
  /**
   * The game being played, for the one class of module that needs to spin
   * the REAL reels rather than invent its own randomness — free spins.
   *
   * Optional because most modules must not have it. A wheel or a pick round
   * is self-contained: its outcome depends on `params` and `rng` alone,
   * which is what makes its expected value computable by reading the game
   * definition rather than by reading module source. Handing every module
   * the whole game definition would quietly make that untrue.
   *
   * A module that needs this must say so and fail loudly when it is absent,
   * rather than falling back to a guess — a free spin evaluated against
   * anything other than the game's own reels is a payout under mathematics
   * nobody configured.
   */
  gameDef?: GameDefinition;
  /**
   * The bonus session's own seed, for a module that must derive further
   * seeds from it — free spins turns it into one seed per spin, so the whole
   * round replays from this single stored value.
   *
   * Distinct from `rng`, which is already derived *per step*. A module
   * needing spin `n` to be reproducible from `(sessionSeed, n)` alone cannot
   * use `rng`: that stream depends on how many times `step` has been called,
   * so a replay would have to reproduce the call sequence rather than just
   * the seed.
   */
  sessionSeed?: string;
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
  /**
   * Expected return of one round of this module, as a multiple of the bet,
   * derived from the module's OWN configured payouts.
   *
   * This exists because the publish gate needs a number for a bonus it does
   * not play. It used to use a flat constant of 20 for every module and
   * every configuration, and that constant moves the gate's own input by
   * roughly 0.17 RTP against a tolerance of ±0.05 — larger than the band it
   * is compared against (docs/TODO.md item G).
   *
   * A module implements this only when its expected value is genuinely
   * computable from `params` alone. **Returning `undefined` is a real
   * answer, not a stub**: it means "this module's return depends on
   * something params cannot tell you" — player strategy, or state this
   * function does not see. The caller must then fall back to an assumption
   * and say that it did, rather than quoting a derived-looking number that
   * was guessed.
   */
  expectedReturnMultiplier?(params: Record<string, unknown>): number | undefined;
}
