/**
 * How a win is announced: the count-up, and the tier it reaches.
 *
 * Pure, for the same reason the rest of `spinMotion.ts` is — a live Pixi
 * `Application` cannot be constructed under `jsdom`, so anything that can be
 * wrong has to live outside the renderer. Here that matters more than usual,
 * because **this module handles money**, and the repo's rule is that money
 * is always an integer count of minor units.
 *
 * The reference repo shipped exactly the bug that rule exists to prevent,
 * and its own source records it: a mid-tween counter value was rendered with
 * `toFixed(2)`, which formats decimal *places* without converting minor
 * units to major ones. A 2000-minor-unit win (20.00) displayed as **"WIN
 * 2000.00"** — a hundredfold overstatement, confirmed live, in front of a
 * player. `countUpValueAt` therefore returns an **integer count of minor
 * units** at every instant, never a fraction, so the value handed to
 * `formatMoney` is always the kind of number it was built for.
 */

/** How loud the announcement should be. Ordered, so a comparison is
 * meaningful and a new tier has to decide where it sits. */
export type WinTier = "none" | "win" | "big" | "mega";

/**
 * Thresholds as a multiple of the total bet.
 *
 * Multiples of the *bet* rather than absolute amounts, because a win is only
 * big relative to what was staked: 500 minor units is a large win on a 1-unit
 * bet and a loss on a 50-unit one. Matches the reference's 15x/50x, which is
 * a conventional slot split rather than a number derived from this game.
 */
export interface WinTierThresholds {
  big: number;
  mega: number;
}

export const DEFAULT_TIER_THRESHOLDS: WinTierThresholds = { big: 15, mega: 50 };

/**
 * Which tier a win amount reaches.
 *
 * `totalBet` of zero or less returns `none` whatever the win: every
 * threshold would be zero, so a 1-unit win would read as "mega". That is not
 * hypothetical — a free spin costs nothing, so a bonus round genuinely
 * reports a win against a zero stake.
 */
export function tierFor(
  winMinor: number,
  totalBetMinor: number,
  thresholds: WinTierThresholds = DEFAULT_TIER_THRESHOLDS,
): WinTier {
  if (!Number.isFinite(winMinor) || winMinor <= 0) return "none";
  if (!Number.isFinite(totalBetMinor) || totalBetMinor <= 0) return "none";
  if (winMinor >= totalBetMinor * thresholds.mega) return "mega";
  if (winMinor >= totalBetMinor * thresholds.big) return "big";
  return "win";
}

/**
 * How long to spend counting up to a win.
 *
 * Scaled by tier rather than by amount, so the pacing communicates the
 * result: a big win that counts up in the same time as a small one throws
 * away the only moment the player is actually watching the number. Clamped
 * by construction — these are constants, not inputs — so no configuration
 * can produce a count-up that outlasts the player's patience.
 */
export function countUpDurationMs(tier: WinTier): number {
  switch (tier) {
    case "none":
      return 0;
    case "win":
      return 600;
    case "big":
      return 1400;
    case "mega":
      return 2200;
  }
}

/**
 * The displayed amount at a given instant, in **integer minor units**.
 *
 * Integer at every step, which is the guard against the reference's shipped
 * bug: `formatMoney` divides by the currency's minor-unit exponent, and it
 * is built for integers. Handing it a fractional intermediate is how a tween
 * value reaches a player's screen as a number that is not money.
 *
 * Eased rather than linear — decelerating into the final figure reads as the
 * number *arriving* rather than as a meter filling — and pinned to exactly
 * `winMinor` once elapsed reaches the duration, since an eased curve that
 * lands at 0.9999 would floor to one unit short of the real win. Displaying
 * less than was paid is the one error here that a player would notice and be
 * right about.
 */
export function countUpValueAt(elapsedMs: number, winMinor: number, durationMs: number): number {
  if (!Number.isFinite(winMinor) || winMinor <= 0) return 0;
  // A zero or negative duration means "no animation" — show the full amount
  // rather than dividing by zero and rendering NaN.
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Math.round(winMinor);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return Math.round(winMinor);

  const t = elapsedMs / durationMs;
  // Cubic ease-out. Deliberately the same curve family as `reelStrip.ts`'s
  // settle, so the reveal and the count-up feel like one movement.
  const eased = 1 - (1 - t) ** 3;
  // Floored rather than rounded: the number must never briefly show MORE
  // than was won, which rounding at the top of the curve would allow.
  return Math.min(Math.round(winMinor), Math.floor(winMinor * eased));
}

/**
 * Whether the count-up has anything left to show.
 *
 * Separate from comparing values so a caller does not have to decide what
 * "finished" means — a count-up whose final frame happens to equal its
 * previous one is still finished.
 */
export function countUpComplete(elapsedMs: number, durationMs: number): boolean {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return true;
  return Number.isFinite(elapsedMs) && elapsedMs >= durationMs;
}

/**
 * The tier crossed between two frames, if any.
 *
 * Edge-triggered rather than level-triggered: a celebration fires when the
 * count-up *crosses* a threshold, and a per-frame "what tier is it now"
 * would fire it on every frame after. Returns `null` when nothing changed,
 * so the caller's check is the same shape as its action.
 */
export function tierCrossing(previous: WinTier, next: WinTier): WinTier | null {
  return previous === next ? null : next;
}
