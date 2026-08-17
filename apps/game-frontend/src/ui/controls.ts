import { deriveEnablement, type GameState } from "../state/gameState.js";

/**
 * Writing enablement onto the controls.
 *
 * Split out of `main.ts` so it can be tested, and the split is the point
 * rather than tidiness: `GameApp` owns a socket and a canvas, so anything
 * left inside it is only reachable by standing up both. This function needs
 * a DOM and nothing else.
 *
 * F24 is the reason it is tested at all. A phase model can be correct, fully
 * mutation-verified, and still leave a control enabled — because being right
 * about what *should* be enabled and actually writing it to the button are
 * different claims, and only the first one had tests.
 */
export interface Controls {
  spin: HTMLButtonElement;
  /** The container, not the buttons: bet options are rebuilt when a game
   * loads, so holding references to them would go stale. */
  bets: HTMLElement;
}

/**
 * Applies `state` to the controls.
 *
 * The spin button doubles as the skip button, so its label is part of
 * enablement rather than decoration — a button reading "Spin" that skips
 * instead is a worse failure than a disabled one, because the player acts on
 * it believing they bet.
 */
export function applyEnablement(controls: Controls, state: GameState): void {
  const { spinEnabled, skipAffordance, betControlsEnabled } = deriveEnablement(state);

  controls.spin.disabled = !spinEnabled;
  controls.spin.textContent = skipAffordance ? "Skip" : "Spin";

  // Queried fresh each time rather than cached: `buildBetControls` replaces
  // these nodes when the game loads, and a cached list would then disable
  // buttons that are no longer in the document while leaving the real ones
  // live — enabled controls during a round, which is what this prevents.
  for (const bet of controls.bets.querySelectorAll<HTMLButtonElement>(".bet")) {
    bet.disabled = !betControlsEnabled;
  }
}
