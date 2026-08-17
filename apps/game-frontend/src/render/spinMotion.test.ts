/**
 * The sprite renderer's motion arithmetic.
 *
 * These exist because a live Pixi `Application` cannot be tested here at
 * all: `jsdom` returns `null` for both `webgl2` and `2d` contexts, measured
 * rather than assumed. So everything that can be numerically wrong lives in
 * `spinMotion.ts` and is asserted here, and the renderer itself is left
 * holding draw calls — which a screenshot checks better than an assertion.
 *
 * Two suites below guard bugs the **reference repo actually shipped**, and
 * they are the reason this module exists in this shape rather than inline
 * in the renderer:
 *
 * - the blur unit mismatch, which made spinning reels invisible;
 * - the wrap-normalised settle distance, which lands a full cycle from the
 *   target while looking arithmetically sensible.
 *
 * What these cannot establish: that the renderer calls any of them, or
 * calls them with the arguments it should. That gap is real and is the same
 * one F24 is about — a correct function nothing invokes. It is covered as
 * far as it can be by `PixiReelRenderer`'s own construction test, and the
 * rest is a screenshot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRID_FRAME_PADDING_PX,
  MAX_BLUR_STRENGTH,
  computeBlurStrength,
  computeGridFrameSize,
  computeGridMetrics,
  heavyEffectsAllowed,
  measurementSource,
  settleDistance,
  settleDurationMs,
  shouldForceSettle,
  wrapIndex,
} from "./spinMotion.js";

describe("computeGridMetrics", () => {
  it("keeps cells square", () => {
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 1000, 600, 8);
    // One value, used for both axes. A non-square cell stretches symbol art.
    assert.equal(typeof m.cell, "number");
    assert.equal(m.gridWidth, m.cell * 5 + 8 * 4);
    assert.equal(m.gridHeight, m.cell * 3);
  });

  it("fits the whole grid in a wide, short viewport", () => {
    // Height is binding here. Cropping a reel hides symbols a player is
    // paid on, which is a correctness problem rather than a cosmetic one.
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 2000, 400, 8);
    assert.ok(m.gridHeight <= 400, `grid ${m.gridHeight} overflowed a 400px viewport`);
  });

  it("fits the whole grid in a narrow, tall viewport", () => {
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 320, 900, 8);
    assert.ok(m.gridWidth <= 320, `grid ${m.gridWidth} overflowed a 320px viewport`);
  });

  it("centres the grid", () => {
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 1000, 600, 8);
    assert.equal(m.originX, Math.round((1000 - m.gridWidth) / 2));
    assert.equal(m.originY, Math.round((600 - m.gridHeight) / 2));
  });

  it("never produces a cell smaller than one pixel", () => {
    // A zero cell yields a grid of zero area, which reads as a broken
    // renderer; a negative one mirrors every coordinate it is used in.
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 10, 10, 8);
    assert.ok(m.cell >= 1, `cell was ${m.cell}`);
  });

  it("handles a single-reel grid without subtracting a phantom gap", () => {
    // `reels - 1` gaps means one reel has none. Getting this wrong makes a
    // one-reel game narrower than its own cell.
    const m = computeGridMetrics({ reels: 1, rows: 3 }, 1000, 600, 8);
    assert.equal(m.gridWidth, m.cell);
  });

  it("widens the grid by the gap for every seam but not beyond", () => {
    const gapped = computeGridMetrics({ reels: 5, rows: 3 }, 1000, 600, 20);
    assert.equal(gapped.gridWidth, gapped.cell * 5 + 20 * 4);
  });
});

describe("computeGridFrameSize", () => {
  it("pads the grid on all four sides", () => {
    const m = computeGridMetrics({ reels: 5, rows: 3 }, 1000, 600, 8);
    const frame = computeGridFrameSize(m);
    assert.equal(frame.width, Math.round(m.gridWidth + GRID_FRAME_PADDING_PX * 2));
    assert.equal(frame.height, Math.round(m.gridHeight + GRID_FRAME_PADDING_PX * 2));
  });
});

describe("computeBlurStrength", () => {
  it("normalises against cell size rather than using raw pixels", () => {
    /**
     * The inherited bug, asserted directly. The reference applied a
     * row-unit factor to a pixel delta; a 15px/frame delta then produced a
     * strength around 120 against a filter default of 8, and the reels
     * blurred into apparent invisibility.
     *
     * The property that prevents it: the same *fraction of a cell* must
     * give the same strength at any cell size. A raw-pixel implementation
     * fails this, because 15px is most of a small cell and little of a
     * large one.
     */
    const small = computeBlurStrength(5, 50);
    const large = computeBlurStrength(20, 200);
    assert.equal(small, large, "the same fraction of a cell must blur identically at any scale");
  });

  it("never exceeds the ceiling, however extreme the input", () => {
    // The guarantee, not a tuning outcome: no combination of cell size,
    // speed or factor may wash the reels out.
    for (const [delta, cell] of [
      [1000, 10],
      [1e6, 1],
      [500, 4],
    ] as const) {
      const strength = computeBlurStrength(delta, cell);
      assert.ok(strength <= MAX_BLUR_STRENGTH, `${strength} exceeded the ceiling for delta ${delta}, cell ${cell}`);
    }
  });

  it("reaches zero when a reel stops, with no separate switch-off step", () => {
    assert.equal(computeBlurStrength(0, 100), 0);
  });

  it("is a magnitude, so scrolling up blurs like scrolling down", () => {
    assert.equal(computeBlurStrength(-12, 80), computeBlurStrength(12, 80));
  });

  it("refuses a non-positive cell rather than returning Infinity", () => {
    // Dividing by a zero cell reads to the filter as "blur everything".
    assert.equal(computeBlurStrength(10, 0), 0);
    assert.equal(computeBlurStrength(10, -5), 0);
  });

  it("refuses a non-finite delta", () => {
    assert.equal(computeBlurStrength(Number.NaN, 80), 0);
    assert.equal(computeBlurStrength(Number.POSITIVE_INFINITY, 80), 0);
  });

  it("rises with speed below the ceiling", () => {
    // Without this the cap could be satisfied by returning a constant.
    assert.ok(computeBlurStrength(2, 100) < computeBlurStrength(6, 100));
  });
});

