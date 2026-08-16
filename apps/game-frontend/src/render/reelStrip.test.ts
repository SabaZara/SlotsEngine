import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TIMING,
  blurAmount,
  easeOutBack,
  easeOutCubic,
  reelStateAt,
  totalSpinDurationMs,
} from "./reelStrip.js";

/**
 * The spin animation is the one part of the renderer that can be wrong in a
 * way a screenshot won't show: a reel that settles before an earlier one, an
 * easing curve that never reaches its target, blur left on a stopped reel.
 * Pure functions of elapsed time, so each is checked at exact instants.
 */

describe("easing", () => {
  it("starts at 0 and ends at exactly 1", () => {
    // If the curve doesn't land on 1, every reel stops fractionally off its
    // symbol boundary — a permanent, subtle misalignment.
    assert.equal(easeOutBack(0), 0);
    assert.equal(easeOutBack(1), 1);
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
  });

  it("overshoots past the target before settling back", () => {
    // The overshoot is what makes a reel read as a physical object with
    // momentum rather than a list that stopped.
    const samples = Array.from({ length: 99 }, (_, i) => easeOutBack((i + 1) / 100));
    assert.ok(Math.max(...samples) > 1, "back easing should exceed 1 before returning to it");
  });

  it("keeps the overshoot modest", () => {
    // A large overshoot stops looking like weight and starts looking like
    // a bug — the reel visibly bounces.
    assert.ok(Math.max(...Array.from({ length: 99 }, (_, i) => easeOutBack((i + 1) / 100))) < 1.15);
  });

  it("never overshoots on the hard-stop curve", () => {
    for (let i = 0; i <= 100; i++) {
      const value = easeOutCubic(i / 100);
      assert.ok(value >= 0 && value <= 1, `easeOutCubic(${i / 100}) = ${value} left [0,1]`);
    }
  });

  it("clamps input outside [0,1] rather than extrapolating wildly", () => {
    // A dropped frame can produce a slightly out-of-range t; extrapolating
    // would fling the reel off-grid.
    assert.equal(easeOutBack(-5), 0);
    assert.equal(easeOutBack(5), 1);
  });
});

