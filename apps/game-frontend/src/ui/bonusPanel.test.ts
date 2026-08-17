/**
 * The bonus panel as it reaches the DOM.
 *
 * `bonusView.test.ts` proves the reading; this proves the drawing, and the
 * two are separate claims. The specific things asserted here are the ones
 * the previous `innerHTML` rebuild got wrong:
 *
 * - **Tiles survive a step.** The old version rewrote the panel on every
 *   `BONUS_STATE`, so the element showing a result was a different object
 *   from the one clicked — no reveal could animate, and keyboard focus was
 *   thrown away on every pick.
 * - **A picked tile stops being clickable immediately**, not when the
 *   server's answer arrives. The gap between those two is where a second
 *   claim gets queued.
 * - **Values are set as text, never interpolated into markup.**
 *
 * What these cannot establish: that a click reaches the socket, or that the
 * panel is visible on screen. That is `main.ts`'s wiring, verified by
 * running the client.
 *
 * ## Mutation results: 3 of 5 caught, 2 documented equivalents
 *
 * Both survivors are **defence in depth** — each is guarded a second time by
 * a different mechanism, established by probe rather than by argument:
 *
 * - Deleting `if (button.disabled) return;` from the click handler survives,
 *   because `syncTileEnablement` has already set `disabled` on every tile by
 *   the time a second click could arrive. It is kept because it makes the
 *   handler correct **on its own terms** rather than correct only while some
 *   other method keeps its promise.
 * - Deleting the `clearTimeout` before scheduling a resolved dismissal
 *   survives, because `hide()` clears every pending timer and the first
 *   callback calls `hide()` before the second can fire. Measured directly.
 *   Kept for the same reason: it stops depending on the ordering of two
 *   separate methods to avoid handing control back twice.
 *
 * **One survivor was a real bug and is now fixed.** Removing
 * `this.stepInFlight = true` from the click handler originally changed
 * nothing, because `syncTileEnablement` was called without a model and
 * disabled every tile unconditionally — so the flag was decorative on the
 * click path. The panel now remembers the last pick model, one rule decides
 * enablement in both directions, and that mutation is caught.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import globalJsdom from "global-jsdom";
import { BonusPanelView, wheelGradient, wheelLabelAngle } from "./bonusPanel.js";

let teardown: (() => void) | null = null;
before(() => {
  teardown = globalJsdom(undefined, { pretendToBeVisual: true, url: "http://localhost/" });
});
after(() => teardown?.());

let panel: HTMLElement;
let view: BonusPanelView;
let picks: number[];
let spins: number;
let dismissals: number;

beforeEach(() => {
  /*
   * The previous test's view is torn down, not just abandoned.
   *
   * Found by the wheel tests and worth stating, because it made a passing
   * suite lie. Every other round dismisses synchronously, so a discarded
   * view left nothing running and replacing the DOM was enough cleanup. The
   * wheel schedules a 3.4s reveal, so five earlier tests left five live
   * timers that all fired during a later test's wait — each one calling the
   * SHARED `onResolvedDismissed`, which counted 5 dismissals for one round.
   *
   * `hide()` clears both timers, so it is the teardown. The lesson is the
   * repo's own: a stand-in for cleanup that works only because nothing was
   * asynchronous stops working the moment something is.
   */
  view?.hide();
  document.body.innerHTML = `<div id="bonus" hidden></div>`;
  panel = document.getElementById("bonus") as HTMLElement;
  picks = [];
  spins = 0;
  dismissals = 0;
  view = new BonusPanelView(
    { panel },
    { onPick: (i) => picks.push(i), onSpin: () => (spins += 1), onResolvedDismissed: () => (dismissals += 1) },
  );
  view.setCurrency("USD");
});

const tiles = (): HTMLButtonElement[] => [...panel.querySelectorAll<HTMLButtonElement>(".tile")];
const active = { status: "active" };