describe("wrapIndex", () => {
  it("wraps a negative index to the end of the strip", () => {
    // `%` keeps the dividend's sign in JavaScript, so -1 reads past the
    // start of the array and draws nothing. The symptom is blank cells
    // while scrolling one direction only, which is why it survives casual
    // testing.
    assert.equal(wrapIndex(-1, 5), 4);
    assert.equal(wrapIndex(-6, 5), 4);
  });

  it("wraps a positive index past the end", () => {
    assert.equal(wrapIndex(5, 5), 0);
    assert.equal(wrapIndex(12, 5), 2);
  });

  it("leaves an in-range index alone", () => {
    assert.equal(wrapIndex(3, 5), 3);
  });

  it("truncates a fractional index rather than returning a fraction", () => {
    // The fraction is the sub-cell scroll offset and is the caller's
    // business; an array index must be whole.
    assert.equal(wrapIndex(2.7, 5), 2);
    assert.equal(wrapIndex(-0.5, 5), 0);
  });

  it("survives an empty strip instead of dividing by zero", () => {
    assert.equal(wrapIndex(3, 0), 0);
  });
});

describe("settleDistance", () => {
  it("is the single distance that lands on the target", () => {
    assert.equal(settleDistance(100, 340), 240);
  });

  it("may be negative, and that is the accepted trade", () => {
    /**
     * The second inherited bug. "Wrap-normalising" this to an
     * always-forward distance was tried and reverted twice in the
     * reference, because the strip is a finite sprite array rather than a
     * tiling one — the adjusted distance lands a full cycle from the target
     * while looking arithmetically reasonable.
     *
     * A slight backward nudge is visible. Landing on the wrong symbols is
     * worse: the reels would then disagree with the win lines drawn over
     * them, which reads as a fairness bug rather than a cosmetic one.
     */
    assert.equal(settleDistance(340, 100), -240);
  });

  it("applied to the current position reaches the target exactly", () => {
    // The property the wrap-normalised version broke, stated as such.
    for (const [current, target] of [
      [0, 500],
      [500, 0],
      [123.5, 987.25],
    ] as const) {
      assert.equal(current + settleDistance(current, target), target);
    }
  });
});