describe("reelStateAt", () => {
  const timing = DEFAULT_TIMING;

  it("holds a reel still before its turn", () => {
    const state = reelStateAt(0, 2, timing);
    assert.equal(state.phase, "waiting");
    assert.equal(state.offset, 0);
  });

  it("starts each reel later than the one before it", () => {
    // Reels landing simultaneously is the single most common way a slot
    // animation reads as cheap.
    const atStart = reelStateAt(timing.startDelayMs + 10, 0, timing);
    const laterReel = reelStateAt(timing.startDelayMs + 10, 3, timing);
    assert.equal(atStart.phase, "spinning");
    assert.equal(laterReel.phase, "waiting");
  });

  it("settles reels strictly left to right", () => {
    // Checked as a real ordering across the whole animation, not just at
    // one instant: a later reel must never stop before an earlier one.
    const total = totalSpinDurationMs(timing, 5);
    for (let t = 0; t <= total; t += 20) {
      const phases = Array.from({ length: 5 }, (_, reel) => reelStateAt(t, reel, timing).phase);
      const stopped = phases.map((p) => p === "stopped");
      // Once a reel is not stopped, no reel to its right may be stopped.
      const firstRunning = stopped.indexOf(false);
      if (firstRunning >= 0) {
        assert.ok(
          stopped.slice(firstRunning).every((s) => !s),
          `at t=${t} a right-hand reel stopped before reel ${firstRunning}: ${phases.join(",")}`,
        );
      }
    }
  });

  it("progresses through every phase in order", () => {
    const seen: string[] = [];
    for (let t = 0; t <= totalSpinDurationMs(timing, 1); t += 10) {
      const phase = reelStateAt(t, 0, timing).phase;
      if (seen[seen.length - 1] !== phase) seen.push(phase);
    }
    assert.deepEqual(seen, ["spinning", "settling", "stopped"]);
  });

  it("never scrolls backwards except for the settle overshoot", () => {
    // A back-ease deliberately passes its target and returns, so strict
    // monotonicity is the wrong invariant. What matters is that the recoil
    // stays well under one symbol-height: a reel that visibly rewinds past
    // a symbol reads as a glitch, while a sub-symbol recoil reads as weight.
    let previous = -Infinity;
    let peak = -Infinity;
    for (let t = 0; t <= totalSpinDurationMs(timing, 1); t += 5) {
      const { offset, phase } = reelStateAt(t, 0, timing);
      peak = Math.max(peak, offset);
      if (phase === "spinning") {
        assert.ok(offset >= previous - 1e-9, `free scroll went backwards at t=${t}`);
      }
      previous = offset;
    }
    const resting = reelStateAt(totalSpinDurationMs(timing, 1) + 500, 0, timing).offset;
    assert.ok(peak - resting < 1, `settle recoiled ${(peak - resting).toFixed(3)} symbols — more than one full symbol`);
    assert.ok(peak - resting > 0, "a back-ease should overshoot its resting position at least a little");
  });

  it("continues smoothly across the spin-to-settle handoff", () => {
    // A discontinuity here would show as the reel teleporting the instant
    // it begins to slow.
    const boundary = timing.startDelayMs + timing.spinDurationMs;
    const before = reelStateAt(boundary - 1, 0, timing).offset;
    const after = reelStateAt(boundary + 1, 0, timing).offset;
    assert.ok(Math.abs(after - before) < 0.2, `offset jumped ${Math.abs(after - before)} symbols at the handoff`);
  });

  it("lands on an exact symbol boundary", () => {
    // A fractional resting offset would leave every reel permanently
    // misaligned by a fraction of a symbol.
    const stopped = reelStateAt(totalSpinDurationMs(timing, 1) + 500, 0, timing);
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.offset % 1, 0, `resting offset ${stopped.offset} is not a whole symbol`);
  });

  it("stays settled once stopped, however long the frame gap", () => {
    const a = reelStateAt(100_000, 0, timing);
    const b = reelStateAt(999_999, 0, timing);
    assert.deepEqual(a, b, "a stopped reel must not drift on a late frame");
  });

  it("is a pure function of elapsed time, so a dropped frame cannot desync", () => {
    // The renderer recomputes absolute positions each frame rather than
    // advancing from wherever it was — this is what makes that safe.
    const sampled = reelStateAt(700, 2, timing);
    const recomputed = reelStateAt(700, 2, timing);
    assert.deepEqual(sampled, recomputed);
  });
});

describe("totalSpinDurationMs", () => {
  it("accounts for every reel's stagger", () => {
    const one = totalSpinDurationMs(DEFAULT_TIMING, 1);
    const five = totalSpinDurationMs(DEFAULT_TIMING, 5);
    assert.equal(five - one, DEFAULT_TIMING.staggerMs * 4);
  });

  it("covers the moment the last reel actually stops", () => {
    const total = totalSpinDurationMs(DEFAULT_TIMING, 5);
    assert.equal(reelStateAt(total, 4, DEFAULT_TIMING).phase, "stopped");
    assert.notEqual(reelStateAt(total - 50, 4, DEFAULT_TIMING).phase, "stopped");
  });
});

describe("blurAmount", () => {
  it("is zero before a reel starts and after it stops", () => {
    // Blur left on a settled reel makes the final symbols unreadable —
    // exactly when the player most wants to read them.
    assert.equal(blurAmount({ phase: "waiting", offset: 0, settleProgress: 0 }), 0);
    assert.equal(blurAmount({ phase: "stopped", offset: 8, settleProgress: 1 }), 0);
  });

  it("is strongest at full speed", () => {
    assert.equal(blurAmount({ phase: "spinning", offset: 4, settleProgress: 0 }, 6), 6);
  });

  it("fades away as the reel settles", () => {
    const early = blurAmount({ phase: "settling", offset: 4, settleProgress: 0.1 });
    const late = blurAmount({ phase: "settling", offset: 8, settleProgress: 0.9 });
    assert.ok(early > late, "blur should decrease as the reel slows");
    assert.ok(late < 0.5, "blur should be nearly gone by the end of the settle");
  });
});
