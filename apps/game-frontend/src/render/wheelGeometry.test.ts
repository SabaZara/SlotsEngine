/**
 * The wheel reveal's arithmetic.
 *
 * **Why this file is held to a higher bar than the other presentation
 * maths**: the wheel is the only animation in this client that makes a claim
 * about an outcome. A reel settling one row off looks like a reel; a wheel
 * settling one segment off *tells the player they won a different prize than
 * the server paid*. The money is correct either way, which is exactly what
 * makes it dangerous — nothing downstream disagrees, and a player who reads
 * 5x off the pointer while being paid 2x has been misled by the client.
 *
 * So the load-bearing test here is not any single value but the **round
 * trip**: feeding a computed final rotation back through `segmentUnderPointer`
 * must return the segment the server chose, for every segment of every
 * plausible wheel size. Reading either function alone will not catch an
 * inverted direction convention, because both would be inverted together and
 * each looks self-consistent.
 *
 * What these cannot establish: that the drawing uses these numbers, or that
 * segment 0 is actually painted at 12 o'clock. That is the artist contract in
 * `wheelGeometry.ts`'s header, and it is checked on screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXTRA_TURNS,
  segmentUnderPointer,
  wheelFinalRotation,
  wheelRotationAt,
  wheelSpinProgress,
} from "./wheelGeometry.js";

const TAU = 2 * Math.PI;

describe("wheelFinalRotation", () => {
  it("leaves segment 0 under the pointer with no correction", () => {
    // Segment 0 is at 12 o'clock unrotated, so it needs whole turns only.
    assert.equal(wheelFinalRotation(0, 8, 0), 0);
    assert.equal(wheelFinalRotation(0, 8, 3), 3 * TAU);
  });

  it("rotates backwards to bring a later segment up to the pointer", () => {
    // Segments run clockwise from 12 o'clock, so segment 1 sits clockwise of
    // the pointer and the face must turn back to lift it into place.
    assert.ok(wheelFinalRotation(1, 4, 0) < 0, "a later segment requires a negative correction");
    assert.equal(wheelFinalRotation(1, 4, 0), -TAU / 4);
    assert.equal(wheelFinalRotation(2, 4, 0), -TAU / 2);
  });

  it("adds the requested whole turns on top of the correction", () => {
    assert.equal(wheelFinalRotation(1, 4, 5), 5 * TAU - TAU / 4);
  });

  it("spins several times by default, so the reveal reads as a spin", () => {
    // A wheel that merely nudged to its answer would not look like a wheel.
    assert.ok(DEFAULT_EXTRA_TURNS >= 3);
    assert.ok(wheelFinalRotation(0, 6) >= 3 * TAU);
  });

  it("wraps an out-of-range index rather than spinning off the wheel", () => {
    // The server should never send this. A client that copes costs nothing
    // and turns a server bug into a cosmetic oddity instead of a stuck wheel.
    assert.equal(wheelFinalRotation(4, 4, 0), wheelFinalRotation(0, 4, 0));
    assert.equal(wheelFinalRotation(-1, 4, 0), wheelFinalRotation(3, 4, 0));
  });

  it("refuses to divide by an empty wheel", () => {
    // Would otherwise be NaN, which freezes the reveal at rotation NaN — a
    // stuck wheel rather than a wrong one, but stuck all the same.
    assert.equal(wheelFinalRotation(0, 0), 0);
    assert.equal(wheelFinalRotation(0, Number.NaN), 0);
    assert.equal(wheelFinalRotation(Number.NaN, 8), 0);
  });
});

describe("the reveal lands on the segment the server chose", () => {
  it("round-trips every segment, for every plausible wheel size", () => {
    /*
     * The test this file exists for. An inverted direction convention makes
     * both functions wrong in the same direction, so each reads as correct
     * in isolation and only the round trip disagrees.
     *
     * Sizes cover the real range: 2 is the smallest wheel worth drawing, 3
     * is where a fraction of a segment is most visible, and 12 is a
     * plausible large table.
     */
    for (const totalSegments of [2, 3, 4, 5, 6, 8, 12]) {
      for (let segment = 0; segment < totalSegments; segment++) {
        const rotation = wheelFinalRotation(segment, totalSegments);
        assert.equal(
          segmentUnderPointer(rotation, totalSegments),
          segment,
          `a ${totalSegments}-segment wheel aimed at ${segment} settled elsewhere`,
        );
      }
    }
  });

  it("round-trips with no extra turns, so the flourish is not what makes it work", () => {
    // If the correction were wrong and the whole turns happened to mask it,
    // this is where that shows.
    for (let segment = 0; segment < 6; segment++) {
      assert.equal(segmentUnderPointer(wheelFinalRotation(segment, 6, 0), 6), segment);
    }
  });
});

