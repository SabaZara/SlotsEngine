/**
 * The win count-up and its tiers.
 *
 * **This module handles money, so it is tested to the money standard rather
 * than the presentation one.** The repo's rule is that money is always an
 * integer count of minor units, and the reference repo shipped the exact bug
 * that rule prevents: a mid-tween counter was rendered with `toFixed(2)`,
 * which formats decimal *places* without converting minor units to major
 * ones. A 2000-minor-unit win (20.00) displayed as **"WIN 2000.00"** — a
 * hundredfold overstatement, confirmed live, in front of a player.
 *
 * The guard is structural rather than a check at the call site:
 * `countUpValueAt` returns an integer at every instant, so the value handed
 * to `formatMoney` is always the kind of number it was built for. The suite
 * below asserts that property over the whole animation, not just at its
 * endpoints — an implementation that is integral only at 0 and 1 is exactly
 * the one that fails in the middle, which is where every frame lives.
 *
 * What these cannot establish: that the renderer calls any of this per
 * frame, or that the celebration fires. That is the renderer's wiring, and
 * `jsdom` provides no WebGL context to check it in — stated here rather than
 * implied, per the file headers elsewhere in this repo.
 *
 * ## Mutation results: 6 of 8 caught, 2 documented equivalents
 *
 * Both survivors are **equivalent under the current easing curve**, and both
 * were established by measurement rather than by argument:
 *
 * - Replacing `Math.floor` with `Math.round` in `countUpValueAt` survives.
 *   `1 - (1 - t)³` never exceeds 1, so a rounded value can never exceed
 *   `winMinor` — checked exhaustively over five win amounts at every
 *   millisecond of a 1000ms count-up, maximum overshoot zero.
 * - Removing the `elapsedMs >= durationMs` early return survives, because at
 *   `t = 1` this curve evaluates to exactly 1 and `floor` is already exact.
 *
 * **Both guards are kept deliberately, and the justification is measured
 * rather than argued.** Swapping this curve for the overshooting
 * `easeOutBack` that `reelStrip.ts` already uses for the reel settle makes
 * both live immediately: the count-up then displays up to **499 minor units
 * over** a 5000-unit win — a 4.99 overstatement of a 50.00 payout, peaking
 * around 57% of the way through. So these are not dead code but a guard
 * against a curve change that would otherwise reintroduce a money bug
 * silently, which is exactly the trade section D warns about.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIER_THRESHOLDS,
  countUpComplete,
  countUpDurationMs,
  countUpValueAt,
  tierCrossing,
  tierFor,
  type WinTier,
} from "./winPresentation.js";
import { formatMoney } from "../ui/formatMoney.js";

const BET = 100; // 1.00

describe("tierFor", () => {
  it("reports no tier for a losing spin", () => {
    assert.equal(tierFor(0, BET), "none");
  });

  it("reports an ordinary win below the big threshold", () => {
    assert.equal(tierFor(BET * 5, BET), "win");
  });

  it("reports big at exactly the threshold, not one unit past it", () => {
    // A strict `>` here would make the advertised 15x unreachable, so the
    // tier a player is told about would never fire at its stated value.
    assert.equal(tierFor(BET * DEFAULT_TIER_THRESHOLDS.big, BET), "big");
  });

  it("reports mega at exactly its threshold", () => {
    assert.equal(tierFor(BET * DEFAULT_TIER_THRESHOLDS.mega, BET), "mega");
  });

  it("prefers mega over big where both are satisfied", () => {
    // Order matters: checking `big` first would cap every win at "big" and
    // the mega celebration would be dead code.
    assert.equal(tierFor(BET * 1000, BET), "mega");
  });

  it("scales with the stake rather than using absolute amounts", () => {
    // The same 1500-unit win is a big win on a 1-unit bet and an ordinary
    // one on a 50-unit bet. An absolute threshold would call both the same.
    assert.equal(tierFor(1500, 100), "big");
    assert.equal(tierFor(1500, 5000), "win");
  });

  it("reports no tier when the stake is zero, however large the win", () => {
    /**
     * Not hypothetical: a free spin costs nothing, so a bonus round
     * genuinely reports a win against a zero stake. Every threshold would
     * be zero, so without this guard a 1-unit win reads as "mega" and the
     * loudest celebration in the game fires on the smallest possible
     * amount.
     */
    assert.equal(tierFor(100_000, 0), "none");
    assert.equal(tierFor(100_000, -1), "none");
  });

  it("reports no tier for a non-finite win or stake", () => {
    // A NaN comparison is always false, so without an explicit check this
    // would fall through to "win" — announcing a win that is not a number.
    assert.equal(tierFor(Number.NaN, BET), "none");
    assert.equal(tierFor(BET * 100, Number.NaN), "none");
  });

  it("honours custom thresholds", () => {
    assert.equal(tierFor(BET * 3, BET, { big: 2, mega: 10 }), "big");
  });
});