describe("settleDurationMs", () => {
  it("takes longer for a further settle", () => {
    assert.ok(settleDurationMs(100, 80) < settleDurationMs(600, 80));
  });

  it("never snaps below the floor", () => {
    assert.ok(settleDurationMs(0, 80) >= 260);
  });

  it("never outlasts the ceiling", () => {
    assert.ok(settleDurationMs(100_000, 80) <= 900);
  });

  it("falls back to the floor rather than NaN for a broken cell size", () => {
    // A NaN duration passed to a tween never completes, which leaves the
    // reels stuck mid-settle and the round apparently unfinished.
    assert.equal(settleDurationMs(100, 0), 260);
    assert.equal(settleDurationMs(Number.NaN, 80), 260);
  });

  it("is symmetric, since a backward settle is the same journey", () => {
    assert.equal(settleDurationMs(-300, 80), settleDurationMs(300, 80));
  });
});

describe("shouldForceSettle", () => {
  /**
   * Guards a bug found by running the client, not by reading it. Browsers
   * throttle `requestAnimationFrame` to zero in a hidden tab, and the
   * settle is detected inside the draw loop — so switching tabs mid-spin
   * left the round permanently unfinished: spin disabled, button reading
   * "Skip", status "Spinning…". Measured: 0 frames in 500ms while hidden.
   */
  const TOTAL = 1700;

  it("completes a reveal whose animation time already elapsed while hidden", () => {
    assert.equal(shouldForceSettle(false, 1000, 1000 + TOTAL, TOTAL), true);
    assert.equal(shouldForceSettle(false, 1000, 9999, TOTAL), true);
  });

  it("lets a briefly-hidden spin finish its animation normally", () => {
    // The narrowness is deliberate. Snatching away the rest of a reveal
    // the player is watching is a worse outcome than a moment's delay.
    assert.equal(shouldForceSettle(false, 1000, 1000 + TOTAL / 2, TOTAL), false);
  });

  it("does nothing while still hidden, since nothing is being watched", () => {
    assert.equal(shouldForceSettle(true, 1000, 99999, TOTAL), false);
  });

  it("does nothing when no reveal is running", () => {
    assert.equal(shouldForceSettle(false, null, 99999, TOTAL), false);
  });

  it("completes exactly at the boundary rather than one frame late", () => {
    // A strict `>` would leave a reveal that ended on the exact millisecond
    // waiting for a frame that a hidden tab never delivers.
    assert.equal(shouldForceSettle(false, 0, TOTAL, TOTAL), true);
  });
});

describe("measurementSource", () => {
  it("measures the parent rather than the canvas itself", () => {
    /**
     * The rule, and it is worth a test because getting it wrong is
     * invisible in review and obvious only on screen.
     *
     * Pixi's `autoDensity` writes an **inline** `style.width` onto the
     * canvas, which beats the stylesheet's `width: 100%`. Measuring the
     * canvas then reads back the number Pixi just wrote instead of the
     * space available — a feedback loop that pins the grid at Pixi's
     * default 800x600 however large the window gets. Observed on the
     * running client: an 800x600 canvas inside a 1280x596 container, with
     * the grid correctly centred inside the wrong box.
     */
    const parent = { clientWidth: 1280, clientHeight: 596 } as unknown as Element;
    const canvas = { parentElement: parent, clientWidth: 800, clientHeight: 600 };

    assert.equal(measurementSource(canvas), parent, "measuring the canvas re-reads Pixi's own inline size");
  });

  it("falls back to the canvas when it has no parent", () => {
    // Only a detached element. Returning null here would throw on the very
    // next property read.
    const canvas = { parentElement: null, clientWidth: 800, clientHeight: 600 };
    assert.equal(measurementSource(canvas), canvas);
  });
});

describe("heavyEffectsAllowed", () => {
  it("suppresses heavy effects while any reel is moving", () => {
    // Blur and glow are cheap at rest and expensive on a translating
    // sprite. One answer to "are we spinning", for the same reason
    // enablement has one.
    assert.equal(heavyEffectsAllowed(true), false);
    assert.equal(heavyEffectsAllowed(false), true);
  });
});
