/**
 * What the client is currently doing, as one typed value.
 *
 * Adapted from the reference repo's `game-shell/src/state/gameStateMachine.ts`
 * — read first, per the routine at the top of `docs/TODO.md` — but not
 * transplanted. Three differences are deliberate and each is a consequence
 * of this engine's own protocol rather than a preference:
 *
 * - **No `bonusTriggered` phase.** The reference distinguishes "we know a
 *   bonus triggered" from "the bonus is interactive". Here `SPIN_RESULT`
 *   and the first `BONUS_STATE` arrive close enough together that a phase
 *   between them would be entered and left without anything observing it,
 *   and a state nothing can observe is a state nothing can test.
 * - **No `stopRequested` on `spinning`.** A spin cannot be skipped before
 *   its result exists — there is nothing settled to skip *to*. The flag
 *   therefore lives only on `revealing`, which is the phase that has one.
 * - **`revealing` rather than `evaluating`.** Nothing is being evaluated
 *   client-side; the server already decided. The name is the honest one and
 *   it matters, because "evaluating" is what a reader would expect to find
 *   computing a win — the thing this client must never do.
 *
 * The phases exist to replace scattered booleans (`spinInFlight`, renderer
 * nullability, per-element `disabled` calls), where two of them can
 * disagree and nothing notices.
 */
export type GameState =
  /** Connected, funded, waiting for the player. */
  | { phase: "idle" }
  /** Sent to the server; no result yet. Nothing to skip. */
  | { phase: "spinning" }
  /** The result is known and the reels are still moving. */
  | { phase: "revealing"; stopRequested: boolean }
  /** A bonus session is open and the player acts on it, not on the reels. */
  | { phase: "bonus" }
  /** Not connected: before the first join, or after a drop. */
  | { phase: "offline" }
  /** Terminal for this session — a spent launch token cannot be recovered
   * from in the client, so the distinction from `offline` is whether
   * reconnecting could possibly help. */
  | { phase: "unrecoverable"; code: string };

export type Phase = GameState["phase"];

/**
 * What the player may do right now.
 *
 * A pure function of state, so every enablement decision has one source.
 * The failure this prevents is the one that actually happens: an element
 * re-enabled by one code path while another still considers itself busy.
 */
export interface Enablement {
  /** The spin button responds to a click at all. */
  spinEnabled: boolean;
  /** The button means "skip the animation" rather than "spin again".
   * Distinct from `spinEnabled` because the two disagree exactly once —
   * mid-reveal, where the button is live but does something else. */
  skipAffordance: boolean;
  /** Changing the stake mid-round would attach a bet to a round that was
   * already priced. */
  betControlsEnabled: boolean;
}

export function deriveEnablement(state: GameState): Enablement {
  switch (state.phase) {
    case "idle":
      return { spinEnabled: true, skipAffordance: false, betControlsEnabled: true };
    case "spinning":
      // No result exists yet, so there is nothing to skip to. The button is
      // dead rather than showing an affordance that cannot do anything.
      return { spinEnabled: false, skipAffordance: false, betControlsEnabled: false };
    case "revealing":
      // Live, but as a skip — and only until the skip has been asked for,
      // since a second click has nothing left to do.
      return {
        spinEnabled: !state.stopRequested,
        skipAffordance: !state.stopRequested,
        betControlsEnabled: false,
      };
    case "bonus":
      // The bonus panel owns input here. Spinning the base game mid-bonus
      // would bet against a round that has not finished paying.
      return { spinEnabled: false, skipAffordance: false, betControlsEnabled: false };
    case "offline":
    case "unrecoverable":
      return { spinEnabled: false, skipAffordance: false, betControlsEnabled: false };
  }
}

/** Whether a reconnect could plausibly help — the difference between a
 * dropped socket and a spent token. Kept next to the states rather than at
 * the call site so a new terminal phase has to decide. */
export function isRecoverable(state: GameState): boolean {
  return state.phase !== "unrecoverable";
}

export type StateListener = (next: GameState, previous: GameState) => void;

/**
 * Holds the state and notifies on change.
 *
 * Deliberately not a reducer over an action type. The transitions here are
 * driven by socket messages that already have names, and adding a parallel
 * action vocabulary would mean two things to keep in step — the drift F24
 * is about, in miniature.
 */
export class GameStateMachine {
  private state: GameState;
  private readonly listeners = new Set<StateListener>();

  constructor(initial: GameState = { phase: "offline" }) {
    this.state = initial;
  }

  get current(): GameState {
    return this.state;
  }

  get enablement(): Enablement {
    return deriveEnablement(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Moves to `next` and notifies.
   *
   * A transition to the phase already held still notifies, because
   * `revealing` carries a payload — flipping `stopRequested` is a real
   * change that a listener must see. Suppressing same-phase transitions
   * would swallow exactly that one.
   */
  transition(next: GameState): void {
    const previous = this.state;
    this.state = next;
    // Iterated over a copy: a listener that unsubscribes itself while being
    // notified would otherwise mutate the set mid-iteration.
    for (const listener of [...this.listeners]) listener(next, previous);
  }

  /**
   * Asks to cut the reveal short.
   *
   * A no-op unless a reveal is actually running and has not already been
   * asked to stop — so a double-click, or a keypress racing a click, cannot
   * notify twice or reset the flag.
   */
  requestSkip(): void {
    if (this.state.phase !== "revealing" || this.state.stopRequested) return;
    this.transition({ phase: "revealing", stopRequested: true });
  }
}