describe("pick rounds", () => {
  it("draws one button per tile and shows the panel", () => {
    view.render({ ...active, view: { tileCount: 4 } });

    assert.equal(panel.hidden, false);
    assert.equal(tiles().length, 4);
  });

  it("keeps the SAME tile elements across steps", () => {
    /**
     * The property the `innerHTML` rebuild destroyed. If the element
     * showing a result is a different object from the one clicked, no
     * reveal can animate and focus is thrown away on every pick.
     */
    view.render({ ...active, view: { tileCount: 3 } });
    const before = tiles();

    view.render({ ...active, view: { tileCount: 3, picks: [{ tileIndex: 0, multiplier: 5 }] } });
    const after = tiles();

    assert.equal(after.length, 3);
    for (let i = 0; i < 3; i++) assert.equal(after[i], before[i], `tile ${i} was replaced rather than updated`);
  });

  it("restores focus to a still-usable tile after a step", () => {
    /**
     * A panel that steals focus on every pick is unusable without a mouse.
     *
     * **This test is weaker than it looks, and the reason is recorded
     * because it misled once already.** A real browser blurs a focused
     * element the moment it is disabled, moving focus to `<body>`; `jsdom`
     * does **not** implement that. So the first version of this test passed
     * against a panel that genuinely lost focus in Chrome — a stand-in more
     * permissive than the real thing, exactly the `fakeMongo` trap section D
     * describes. The bug was found by running the client and measuring
     * `document.activeElement` after a real pick.
     *
     * What this can still establish is that the panel refocuses
     * deliberately rather than leaving focus wherever it landed. The
     * blur-on-disable behaviour itself is only observable in a browser, and
     * is verified there.
     */
    view.render({ ...active, view: { tileCount: 3 } });
    tiles()[2].focus();

    // The browser blurs to `<body>` when the tile is disabled mid-step;
    // modelled here because jsdom does not. The panel must put focus back.
    view.render({ ...active, view: { tileCount: 3, picks: [{ tileIndex: 0, multiplier: 2 }] } });
    (document.activeElement as HTMLElement | null)?.blur();
    view.render({ ...active, view: { tileCount: 3, picks: [{ tileIndex: 0, multiplier: 2 }] } });

    assert.equal(document.activeElement, tiles()[2], "focus was not restored to the tile the player was on");
  });

  it("moves focus to a revealed tile's neighbour rather than onto the dead tile", () => {
    /**
     * Refocusing a disabled control is worse than leaving focus at the top
     * of the document: the player cannot tell why their keyboard does
     * nothing.
     *
     * **What this environment can and cannot say.** jsdom does not blur a
     * focused element when it is disabled, and `blur()` on an
     * already-disabled element is a no-op there — measured — so the
     * browser's actual focus loss cannot be reproduced here at all. The
     * observable half is the panel's own decision: a revealed tile must end
     * up disabled, and focus must be restored only onto a tile that is
     * still usable. The blur itself is verified in a browser, where the bug
     * was found.
     */
    view.render({ ...active, view: { tileCount: 3 } });
    // Focus a tile that will still be usable after the step.
    tiles()[2].focus();
    tiles()[0].click();

    view.render({ ...active, view: { tileCount: 3, picks: [{ tileIndex: 0, multiplier: 4 }] } });

    assert.equal(tiles()[0].disabled, true, "a revealed tile must stay disabled");
    assert.equal(tiles()[2].disabled, false, "an untouched tile must be usable again");
    assert.equal(document.activeElement, tiles()[2], "focus should be restored to the still-usable tile");
  });

  it("reports the clicked tile index, not a hardcoded one", () => {
    view.render({ ...active, view: { tileCount: 5 } });

    tiles()[3].click();

    assert.deepEqual(picks, [3]);
  });

  it("disables every tile the instant one is clicked", () => {
    /**
     * Not when the server answers — the gap between the click and the
     * result is exactly where a second claim gets queued. The server
     * refuses a duplicate regardless; this stops the player believing they
     * made a pick that was thrown away.
     */
    view.render({ ...active, view: { tileCount: 4 } });
    tiles()[0].click();

    assert.deepEqual(tiles().map((t) => t.disabled), [true, true, true, true]);
  });

  it("ignores a second click on an already-disabled tile", () => {
    view.render({ ...active, view: { tileCount: 3 } });
    tiles()[1].click();
    tiles()[1].click();

    assert.deepEqual(picks, [1], "a disabled tile still sent a pick");
  });

  it("re-enables the unrevealed tiles once the step resolves", () => {
    view.render({ ...active, view: { tileCount: 3 } });
    tiles()[0].click();

    view.render({ ...active, view: { tileCount: 3, picks: [{ tileIndex: 0, multiplier: 5 }] } });

    assert.deepEqual(tiles().map((t) => t.disabled), [true, false, false]);
  });

  it("shows a revealed multiplier on its tile", () => {
    view.render({ ...active, view: { tileCount: 2, picks: [{ tileIndex: 1, multiplier: 8 }] } });

    assert.equal(tiles()[1].textContent, "×8");
  });

  it("shows a blank distinctly from an untouched tile", () => {
    view.render({ ...active, view: { tileCount: 2, picks: [{ tileIndex: 0, multiplier: null }] } });

    assert.notEqual(tiles()[0].textContent, tiles()[1].textContent);
  });

  it("labels each tile for a screen reader", () => {
    // The face is a symbol or a bare number, which reads as nothing useful
    // aloud. The index is what identifies the control.
    view.render({ ...active, view: { tileCount: 2 } });

    assert.match(tiles()[0].getAttribute("aria-label") ?? "", /Tile 1/);
  });

  it("says the round is finishing once every tile is revealed", () => {
    // Rather than leaving a player clicking a dead grid.
    view.render({ ...active, view: { tileCount: 2, revealed: [0, 1] } });

    assert.match(panel.textContent ?? "", /finishing/i);
  });
});

