/**
 * Autoplay: a bounded run of spins the player does not have to click for.
 *
 * **Pure state, no DOM and no socket.** The reference builds this as a Pixi
 * widget with the loop logic inside it, which makes the loop reachable only
 * by standing up a renderer. Every decision here — may it start, should it
 * fire again, must it stop — is an ordinary function of the phase and a
 * counter, and those are exactly the decisions that can be silently wrong.
 * `main.ts` owns the wiring; this owns the rules.
 *
 * ## The rules, and why each exists
 *
 * **No unlimited option.** The counts are fixed and finite. This engine has
 * no loss limit, no session limit and no responsible-gambling backing of any
 * kind, and "spin until the money runs out" is a materially different
 * product from "spin 25 times". That is a deliberate scope boundary
 * inherited from the reference, not an oversight — and it is the one item
 * here that should be revisited by someone other than an engineer.
 *
 * **It stops on anything unexpected.** A run that keeps firing into a broken
 * session is the worst failure available to this feature: every spin is real
 * money against a server that may not be answering. So a refused send, a
 * disconnect, a terminal error and an exhausted counter all stop it, and
 * `stop()` is safe to call when it is already stopped.
 *
 * **It waits out a bonus rather than driving it.** A bonus round needs real
 * player decisions (which tile, when to spin). Autoplay resumes when the
 * phase returns to `idle`, which happens after the bonus resolves and the
 * client hands control back.
 *
 * ## A caution for whoever verifies this in a browser
 *
 * **A run appears to stall after its first spin in a hidden or background
 * tab, and autoplay is not the reason.** The loop advances on the phase
 * returning to `idle`, which happens when the reel reveal completes — and
 * the reveal is driven by `requestAnimationFrame`, which browsers throttle
 * to *zero* when the tab is not visible. Measured while building this: a
 * run showed "9 left" and "Spinning…" indefinitely, with exactly one round
 * recorded, and resumed the instant the tab was brought forward.
 *
 * That is `shouldForceSettle`'s territory in `spinMotion.ts`, not a defect
 * here — but it is indistinguishable from a broken loop if you do not know
 * to check `document.hidden` first. Check it before debugging anything in
 * this file.
 */

import type { GameState } from "./gameState.js";

/**
 * How many spins a run may be set to.
 *
 * Finite by design — see the header. Exported so the UI renders exactly
 * these and cannot offer a count the loop does not understand.
 */
export const AUTOPLAY_SPIN_COUNTS = [10, 25, 50, 100] as const;

export type AutoplaySpinCount = (typeof AUTOPLAY_SPIN_COUNTS)[number];

export interface AutoplaySettings {
  /** How many spins a fresh run gets. */
  count: AutoplaySpinCount;
  /** Stop as soon as a spin pays anything at all. The player asked to
   * watch a run, not to miss the moment it paid. */
  stopOnWin: boolean;
}

export interface AutoplayStatus {
  running: boolean;
  /** Spins left in the current run, including one in flight. Zero when
   * stopped. */
  remaining: number;
  /** Whether the start control should respond to a click. A run in
   * progress is stoppable, so this is true while running too. */
  toggleEnabled: boolean;
  /** Whether the count and stop-on-win controls may be changed. Locked
   * mid-run: changing the length of a run already underway is ambiguous
   * (does 50 mean 50 more, or 50 total?) and every answer surprises
   * someone. */
  settingsEnabled: boolean;
}

/**
 * Why a run ended. Reported rather than swallowed so the UI can say
 * something true — "finished" and "stopped because the connection dropped"
 * are the same silence to a player watching the reels.
 */
export type AutoplayStopReason =
  | "completed"
  | "stoppedByPlayer"
  | "wonWhileStopOnWin"
  | "spinRefused"
  | "sessionEnded";

export interface AutoplayCallbacks {
  /**
   * Requests one spin, exactly as the spin button would.
   *
   * Returns whether the spin was actually sent. `false` stops the run —
   * a counter that decrements while nothing reaches the server would leave
   * autoplay looking busy and doing nothing, which is worse than stopping.
   */
  requestSpin: () => boolean;
  /** Called once whenever a run ends, with why. */
  onStopped?: (reason: AutoplayStopReason) => void;
  /** Called whenever anything a UI renders has changed. */
  onChanged?: () => void;
}

