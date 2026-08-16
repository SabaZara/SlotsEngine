import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cycleCell, defaultPayline, effectiveLength, paylineWarning, reshapePaylines } from "./paylineGrid.js";

/**
 * Payline editing is the part of this UI that can be wrong without looking
 * wrong: an off-by-one on resize, or a `null` treated as a zero, produces a
 * line that publishes cleanly and then pays the wrong positions.
 */

describe("cycleCell", () => {
  it("routes a line through the clicked cell", () => {
    assert.deepEqual(cycleCell([1, 1, 1], 1, 2, 3), [1, 2, 1]);
  });

  it("clears the reel when the selected row is clicked again", () => {
    // `null` — "this reel is not part of the line" — is a real state in the
    // schema, so it has to be reachable from the same control.
    assert.deepEqual(cycleCell([1, 1, 1], 1, 1, 3), [1, null, 1]);
  });

  it("never selects a row the grid does not have", () => {
    assert.deepEqual(cycleCell([0, 0, 0], 0, 5, 3), [null, 0, 0]);
  });

  it("does not mutate the line it was given", () => {
    const original: Array<number | null> = [1, 1, 1];
    cycleCell(original, 0, 2, 3);
    assert.deepEqual(original, [1, 1, 1]);
  });
});

describe("reshapePaylines", () => {
  it("pads added reels with null rather than guessing a row", () => {
    // Silently extending a line changes what the game pays; `null` is
    // visibly incomplete and asks to be filled in.
    assert.deepEqual(reshapePaylines([[1, 1, 1]], 5, 3), [[1, 1, 1, null, null]]);
  });

  it("truncates when the grid shrinks", () => {
    assert.deepEqual(reshapePaylines([[1, 1, 1, 1, 1]], 3, 3), [[1, 1, 1]]);
  });

  it("clears a row that no longer exists after a shrink", () => {
    // Keeping row 4 on a 3-row grid would fail validation at publish with a
    // message about a row outside the grid.
    assert.deepEqual(reshapePaylines([[0, 4, 2]], 3, 3), [[0, null, 2]]);
  });

  it("leaves a line that already fits completely untouched", () => {
    assert.deepEqual(reshapePaylines([[0, 1, 2]], 3, 3), [[0, 1, 2]]);
  });

  it("preserves deliberate nulls", () => {
    assert.deepEqual(reshapePaylines([[0, null, 2]], 3, 3), [[0, null, 2]]);
  });

  it("always produces lines exactly grid.reels long", () => {
    // This is the invariant the API enforces at publish, so a resize that
    // broke it would make the draft unpublishable.
    for (const reels of [1, 3, 5, 7]) {
      for (const line of reshapePaylines([[1, 1, 1], [0, null, 2, 2]], reels, 3)) {
        assert.equal(line.length, reels);
      }
    }
  });
});

describe("paylineWarning", () => {
  it("says nothing about a well-formed line", () => {
    assert.equal(paylineWarning([1, 1, 1, 1, 1]), null);
  });

  it("flags a line that covers no reels", () => {
    assert.match(paylineWarning([null, null, null]) ?? "", /never pay/);
  });

  it("flags a line that does not start at reel 1", () => {
    // Evaluation walks left to right from reel 0, so this pays nothing at
    // all — legal config, but almost certainly not what was intended.
    assert.match(paylineWarning([null, 1, 1, 1, 1]) ?? "", /never pay/);
  });

  it("flags a hole in the middle, and says how much still counts", () => {
    const warning = paylineWarning([1, 1, null, 1, 1]);
    assert.match(warning ?? "", /Only reels 1-2/);
  });

  it("accepts a deliberately short line with a clean tail", () => {
    // Trailing nulls are the documented way to say "this line is 3 reels
    // long", so they must not warn.
    assert.equal(paylineWarning([1, 1, 1, null, null]), null);
  });
});

describe("effectiveLength", () => {
  it("counts the whole line when there is no gap", () => {
    assert.equal(effectiveLength([1, 1, 1, 1, 1]), 5);
  });

  it("stops at the first gap, matching how a run is evaluated", () => {
    assert.equal(effectiveLength([1, 1, 1, null, null]), 3);
    assert.equal(effectiveLength([1, 1, null, 1, 1]), 2);
  });

  it("is zero for a line that cannot pay at all", () => {
    assert.equal(effectiveLength([null, 1, 1]), 0);
  });
});

describe("defaultPayline", () => {
  it("runs straight across the middle row", () => {
    assert.deepEqual(defaultPayline(5, 3), [1, 1, 1, 1, 1]);
    assert.deepEqual(defaultPayline(3, 5), [2, 2, 2]);
  });

  it("produces a line that never warns", () => {
    for (const [reels, rows] of [[3, 3], [5, 3], [5, 4], [6, 5]]) {
      assert.equal(paylineWarning(defaultPayline(reels, rows)), null);
    }
  });
});
