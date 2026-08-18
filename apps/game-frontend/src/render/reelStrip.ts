/**
 * The spin animation's maths, kept separate from anything that draws.
 *
 * Isolated here for one reason: this is the only part of the renderer that
 * can be *wrong* in a way a screenshot won't reveal — an easing that
 * overshoots past its target, a reel that lands a pixel off its stop, a
 * stagger that lets reel 3 settle before reel 2. Pure functions of time,
 * so they can be tested at arbitrary instants without a canvas.
 */

/** Reel motion is presentation only. The outcome was decided server-side
 * before any of this runs, so nothing here can affect fairness — which is
 * precisely why the reveal is free to be as dramatic as it likes. */
export interface SpinTiming {
  /** When reel 0 begins, relative to the spin starting. */
  startDelayMs: number;
  /** How much later each subsequent reel begins. */
  staggerMs: number;
  /** How long a reel spins before it starts settling. */
  spinDurationMs: number;
  /** The settle: decelerating onto the final symbols. */
  settleDurationMs: number;
}

export const DEFAULT_TIMING: SpinTiming = {
  startDelayMs: 0,
  staggerMs: 140,
  spinDurationMs: 620,
  settleDurationMs: 520,
};

/** Total time from spin start until the last reel has fully settled. */
export function totalSpinDurationMs(timing: SpinTiming, reelCount: number): number {
  return (
    timing.startDelayMs +
    timing.staggerMs * Math.max(0, reelCount - 1) +
    timing.spinDurationMs +
    timing.settleDurationMs
  );
}

/**
 * Back-out easing: overshoots slightly past the target, then settles back.
 *
 * That overshoot is what makes a reel read as a physical object with
 * momentum rather than a list that stopped. The amount is small on purpose
 * — enough to feel weighty, not enough to look like a bug.
 */
export function easeOutBack(t: number, overshoot = 1.7): number {
  const clamped = Math.min(1, Math.max(0, t));
  // Pinned at the endpoints rather than trusting the polynomial: at t=1 the
  // expression evaluates to -2.2e-16 rather than 0, and a reel whose settle
  // target is off by a floating-point residue never lands exactly on a
  // symbol boundary.
  if (clamped === 0) return 0;
  if (clamped === 1) return 1;
  const c3 = overshoot + 1;
  return 1 + c3 * (clamped - 1) ** 3 + overshoot * (clamped - 1) ** 2;
}

/** Plain deceleration, for a hard stop with no overshoot. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

export type ReelPhase = "waiting" | "spinning" | "settling" | "stopped";

export interface ReelState {
  phase: ReelPhase;
  /**
   * Vertical offset in symbol-heights. The integer part selects which
   * symbol sits at the top of the visible window; the fraction is how far
   * it has scrolled between two positions.
   */
  offset: number;
  /** 0 while spinning, rising to 1 as the reel settles — drives motion
   * blur, so blur tracks real velocity rather than being faked. */
  settleProgress: number;
}

/**
 * Where one reel is at a given instant.
 *
 * `elapsedMs` is measured from the spin starting, so every reel is a pure
 * function of the same clock. A frame drop therefore cannot desynchronise
 * the reels: the next frame recomputes absolute positions rather than
 * advancing from wherever it happened to be.
 */
export function reelStateAt(
  elapsedMs: number,
  reelIndex: number,
  timing: SpinTiming,
  /** Symbols scrolled per second while at full speed. */
  spinSpeed = 22,
): ReelState {
  const start = timing.startDelayMs + reelIndex * timing.staggerMs;
  const settleStart = start + timing.spinDurationMs;
  const settleEnd = settleStart + timing.settleDurationMs;

  if (elapsedMs < start) {
    return { phase: "waiting", offset: 0, settleProgress: 0 };
  }

  if (elapsedMs < settleStart) {
    // Free scroll. The offset grows without bound and is taken modulo the
    // strip length by the caller, so there is no wrap discontinuity here.
    return { phase: "spinning", offset: ((elapsedMs - start) / 1000) * spinSpeed, settleProgress: 0 };
  }

  const spinOffset = (timing.spinDurationMs / 1000) * spinSpeed;

  if (elapsedMs < settleEnd) {
    const t = (elapsedMs - settleStart) / timing.settleDurationMs;
    // Travel a whole number of symbol-heights during the settle, so the
    // reel always lands exactly on a symbol boundary however the easing
    // curve is later retuned.
    const remaining = Math.ceil(spinOffset) - spinOffset + 4;
    return {
      phase: "settling",
      offset: spinOffset + remaining * easeOutBack(t),
      settleProgress: t,
    };
  }

  return { phase: "stopped", offset: Math.ceil(spinOffset) + 4, settleProgress: 1 };
}

/** Motion blur strength for a reel, from its own velocity. Peaks while
 * free-scrolling and fades to nothing as it settles, so a stopped reel is
 * always perfectly crisp. */
export function blurAmount(state: ReelState, max = 6): number {
  if (state.phase === "waiting" || state.phase === "stopped") return 0;
  if (state.phase === "spinning") return max;
  return max * (1 - easeOutCubic(state.settleProgress));
}

/**
 * Which symbol sits at a given strip index while a reel is spinning.
 *
 * The subtlety is the first frames. A reel starts at offset 0, and indexing
 * straight into the filler there replaces whatever the player was looking
 * at with an unrelated column — the grid appears to reload rather than to
 * start moving. `outgoing` is the column currently on screen, and it is
 * returned for the indices that are still within the visible window on the
 * frames before the reel has travelled a full symbol height.
 *
 * Symmetric with the settle, which already switches to the landed result
 * before the reel stops so it does not swap contents at rest. The same
 * argument applies at the other end and was missing: continuous out of the
 * old grid, continuous into the new one.
 */
export function spinningSymbolAt(
  index: number,
  row: number,
  offset: number,
  filler: readonly string[],
  outgoing: readonly string[] | undefined,
  rows: number,
): string | null {
  if (filler.length === 0) return null;
  // Still showing the outgoing column: the reel has not yet scrolled far
  // enough for the old symbols to have left the window.
  if (offset < 1 && outgoing && row >= 0 && row < rows) {
    return outgoing[row] ?? null;
  }
  const wrapped = ((index % filler.length) + filler.length) % filler.length;
  return filler[wrapped] ?? null;
}