/**
 * Whether a run may begin from this state.
 *
 * Only from `idle`, and that is stricter than it looks: it also refuses
 * `revealing`, where a spin button is live but means "skip". Starting a run
 * there would fire its first spin into an animation the player is still
 * watching.
 */
export function canStartAutoplay(state: GameState): boolean {
  return state.phase === "idle";
}

/**
 * Whether a phase change means the session is over for autoplay's purposes.
 *
 * `offline` counts. A reconnect may well succeed, but the run must not
 * silently resume afterwards — the player would return to a client spending
 * money on spins they did not watch begin.
 */
export function isSessionEnding(state: GameState): boolean {
  return state.phase === "offline" || state.phase === "unrecoverable";
}

export class AutoplayController {
  private settings: AutoplaySettings = { count: AUTOPLAY_SPIN_COUNTS[0], stopOnWin: false };
  private running = false;
  private remaining = 0;
  private lastState: GameState;

  constructor(
    initialState: GameState,
    private readonly callbacks: AutoplayCallbacks,
  ) {
    this.lastState = initialState;
  }

  get status(): AutoplayStatus {
    return {
      running: this.running,
      remaining: this.remaining,
      // A run in progress must always be stoppable, even from a phase that
      // could not have started one. Otherwise a player who wants out has to
      // wait for a spin to finish first.
      toggleEnabled: this.running || canStartAutoplay(this.lastState),
      settingsEnabled: !this.running,
    };
  }

  get currentSettings(): AutoplaySettings {
    return { ...this.settings };
  }

  /** Ignored mid-run — see `settingsEnabled`. */
  setCount(count: AutoplaySpinCount): void {
    if (this.running) return;
    this.settings = { ...this.settings, count };
    this.callbacks.onChanged?.();
  }

  /** Ignored mid-run, for the same reason as `setCount`. */
  setStopOnWin(stopOnWin: boolean): void {
    if (this.running) return;
    this.settings = { ...this.settings, stopOnWin };
    this.callbacks.onChanged?.();
  }

  start(): void {
    if (this.running || !canStartAutoplay(this.lastState)) return;
    this.running = true;
    this.remaining = this.settings.count;
    this.callbacks.onChanged?.();
    this.fireNext();
  }

  stop(reason: AutoplayStopReason = "stoppedByPlayer"): void {
    // Guarded so a stop arriving from two directions at once — the player
    // clicking as the socket drops — reports one ending, not two.
    if (!this.running) return;
    this.running = false;
    this.remaining = 0;
    this.callbacks.onStopped?.(reason);
    this.callbacks.onChanged?.();
  }

  toggle(): void {
    if (this.running) this.stop("stoppedByPlayer");
    else this.start();
  }

  /**
   * Told the phase changed.
   *
   * The loop's whole engine: a run fires its next spin when the client
   * returns to `idle`, which is also what makes it wait out a bonus without
   * knowing anything about bonuses.
   */
  handleStateChange(state: GameState): void {
    this.lastState = state;

    if (this.running && isSessionEnding(state)) {
      this.stop("sessionEnded");
      return;
    }

    if (this.running && state.phase === "idle") {
      this.fireNext();
      return;
    }

    this.callbacks.onChanged?.();
  }

  /**
   * Told what a finished spin paid.
   *
   * Separate from `handleStateChange` because the phase says a round ended
   * and says nothing about whether it paid. Called with the **base game's**
   * win: a spin that triggers a bonus has already halted the loop until the
   * bonus resolves, and stopping on the bonus's credit as well would end the
   * run at a moment the player did not choose.
   */
  notifySpinResult(totalWinMinor: number): void {
    if (!this.running || !this.settings.stopOnWin) return;
    if (totalWinMinor > 0) this.stop("wonWhileStopOnWin");
  }

  private fireNext(): void {
    if (!this.running) return;

    if (this.remaining <= 0) {
      this.stop("completed");
      return;
    }

    // Decremented BEFORE the request, so a spin that is sent always costs a
    // count. Decrementing after would let a refused-then-retried send fire
    // more spins than the player asked for, which is real money.
    this.remaining -= 1;
    this.callbacks.onChanged?.();

    if (!this.callbacks.requestSpin()) {
      this.stop("spinRefused");
    }
  }
}
