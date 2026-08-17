import { formatMoney } from "./formatMoney.js";
import {
  countUpComplete,
  countUpDurationMs,
  countUpValueAt,
  tierCrossing,
  tierFor,
  type WinTier,
} from "../render/winPresentation.js";

export interface WinCountUpTargets {
  /** Where the amount is written. */
  amount: HTMLElement;
}

export interface WinCountUpOptions {
  winMinor: number;
  totalBetMinor: number;
  currency?: string;
  /** Fired once as each tier is crossed, for a celebration to hang off.
   * Edge-triggered by `tierCrossing`, so it does not repeat per frame. */
  onTier?: (tier: WinTier) => void;
  /** Injected so the count-up is testable without a real clock, and so a
   * caller can drive it from the renderer's own ticker rather than starting
   * a second animation loop. */
  now?: () => number;
  schedule?: (callback: () => void) => void;
}

/**
 * Animates a win from zero to its final figure.
 *
 * Separate from the renderer because it writes to the DOM rather than the
 * canvas — the amount is HTML, so it stays selectable and readable to a
 * screen reader — and because everything here is testable, which is not true
 * of anything inside `PixiReelRenderer`.
 *
 * **The value written is always an integer count of minor units.** That is
 * the repo's money rule and it is the guard against the bug the reference
 * shipped: a fractional intermediate formatted with `toFixed(2)` renders
 * decimal places without converting minor units, so a 2000-unit win (20.00)
 * displayed as "2000.00".
 *
 * Returns a cancel function. A spin can be skipped, and a count-up that
 * outlives its round would write a stale figure over the next one's.
 */
export function startWinCountUp(targets: WinCountUpTargets, options: WinCountUpOptions): () => void {
  const {
    winMinor,
    totalBetMinor,
    currency,
    onTier,
    now = () => performance.now(),
    schedule = (cb) => requestAnimationFrame(cb),
  } = options;

  const finalTier = tierFor(winMinor, totalBetMinor);
  const duration = countUpDurationMs(finalTier);
  const startedAt = now();
  let cancelled = false;
  let lastTier: WinTier = "none";

  const write = (value: number): void => {
    targets.amount.textContent = value > 0 ? `Win ${formatMoney(value, currency)}` : "";
  };

  // A losing spin clears the line rather than animating to zero, so the
  // previous round's win does not linger under a new result.
  if (winMinor <= 0) {
    write(0);
    return () => {};
  }

  const frame = (): void => {
    if (cancelled) return;
    const elapsed = now() - startedAt;
    const value = countUpValueAt(elapsed, winMinor, duration);
    write(value);

    // Tier is derived from the value on SCREEN, not from the final win, so
    // a celebration fires as the number crosses the threshold rather than
    // before the player has seen it get there.
    const crossed = tierCrossing(lastTier, tierFor(value, totalBetMinor));
    if (crossed) {
      lastTier = crossed;
      onTier?.(crossed);
    }

    if (!countUpComplete(elapsed, duration)) schedule(frame);
  };

  frame();
  return () => {
    cancelled = true;
  };
}

/**
 * Jumps a count-up straight to its final figure.
 *
 * Exists because skipping is always safe here for the same reason skipping
 * the reels is: the server settled the round before any of this ran. A
 * player who wants the number now should not have to wait for it to be
 * counted out to them.
 */
export function writeFinalWin(targets: WinCountUpTargets, winMinor: number, currency?: string): void {
  targets.amount.textContent = winMinor > 0 ? `Win ${formatMoney(Math.round(winMinor), currency)}` : "";
}
