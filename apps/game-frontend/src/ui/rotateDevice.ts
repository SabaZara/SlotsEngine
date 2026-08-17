/**
 * Asking a player to turn a narrow phone sideways.
 *
 * **Both conditions matter, and the second is the one that gets forgotten.**
 * A tablet in portrait has plenty of room; a desktop window taller than it
 * is wide is still a desktop. Prompting either would be nagging a player who
 * can already see the game perfectly well, so the overlay appears only when
 * the viewport is *both* portrait and genuinely narrow.
 *
 * **`matchMedia("(orientation: portrait)")` rather than comparing width to
 * height**, inherited from the reference and the one detail worth copying
 * exactly. The comparison looks equivalent and is not: it silently treats a
 * short desktop window as a portrait phone, and — more importantly — it only
 * re-evaluates when something else happens to trigger a resize. The media
 * query fires on the orientation change itself, which is precisely the
 * moment the overlay needs to clear.
 *
 * This is the presentational half of responsive support, which
 * `docs/TODO.md` records as deprioritised. The *correctness* half already
 * holds without it: `computeGridMetrics` fits the grid to whichever axis is
 * tighter, so reels never crop and no symbol a player is being paid on can
 * be hidden. This only asks for a better view of something already visible.
 */

/**
 * Below this width, a portrait viewport is treated as a phone.
 *
 * 560px rather than a round 600: it sits above every common phone in
 * portrait (a 430pt iPhone Pro Max, a 412dp Android) and below every tablet
 * (768 and up), so the two groups fall cleanly on either side rather than
 * near the boundary.
 */
export const PORTRAIT_BREAKPOINT_PX = 560;

/**
 * Whether to ask the player to rotate.
 *
 * Pure and exported so the rule is testable without a viewport — the
 * reference keeps this inside a Pixi container, where it can only be
 * exercised by resizing a real window.
 */
export function shouldPromptRotate(isPortrait: boolean, viewportWidth: number, breakpointPx = PORTRAIT_BREAKPOINT_PX): boolean {
  if (!isPortrait) return false;
  // A non-finite width means the caller could not measure the viewport.
  // Refusing to prompt is the safer wrong answer: a spurious overlay blocks
  // a game the player can see, while a missing one costs a rotation hint.
  if (!Number.isFinite(viewportWidth)) return false;
  return viewportWidth < breakpointPx;
}

export interface RotateDeviceOverlayTargets {
  overlay: HTMLElement;
}

/**
 * Shows and hides the overlay, and keeps listening for the rotation.
 *
 * Constructed with the window it observes so a test can supply a stand-in,
 * and because reaching for the global inside makes the whole class
 * unreachable from a test that has no DOM.
 */
export class RotateDeviceOverlay {
  private readonly mediaQuery: MediaQueryList;
  private readonly onChange: () => void;

  constructor(
    private readonly targets: RotateDeviceOverlayTargets,
    private readonly view: {
      matchMedia: (query: string) => MediaQueryList;
      innerWidth: number;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    },
  ) {
    this.mediaQuery = view.matchMedia("(orientation: portrait)");
    this.onChange = () => this.refresh();

    this.mediaQuery.addEventListener("change", this.onChange);
    // Resize is listened for as well as orientation, because a desktop
    // window can cross the breakpoint without ever changing orientation —
    // and on some browsers a rotation reports as a resize first.
    view.addEventListener("resize", this.onChange);

    this.refresh();
  }

  refresh(): void {
    const prompt = shouldPromptRotate(this.mediaQuery.matches, this.view.innerWidth);
    this.targets.overlay.hidden = !prompt;
  }

  destroy(): void {
    this.mediaQuery.removeEventListener("change", this.onChange);
    this.view.removeEventListener("resize", this.onChange);
  }
}