describe("free spins", () => {
  it("shows the count, multiplier and running total", () => {
    view.render({ ...active, view: { remaining: 7, winMultiplier: 2, accumulatedWin: 850 } });

    const text = panel.textContent ?? "";
    assert.match(text, /Free spins ×2/);
    assert.match(text, /7 left/);
    assert.match(text, /\$8\.50/, "the running total must render as money, not as minor units");
  });

  it("omits the multiplier when it is 1", () => {
    // "×1" is noise — it describes a feature that does nothing.
    view.render({ ...active, view: { remaining: 3, winMultiplier: 1 } });

    assert.equal(panel.querySelector("strong")?.textContent, "Free spins");
  });

  it("mentions retriggers only when some have happened", () => {
    view.render({ ...active, view: { remaining: 3, retriggers: 0 } });
    assert.doesNotMatch(panel.textContent ?? "", /retrigger/);

    view.render({ ...active, view: { remaining: 8, retriggers: 2 } });
    assert.match(panel.textContent ?? "", /2 retriggers/);
  });

  it("sends a spin when the button is pressed", () => {
    view.render({ ...active, view: { remaining: 3 } });

    panel.querySelector<HTMLButtonElement>(".tile")?.click();

    assert.equal(spins, 1);
  });

  it("disables the button while a spin is in flight", () => {
    // So a player cannot queue spins faster than they can watch them.
    view.render({ ...active, view: { remaining: 3 } });
    const button = panel.querySelector<HTMLButtonElement>(".tile")!;
    button.click();

    assert.equal(button.disabled, true);
    button.click();
    assert.equal(spins, 1, "a disabled spin button still sent a step");
  });

  it("refuses a spin when none remain", () => {
    view.render({ ...active, view: { remaining: 0 } });

    assert.equal(panel.querySelector<HTMLButtonElement>(".tile")?.disabled, true);
  });

  it("keeps the same button across steps", () => {
    view.render({ ...active, view: { remaining: 3 } });
    const before = panel.querySelector(".tile");

    view.render({ ...active, view: { remaining: 2, accumulatedWin: 100 } });

    assert.equal(panel.querySelector(".tile"), before);
  });
});

