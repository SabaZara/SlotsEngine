/**
 * The spin's motion maths, with no dependency on Pixi, GSAP or a canvas.
 *
 * The split is not stylistic. `jsdom` provides **no WebGL and no 2D
 * context** — measured, not assumed — so a live `Application` cannot be
 * stood up in a test at all. Anything that can be *wrong* therefore has to
 * live outside the renderer: an easing that overshoots its target, a reel
 * that lands off a symbol boundary, a blur that washes the reels out. What
 * is left inside the renderer is draw calls, which a screenshot checks
 * better than an assertion would.
 *
 * This extends `reelStrip.ts` rather than replacing it. That module already
 * owns the phase timing (`reelStateAt`, `blurAmount`, the easing curves)
 * under 19 tests, and its central property — **reel state is a pure
 * function of elapsed time**, so a dropped frame cannot desynchronise the
 * reels — is exactly what a Pixi rewrite must not lose. What is new here is
 * the arithmetic a *sprite-based* renderer needs and a canvas one did not:
 * pixel positions, wrapping, and a blur strength in filter units.
 *
 * Two of the functions below exist because the reference repo shipped the
 * bug and recorded it. Inheriting the guard is the cheap half of the
 * lesson; re-deriving it in production is the expensive half.
 */

/** Breathing room between the grid's edge and its frame, on all four
 * sides. Exported because the renderer and any layout guidance must agree —
 * two copies of a padding constant drift the moment one is tuned. */
export const GRID_FRAME_PADDING_PX = 8;

export interface GridShape {
  reels: number;
  rows: number;
}

export interface GridMetrics {
  /** One cell, square. */
  cell: number;
  /** Between reel columns. Never widens a cell, only the grid. */
  reelGap: number;
  gridWidth: number;
  gridHeight: number;
  /** Top-left of the grid, so it sits centred in the viewport. */
  originX: number;
  originY: number;
}

/**
 * Fits the grid to whichever axis is tighter.
 *
 * The whole grid must always be visible: cropping a reel hides symbols a
 * player is being paid on, which is a different failure from looking bad.
 * So the cell size is bound by width *and* height, and the smaller wins.
 */
export function computeGridMetrics(
  grid: GridShape,
  viewportWidth: number,
  viewportHeight: number,
  reelGap: number,
  /** Fraction of each axis the grid may occupy, leaving room for chrome. */
  widthFraction = 0.92,
  heightFraction = 0.82,
): GridMetrics {
  const usableWidth = viewportWidth * widthFraction - reelGap * Math.max(0, grid.reels - 1);
  const usableHeight = viewportHeight * heightFraction;

  // Floored, and never below 1: a zero or fractional cell produces a grid
  // of zero area that reads as "the renderer is broken" rather than as a
  // tiny window, and a negative one silently mirrors every coordinate.
  const cell = Math.max(1, Math.floor(Math.min(usableWidth / grid.reels, usableHeight / grid.rows)));

  const gridWidth = cell * grid.reels + reelGap * Math.max(0, grid.reels - 1);
  const gridHeight = cell * grid.rows;

  return {
    cell,
    reelGap,
    gridWidth,
    gridHeight,
    originX: Math.round((viewportWidth - gridWidth) / 2),
    originY: Math.round((viewportHeight - gridHeight) / 2),
  };
}

/** The frame's outer box. Shares this module's padding with the renderer so
 * the two cannot disagree about where the border sits. */
export function computeGridFrameSize(metrics: GridMetrics): { width: number; height: number } {
  return {
    width: Math.round(metrics.gridWidth + GRID_FRAME_PADDING_PX * 2),
    height: Math.round(metrics.gridHeight + GRID_FRAME_PADDING_PX * 2),
  };
}

/**
 * Which element's box the renderer should size itself from.
 *
 * Extracted and tested because getting it wrong is invisible in code review
 * and obvious only on screen. Pixi's `autoDensity` writes an **inline**
 * `style.width`/`style.height` onto the canvas, and an inline style beats
 * the stylesheet's `width: 100%`. Measure the canvas and you read back the
 * number Pixi just wrote rather than the space available — a feedback loop
 * that pins the grid at Pixi's default 800x600 however large the window is.
 * Measured on the running client: an 800x600 canvas inside a 1280x596
 * container, with the grid correctly centred inside the wrong box.
 *
 * The parent is set by the stylesheet and nothing writes back to it, so it
 * is the only measurement that stays honest. Falls back to the canvas when
 * there is no parent, which happens only for a detached element.
 */
export function measurementSource(canvas: { parentElement: Element | null }): Element | { parentElement: Element | null } {
  return canvas.parentElement ?? canvas;
}

/**
 * Hard ceiling on blur strength.
 *
 * A safety guarantee rather than a tuning knob, and it is inherited from a
 * bug the reference repo shipped: it applied a factor meant for *row* units
 * to a delta measured in *pixels*, producing a blur ~15x the filter's own
 * default. The reels did not look fast, they looked gone — reported as
 * "just going up and disappears". Normalising the delta fixes the units;
 * this cap is what makes the failure impossible rather than merely
 * corrected, whatever cell size or speed a future game configures.
 */