describe("segmentUnderPointer", () => {
  it("reads segment 0 at rest", () => {
    assert.equal(segmentUnderPointer(0, 8), 0);
  });

  it("ignores whole turns, which change nothing about where it points", () => {
    assert.equal(segmentUnderPointer(TAU * 3, 8), 0);
    assert.equal(segmentUnderPointer(-TAU * 2, 8), 0);
  });

  it("survives a non-finite rotation rather than reporting NaN", () => {
    assert.equal(segmentUnderPointer(Number.NaN, 8), 0);
    assert.equal(segmentUnderPointer(0, 0), 0);
  });
});

describe("wheelSpinProgress", () => {
  it("starts at nothing and finishes complete", () => {
    assert.equal(wheelSpinProgress(0, 1000), 0);
    assert.equal(wheelSpinProgress(1000, 1000), 1);
  });

  it("never exceeds 1, so the wheel cannot overshoot its segment", () => {
    /*
     * The decision this pins, and it is the same one `winCountUp.ts` makes
     * on the money path. An overshooting ease looks livelier and would carry
     * the wheel PAST its segment before settling back — briefly showing the
     * player a prize they did not win, on the one animation that asserts an
     * outcome.
     */
    for (let ms = 0; ms <= 1000; ms += 5) {
      const p = wheelSpinProgress(ms, 1000);
      assert.ok(p <= 1, `progress exceeded 1 at ${ms}ms (${p})`);
      assert.ok(p >= 0, `progress went negative at ${ms}ms (${p})`);
    }
  });

  it("decelerates rather than running at a constant rate", () => {
    // A linear spin does not read as a wheel hunting for its segment.
    const firstTenth = wheelSpinProgress(100, 1000);
    const lastTenth = 1 - wheelSpinProgress(900, 1000);
    assert.ok(firstTenth > lastTenth, "the wheel must cover more ground early than late");
  });

  it("is already most of the way there at the halfway point", () => {
    // Quintic rather than cubic: a wheel travels several turns where a reel
    // travels a few rows, so it needs a sharper decay to look right.
    assert.ok(wheelSpinProgress(500, 1000) > 0.9);
  });

  it("treats a zero or negative duration as finished", () => {
    // "No animation" must show the settled wheel, not divide by zero.
    assert.equal(wheelSpinProgress(0, 0), 1);
    assert.equal(wheelSpinProgress(50, -1), 1);
  });
});

describe("wheelRotationAt", () => {
  it("begins unrotated and ends exactly on the final rotation", () => {
    // Exactly, not approximately: "close enough" on the last frame is what
    // leaves a wheel resting a fraction off its segment — invisible on 12
    // segments and obvious on 3.
    const final = wheelFinalRotation(2, 6);
    assert.equal(wheelRotationAt(0, final, 4000), 0);
    assert.equal(wheelRotationAt(4000, final, 4000), final);
    assert.equal(wheelRotationAt(9999, final, 4000), final);
  });

  it("still points at the chosen segment on the final frame", () => {
    // The property that matters, restated at the level the renderer uses.
    for (const segment of [0, 1, 5]) {
      const final = wheelFinalRotation(segment, 6);
      assert.equal(segmentUnderPointer(wheelRotationAt(4000, final, 4000), 6), segment);
    }
  });

  it("moves monotonically, so the wheel never visibly jerks backwards", () => {
    const final = wheelFinalRotation(3, 8);
    let previous = -Infinity;
    for (let ms = 0; ms <= 3000; ms += 20) {
      const r = wheelRotationAt(ms, final, 3000);
      assert.ok(r >= previous, `rotation went backwards at ${ms}ms`);
      previous = r;
    }
  });
});