describe("the wheel bonus", () => {
  /*
   * These pin the fix for a gap that shipped: `reference-5x3` — the DEFAULT
   * game — carries a wheel bonus, and the client drew no wheel at all. The
   * module resolves in `start()`, so its state arrives already
   * `status: "resolved"`, matched the resolved branch first, and the player
   * saw a bare total. The server sends the entire segment table; the client
   * showed a number instead of the thing that produced it.
   *
   * The money was right throughout, which is exactly why it went unnoticed
   * — nothing downstream disagreed and no test failed.
   */
  const wheelState = { status: "resolved", totalWin: 500, view: { segmentIndex: 2, multiplier: 5, segments: [1, 2, 5, 10], totalWin: 500 } };
  const face = (): HTMLElement | null => panel.querySelector(".wheel-face");

  it("draws a wheel rather than a bare total", () => {
    view.render(wheelState);

    assert.ok(face(), "a wheel round must render a wheel face");
    assert.ok(panel.querySelector(".wheel-pointer"), "and a pointer to read it against");
  });

  it("draws one label per segment, from the table the server sent", () => {
    view.render(wheelState);

    const labels = [...panel.querySelectorAll(".wheel-label")].map((l) => l.textContent);
    assert.deepEqual(labels, ["×1", "×2", "×5", "×10"]);
  });

  it("rotates the face and leaves the pointer alone", () => {
    // The artist contract: the pointer is fixed at 12 o'clock and only the
    // face turns. A rotating pointer would still "point" somewhere and be
    // wrong in a way that looks deliberate.
    view.render(wheelState);

    assert.match(face()?.style.transform ?? "", /rotate\(/);
    assert.equal((panel.querySelector(".wheel-pointer") as HTMLElement).style.transform, "");
  });

  it("does not announce the prize before the wheel has stopped", () => {
    // Saying it up front spoils the reveal the animation exists for.
    view.render(wheelState);

    assert.equal(panel.querySelector("span")?.textContent, "");
  });

  it("hides the panel by itself once the reveal has been seen", async () => {
    /*
     * The wheel schedules its own dismissal AFTER the spin, unlike every
     * other resolved round which dismisses immediately. Getting this wrong
     * strands the client: a bonus blocks the base game until it resolves,
     * so a panel that never hands back leaves a player unable to spin.
     */
    view.render(wheelState);
    assert.equal(dismissals, 0, "it must not dismiss while still spinning");

    // 3400ms spin + 2600ms dwell, plus slack.
    await new Promise((r) => setTimeout(r, 6200));

    assert.equal(dismissals, 1, "the round must hand control back exactly once");
    assert.equal(panel.hidden, true);
  });

  it("cancels a pending reveal when hidden, rather than firing into a dead panel", () => {
    // Otherwise the timer resolves against elements that no longer exist and
    // schedules a second dismissal — handing back to idle twice for one
    // round.
    view.render(wheelState);
    view.hide();

    assert.equal(panel.hidden, true);
    assert.equal(dismissals, 0, "hiding must not itself count as a dismissal");
  });

  it("survives a wheel with a single segment", () => {
    // Degenerate but drawable, and the case a naive `360 / length` divides
    // badly on.
    view.render({ status: "resolved", totalWin: 100, view: { segmentIndex: 0, multiplier: 1, segments: [1] } });

    assert.ok(face());
    assert.equal(panel.querySelectorAll(".wheel-label").length, 1);
  });
});

describe("wheelGradient", () => {
  it("gives every segment an equal wedge", () => {
    const css = wheelGradient([1, 2, 3, 4]);

    assert.match(css, /conic-gradient/);
    // Four segments, so 90deg each, and the last must close the circle.
    assert.match(css, /0deg 90deg/);
    assert.match(css, /270deg 360deg/);
  });

  it("starts half a segment before 12 o'clock, so segment 0 is centred there", () => {
    /*
     * The artist contract, and the easiest thing here to get wrong by one
     * half-segment. CSS conic gradients begin at 3 o'clock, so -90deg moves
     * the start to the top; the extra half-segment centres segment 0 on it
     * rather than starting it there. Without the half-step the pointer sits
     * on a boundary between two prizes.
     */
    // Asserted as the property rather than as a literal, which is how the
    // first draft of this test got it wrong: I wrote -112.5deg for a
    // four-segment wheel, and the correct value is -135. Deriving it here
    // means the test states the contract instead of restating an answer.
    for (const total of [3, 4, 6, 8]) {
      const step = 360 / total;
      const expectedStart = -90 - step / 2;
      assert.match(
        wheelGradient(Array.from({ length: total }, (_, i) => i + 1)),
        new RegExp(`from ${expectedStart}deg`),
        `a ${total}-segment wheel must start half a segment before 12 o'clock`,
      );
      // The point of that offset: segment 0's CENTRE lands on 12 o'clock
      // (-90deg from CSS's 3 o'clock origin), not its leading edge.
      assert.equal(expectedStart + step / 2, -90);
    }
  });

  it("gives neighbouring wedges different colours at any table length", () => {
    // A fixed palette aliases once the table outgrows it, so two adjacent
    // wedges come out identical and the wheel reads as one big segment.
    const css = wheelGradient([1, 2, 3, 4, 5, 6, 7, 8]);
    const hues = [...css.matchAll(/hsl\((\d+)/g)].map((m) => m[1]);
    assert.equal(new Set(hues).size, 8, "every segment needs its own hue");
  });

  it("draws nothing for an empty table rather than an invalid gradient", () => {
    assert.equal(wheelGradient([]), "transparent");
  });
});

describe("wheelLabelAngle", () => {
  it("spreads labels evenly around the wheel", () => {
    assert.equal(wheelLabelAngle(0, 4), 0);
    assert.equal(wheelLabelAngle(1, 4), 90);
    assert.equal(wheelLabelAngle(3, 4), 270);
  });

  it("does not divide by an empty wheel", () => {
    assert.equal(wheelLabelAngle(0, 0), 0);
  });
});

describe("a resolved round", () => {
  it("shows the total as money and then hands control back", async () => {
    view.render({ status: "resolved", totalWin: 1960 });

    assert.match(panel.textContent ?? "", /Bonus complete/);
    assert.match(panel.textContent ?? "", /\$19\.60/);
    assert.equal(dismissals, 0, "control must not be handed back before the figure has been read");

    await new Promise((r) => setTimeout(r, 2700));

    assert.equal(dismissals, 1);
    assert.equal(panel.hidden, true);
  });

  it("hands control back exactly once when resolved twice", async () => {
    /**
     * A duplicate `BONUS_STATE` is ordinary — a reconnect replays the
     * session's current state. Two stacked dismissals would return the
     * client to idle twice, and the second could land after a new spin had
     * already started.
     */
    view.render({ status: "resolved", totalWin: 500 });
    view.render({ status: "resolved", totalWin: 500 });

    await new Promise((r) => setTimeout(r, 2700));

    assert.equal(dismissals, 1);
  });
});

describe("a module this build cannot draw", () => {
  it("says so rather than leaving an empty overlay", () => {
    // A bonus blocks the base game until it resolves, so a panel with
    // nothing in it reads as a frozen client.
    view.render({ ...active, view: { somethingNewEntirely: true } });

    assert.ok((panel.textContent ?? "").trim().length > 0, "an unknown module rendered an empty panel");
  });
});

describe("switching between rounds", () => {
  it("rebuilds when the module changes", () => {
    view.render({ ...active, view: { tileCount: 3 } });
    assert.equal(tiles().length, 3);

    view.render({ ...active, view: { remaining: 5 } });

    assert.match(panel.textContent ?? "", /Free spins/);
    assert.doesNotMatch(panel.textContent ?? "", /Pick a prize/);
  });

  it("forgets its tiles when hidden, so the next round starts clean", () => {
    view.render({ ...active, view: { tileCount: 3 } });
    view.hide();

    assert.equal(panel.hidden, true);
    assert.equal(tiles().length, 0);
  });
});