export const MAX_BLUR_STRENGTH = 16;

/**
 * Per-frame pixel movement to a blur strength in filter units.
 *
 * `deltaPx` is normalised against `cell` first, giving a dimensionless
 * "fraction of a cell travelled this frame" — the quantity the factor is
 * actually calibrated in. Skipping that normalisation is the unit mismatch
 * described above.
 *
 * Always non-negative (strength is a magnitude, not a direction) and
 * naturally reaching 0 as the reel stops, so no separate "switch the blur
 * off" step exists to be forgotten.
 */
export function computeBlurStrength(deltaPx: number, cell: number, factor = 26): number {
  // A non-positive cell would divide by zero and yield Infinity, which
  // reads to the filter as "blur everything". Refused rather than clamped,
  // since it can only arise from a layout bug worth surfacing.
  if (!Number.isFinite(deltaPx) || !Number.isFinite(cell) || cell <= 0) return 0;
  const fractionOfCellPerFrame = Math.abs(deltaPx) / cell;
  return Math.min(fractionOfCellPerFrame * factor, MAX_BLUR_STRENGTH);
}

/**
 * Which strip index sits at a given row, wrapped.
 *
 * JavaScript's `%` keeps the sign of the dividend, so a negative scroll
 * offset yields a negative index and reads past the start of the array —
 * `undefined`, which draws nothing. A reel that renders blank cells while
 * scrolling upward is the symptom, and it appears only in one direction,
 * which is why it survives casual testing.
 */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((Math.trunc(index) % length) + length) % length;
}

/**
 * How far a reel must still travel to land exactly on its stop.
 *
 * There is exactly **one** distance that lands on the target:
 * `target - current`. The reference repo twice tried to "wrap-normalise"
 * this into a always-forward distance and reverted it both times, because
 * the strip is a finite sprite array rather than a genuinely tiling one —
 * so a wrap-adjusted distance lands a full cycle away from the target while
 * looking arithmetically reasonable.
 *
 * The consequence accepted here is that a settle may occasionally travel
 * *against* the scroll direction by a fraction of a cell. That is visible
 * only as a slight backward nudge, and it is strictly better than landing
 * on the wrong symbols — the reels would then disagree with the win lines
 * drawn over them, which is a fairness-looking bug rather than a cosmetic
 * one.
 */
export function settleDistance(currentY: number, targetY: number): number {
  return targetY - currentY;
}

/**
 * How long the settle should take, scaled by how far is left.
 *
 * A fixed duration makes a long settle crawl and a short one snap. Clamped
 * at both ends so an unusual distance cannot produce a settle that is over
 * before it is seen, or one that outlasts the player's patience.
 */
export function settleDurationMs(
  distancePx: number,
  cell: number,
  { baseMs = 420, minMs = 260, maxMs = 900 } = {},
): number {
  if (!Number.isFinite(distancePx) || !Number.isFinite(cell) || cell <= 0) return minMs;
  const cellsRemaining = Math.abs(distancePx) / cell;
  return Math.min(maxMs, Math.max(minMs, baseMs * (0.5 + cellsRemaining * 0.1)));
}

/**
 * Whether a reveal that stopped animating must be force-completed.
 *
 * A real bug, found by running the client rather than by reading it.
 * Browsers throttle `requestAnimationFrame` to **zero** in a hidden tab,
 * and the settle is detected inside the draw loop — so a player who
 * switches tabs mid-spin returns to a round that never completed: spin
 * still disabled, the button still reading "Skip", the status still
 * "Spinning…". Measured directly: `document.hidden === true` produced 0
 * frames in 500ms and a reveal that stayed stuck for as long as it was
 * observed.
 *
 * The money was never at risk — the server settled the round before any of
 * this ran — which is precisely why the client must not be what strands it.
 *
 * The condition is deliberately narrow. Becoming visible again only forces
 * completion when the animation **would already have finished**; a tab
 * hidden for a moment mid-spin should still see the rest of its reveal
 * rather than having it snatched away.
 */
export function shouldForceSettle(
  hidden: boolean,
  spinStartedAt: number | null,
  now: number,
  totalDurationMs: number,
): boolean {
  if (hidden || spinStartedAt === null) return false;
  return now - spinStartedAt >= totalDurationMs;
}

/**
 * Whether heavy per-symbol effects may run right now.
 *
 * Blur and glow are cheap at rest and expensive on a tall translating
 * sprite, which is what a spinning reel is. One flag every effect consults,
 * rather than each deciding for itself — the point being that "are we
 * spinning" must have a single answer, the same argument the phase model
 * makes for enablement.
 */
export function heavyEffectsAllowed(anyReelMoving: boolean): boolean {
  return !anyReelMoving;
}