describe("countUpValueAt", () => {
  it("starts at zero and ends exactly on the win", () => {
    assert.equal(countUpValueAt(0, 5000, 1000), 0);
    assert.equal(countUpValueAt(1000, 5000, 1000), 5000);
  });

  it("lands on the exact win rather than one unit short", () => {
    /**
     * An eased curve reaching 0.99999 would floor to 4999 and leave the
     * display permanently one minor unit below what was actually paid.
     * Showing less than was won is the one error here a player would
     * notice and be right about.
     */
    assert.equal(countUpValueAt(1000, 5000, 1000), 5000);
    assert.equal(countUpValueAt(99_999, 5000, 1000), 5000);
  });

  it("returns an INTEGER at every instant, not just at the ends", () => {
    /**
     * The guard against the reference's shipped bug. `formatMoney` divides
     * by the currency's minor-unit exponent and is built for integers; a
     * fractional intermediate is how a tween value reaches the screen as a
     * number that is not money.
     *
     * Sampled across the whole animation because an implementation that is
     * integral only at its endpoints is precisely the one that fails in the
     * middle — which is where every rendered frame lives.
     */
    for (let elapsed = 0; elapsed <= 1000; elapsed += 7) {
      const value = countUpValueAt(elapsed, 5000, 1000);
      assert.ok(Number.isInteger(value), `value ${value} at ${elapsed}ms is not an integer`);
    }
  });

  it("never displays more than was won", () => {
    // Rounding at the top of the curve would allow a frame showing 5001 on
    // a 5000 win — briefly overstating a payout.
    for (let elapsed = 0; elapsed <= 1200; elapsed += 3) {
      assert.ok(countUpValueAt(elapsed, 5000, 1000) <= 5000);
    }
  });

  it("never goes backwards", () => {
    // A non-monotonic curve makes the number flicker downward mid-count,
    // which reads as a correction to a figure the player was just shown.
    let previous = 0;
    for (let elapsed = 0; elapsed <= 1000; elapsed += 5) {
      const value = countUpValueAt(elapsed, 5000, 1000);
      assert.ok(value >= previous, `dropped from ${previous} to ${value} at ${elapsed}ms`);
      previous = value;
    }
  });

  it("decelerates rather than counting linearly", () => {
    // Most of the distance is covered early, so the number reads as
    // arriving rather than as a meter filling at constant speed.
    const halfway = countUpValueAt(500, 10_000, 1000);
    assert.ok(halfway > 5000, `an eased count-up should pass halfway early, got ${halfway}`);
  });

  it("shows the full amount when there is no time to animate", () => {
    // A zero duration means "no animation", not "divide by zero" — which
    // would render NaN where a win should be.
    assert.equal(countUpValueAt(0, 5000, 0), 5000);
    assert.equal(countUpValueAt(50, 5000, -1), 5000);
  });

  it("shows nothing for a losing spin", () => {
    assert.equal(countUpValueAt(500, 0, 1000), 0);
    assert.equal(countUpValueAt(500, -100, 1000), 0);
  });

  it("survives a non-finite elapsed time", () => {
    assert.equal(countUpValueAt(Number.NaN, 5000, 1000), 0);
  });

  it("formats as real money at every frame", () => {
    /**
     * The end-to-end version of the inherited bug, asserted through the
     * function that actually renders it. A 2000-minor-unit win must never
     * display as "2000.00" — it is 20.00, and the hundredfold difference is
     * exactly what shipped in the reference.
     */
    assert.equal(formatMoney(countUpValueAt(1000, 2000, 1000), "USD"), "$20.00");

    for (let elapsed = 0; elapsed <= 1000; elapsed += 11) {
      const text = formatMoney(countUpValueAt(elapsed, 2000, 1000), "USD");
      assert.match(text, /^\$\d+\.\d{2}$/, `frame at ${elapsed}ms rendered "${text}"`);
      assert.ok(Number(text.slice(1)) <= 20, `frame at ${elapsed}ms showed ${text}, above the real 20.00 win`);
    }
  });
});

