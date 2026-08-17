/**
 * The rotate-device prompt.
 *
 * Two failure modes, and the noisy one is worse. An overlay that never
 * appears costs a player a hint they could have worked out themselves; an
 * overlay that appears when it should not **blocks a game the player can
 * already see**. So the tests lean on the cases where it must stay away:
 * tablets, desktops, and anything the client could not measure.
 *
 * What these cannot establish: that a real browser fires the events. The
 * media query is driven through a stand-in here, which is what makes the
 * rule testable at all — the reference keeps this logic inside a Pixi
 * container where only a real rotation can reach it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PORTRAIT_BREAKPOINT_PX, RotateDeviceOverlay, shouldPromptRotate } from "./rotateDevice.js";

describe("shouldPromptRotate", () => {
  it("asks a narrow portrait phone to rotate", () => {
    assert.equal(shouldPromptRotate(true, 390), true);
  });

  it("says nothing in landscape, however narrow", () => {
    // A short landscape window is not something rotating would improve.
    assert.equal(shouldPromptRotate(false, 390), false);
    assert.equal(shouldPromptRotate(false, 1280), false);
  });

  it("leaves a portrait tablet alone", () => {
    /*
     * The condition that gets forgotten. A width-vs-height comparison would
     * call a 768pt tablet "portrait" and nag a player with plenty of room —
     * which is worse than staying silent, because the overlay covers a game
     * they could see perfectly well.
     */
    assert.equal(shouldPromptRotate(true, 768), false);
    assert.equal(shouldPromptRotate(true, 1024), false);
  });

  it("puts phones and tablets cleanly on either side of the line", () => {
    // 560 rather than a round 600 so neither group sits near the boundary:
    // above every common phone in portrait, below every tablet.
    assert.ok(PORTRAIT_BREAKPOINT_PX > 430, "must clear an iPhone Pro Max in portrait");
    assert.ok(PORTRAIT_BREAKPOINT_PX < 768, "must stay below a tablet");
  });

  it("treats the breakpoint itself as wide enough", () => {
    assert.equal(shouldPromptRotate(true, PORTRAIT_BREAKPOINT_PX), false);
    assert.equal(shouldPromptRotate(true, PORTRAIT_BREAKPOINT_PX - 1), true);
  });

  it("stays silent when the viewport could not be measured", () => {
    // The safer wrong answer: a spurious overlay blocks a playable game,
    // while a missing one costs a hint.
    assert.equal(shouldPromptRotate(true, Number.NaN), false);
    assert.equal(shouldPromptRotate(true, Infinity), false);
    // -Infinity is the case that needs the guard, and the only one: NaN and
    // Infinity are already refused by `< breakpoint` on their own, so a
    // test using only those passes with the guard deleted. Found by
    // mutation — the guard looked untested and was merely under-tested.
    assert.equal(shouldPromptRotate(true, -Infinity), false);
  });
});

/** A media query and window that can be driven by hand. */
function fakeView(options: { portrait: boolean; width: number }) {
  const listeners: Record<string, Array<() => void>> = {};
  let portrait = options.portrait;
  const mediaQuery = {
    get matches() {
      return portrait;
    },
    addEventListener: (_type: string, listener: () => void) => {
      (listeners.media ??= []).push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.media = (listeners.media ?? []).filter((l) => l !== listener);
    },
  } as unknown as MediaQueryList;

  const view = {
    innerWidth: options.width,
    matchMedia: (query: string) => {
      queries.push(query);
      return mediaQuery;
    },
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
  };
  const queries: string[] = [];

  return {
    view,
    queries,
    listeners,
    rotateTo: (next: boolean, width: number) => {
      portrait = next;
      view.innerWidth = width;
      for (const l of listeners.media ?? []) l();
    },
    resizeTo: (width: number) => {
      view.innerWidth = width;
      for (const l of listeners.resize ?? []) l();
    },
  };
}

describe("RotateDeviceOverlay", () => {
  const overlayEl = () => ({ hidden: false }) as HTMLElement;

  it("asks the browser about orientation, not about width versus height", () => {
    /*
     * The detail worth copying exactly. A width/height comparison looks
     * equivalent and only re-evaluates when something else triggers a
     * resize; the media query fires on the orientation change itself, which
     * is the moment the overlay needs to clear.
     */
    const { view, queries } = fakeView({ portrait: true, width: 390 });

    new RotateDeviceOverlay({ overlay: overlayEl() }, view);

    assert.deepEqual(queries, ["(orientation: portrait)"]);
  });

  it("shows itself immediately on a narrow portrait phone", () => {
    const overlay = overlayEl();
    const { view } = fakeView({ portrait: true, width: 390 });

    new RotateDeviceOverlay({ overlay }, view);

    assert.equal(overlay.hidden, false);
  });

  it("stays hidden on a landscape phone", () => {
    const overlay = overlayEl();
    const { view } = fakeView({ portrait: false, width: 844 });

    new RotateDeviceOverlay({ overlay }, view);

    assert.equal(overlay.hidden, true);
  });

  it("clears itself the moment the device is rotated", () => {
    // The whole point of the feature: the player does what was asked and the
    // overlay gets out of the way without needing anything else to happen.
    const overlay = overlayEl();
    const fake = fakeView({ portrait: true, width: 390 });
    new RotateDeviceOverlay({ overlay }, fake.view);

    fake.rotateTo(false, 844);

    assert.equal(overlay.hidden, true);
  });

  it("appears when a desktop window is narrowed into phone shape", () => {
    // A desktop can cross the breakpoint without ever changing orientation,
    // which is why resize is listened for as well.
    const overlay = overlayEl();
    const fake = fakeView({ portrait: true, width: 900 });
    new RotateDeviceOverlay({ overlay }, fake.view);
    assert.equal(overlay.hidden, true);

    fake.resizeTo(400);

    assert.equal(overlay.hidden, false);
  });

  it("stops listening when destroyed", () => {
    // A listener outliving the client keeps a reference to a torn-down
    // overlay and writes to it on the next rotation.
    const overlay = overlayEl();
    const fake = fakeView({ portrait: true, width: 390 });
    const instance = new RotateDeviceOverlay({ overlay }, fake.view);

    instance.destroy();

    assert.equal((fake.listeners.media ?? []).length, 0);
    assert.equal((fake.listeners.resize ?? []).length, 0);
  });
});