describe("countUpDurationMs", () => {
  it("gives a bigger win a longer count-up", () => {
    // The pacing is the message: a big win that counts up as fast as a
    // small one throws away the only moment the player is watching.
    assert.ok(countUpDurationMs("win") < countUpDurationMs("big"));
    assert.ok(countUpDurationMs("big") < countUpDurationMs("mega"));
  });

  it("spends no time on a losing spin", () => {
    assert.equal(countUpDurationMs("none"), 0);
  });

  it("never outlasts a few seconds, whatever the tier", () => {
    // A count-up long enough to feel broken is worse than an instant one.
    for (const tier of ["none", "win", "big", "mega"] as WinTier[]) {
      assert.ok(countUpDurationMs(tier) <= 3000, `${tier} counts up for ${countUpDurationMs(tier)}ms`);
    }
  });
});

describe("countUpComplete", () => {
  it("is complete once the duration has elapsed", () => {
    assert.equal(countUpComplete(1000, 1000), true);
    assert.equal(countUpComplete(999, 1000), false);
  });

  it("is immediately complete when there is nothing to animate", () => {
    // Otherwise a zero-duration count-up never finishes, and whatever waits
    // on it — re-enabling the spin button — waits forever.
    assert.equal(countUpComplete(0, 0), true);
  });
});

describe("tierCrossing", () => {
  it("reports a tier only when it changes", () => {
    // Edge-triggered. A level-triggered check would fire the celebration on
    // every frame after the threshold rather than once as it is crossed.
    assert.equal(tierCrossing("none", "big"), "big");
    assert.equal(tierCrossing("big", "big"), null);
  });

  it("reports a return to none, so a celebration can be cleared", () => {
    // The next spin resets to `none`, and something has to tear down the
    // previous celebration.
    assert.equal(tierCrossing("mega", "none"), "none");
  });

  it("fires each tier exactly once across a full count-up", () => {
    /**
     * The property the whole edge-triggering exists for, asserted over a
     * real animation rather than on two hand-picked values: a mega win
     * passes through `win` and `big` on its way up, and each must announce
     * itself once — not once per frame above the threshold.
     */
    const win = BET * 60; // mega
    const duration = countUpDurationMs("mega");
    const fired: WinTier[] = [];
    let previous: WinTier = "none";

    for (let elapsed = 0; elapsed <= duration; elapsed += 16) {
      const next = tierFor(countUpValueAt(elapsed, win, duration), BET);
      const crossed = tierCrossing(previous, next);
      if (crossed) fired.push(crossed);
      previous = next;
    }

    assert.deepEqual(fired, ["win", "big", "mega"], `tiers fired: ${fired.join(", ")}`);
  });
});
