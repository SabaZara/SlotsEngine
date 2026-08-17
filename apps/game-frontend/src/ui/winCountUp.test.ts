/**
 * The count-up as it reaches the screen.
 *
 * `winPresentation.test.ts` proves the arithmetic; this proves the arithmetic
 * is actually *written*, which is a separate claim and the one F24 is about.
 * A correct count-up nothing renders is worth nothing.
 *
 * The clock and the frame scheduler are injected, so the animation runs
 * deterministically rather than being waited on. A test that sleeps for a
 * real 1400ms count-up is slow and flaky in the same breath; one that steps
 * a fake clock asserts the exact frames a player would see.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import globalJsdom from "global-jsdom";
import { startWinCountUp, writeFinalWin } from "./winCountUp.js";
import type { WinTier } from "../render/winPresentation.js";

let teardown: (() => void) | null = null;
before(() => {
  teardown = globalJsdom(undefined, { pretendToBeVisual: true, url: "http://localhost/" });
});
after(() => teardown?.());

let amount: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `<div id="win"></div>`;
  amount = document.getElementById("win") as HTMLElement;
});

/** A controllable clock plus scheduler, so frames land where the test says
 * rather than whenever the machine gets to them. */
function fakeClock() {
  let time = 0;
  const pending: Array<() => void> = [];
  return {
    now: () => time,
    schedule: (cb: () => void) => pending.push(cb),
    /** Advances the clock and runs exactly one queued frame. */
    tick(ms: number) {
      time += ms;
      const next = pending.shift();
      next?.();
    },
    get queued() {
      return pending.length;
    },
  };
}

describe("startWinCountUp", () => {
  it("writes an increasing amount as it counts", () => {
    const clock = fakeClock();
    startWinCountUp({ amount }, { winMinor: 5000, totalBetMinor: 100, now: clock.now, schedule: clock.schedule });

    const seen: string[] = [amount.textContent ?? ""];
    for (let i = 0; i < 12; i++) {
      clock.tick(100);
      seen.push(amount.textContent ?? "");
    }

    assert.ok(seen.length > 1);
    assert.notEqual(seen[0], seen.at(-1), "the amount never changed");
  });

  it("ends on exactly the amount that was won", () => {
    const clock = fakeClock();
    startWinCountUp({ amount }, { winMinor: 5000, totalBetMinor: 100, currency: "USD", now: clock.now, schedule: clock.schedule });

    for (let i = 0; i < 40; i++) clock.tick(100);

    // The figure a player is left looking at must be the figure the ledger
    // moved. Anything else is a discrepancy they can point at.
    assert.equal(amount.textContent, "Win $50.00");
  });

  it("never displays more than was won, at any frame", () => {
    const clock = fakeClock();
    startWinCountUp({ amount }, { winMinor: 5000, totalBetMinor: 100, currency: "USD", now: clock.now, schedule: clock.schedule });

    for (let i = 0; i < 40; i++) {
      clock.tick(37);
      const text = amount.textContent ?? "";
      if (text === "") continue;
      const shown = Number(text.replace("Win $", ""));
      assert.ok(shown <= 50, `a frame displayed ${text}, above the real 50.00 win`);
    }
  });

  it("renders minor units as money, never as a raw integer", () => {
    /**
     * The bug the reference shipped, asserted where it would actually
     * surface. A 2000-minor-unit win is 20.00; rendering it as "2000.00" is
     * a hundredfold overstatement, and it reached a real player there.
     */
    const clock = fakeClock();
    startWinCountUp({ amount }, { winMinor: 2000, totalBetMinor: 100, currency: "USD", now: clock.now, schedule: clock.schedule });

    for (let i = 0; i < 40; i++) clock.tick(100);

    assert.equal(amount.textContent, "Win $20.00");
  });

  it("clears the line for a losing spin rather than counting to zero", () => {
    // The previous round's win must not linger under a new result.
    amount.textContent = "Win $50.00";
    startWinCountUp({ amount }, { winMinor: 0, totalBetMinor: 100 });

    assert.equal(amount.textContent, "");
  });

  it("announces each tier once, in order, as the number crosses it", () => {
    // Edge-triggered. A level-triggered check fires the celebration on
    // every frame above the threshold instead of once as it is reached.
    const clock = fakeClock();
    const fired: WinTier[] = [];
    startWinCountUp(
      { amount },
      { winMinor: 100 * 60, totalBetMinor: 100, onTier: (t) => fired.push(t), now: clock.now, schedule: clock.schedule },
    );

    for (let i = 0; i < 200; i++) clock.tick(16);

    assert.deepEqual(fired, ["win", "big", "mega"]);
  });

  it("announces no tier at all for a win against a zero stake", () => {
    // A free spin costs nothing, so a bonus round genuinely reports a win
    // against a zero stake — every threshold would be zero and the loudest
    // celebration would fire on the smallest amount.
    const clock = fakeClock();
    const fired: WinTier[] = [];
    startWinCountUp(
      { amount },
      { winMinor: 100_000, totalBetMinor: 0, onTier: (t) => fired.push(t), now: clock.now, schedule: clock.schedule },
    );

    for (let i = 0; i < 60; i++) clock.tick(50);

    assert.deepEqual(fired, [], "a zero-stake win must not be tiered");
  });

  it("stops writing once cancelled", () => {
    /**
     * A spin can be skipped, and a count-up that outlives its round writes
     * a stale figure over the next one's — the player then sees the
     * previous win attached to the current spin, which is a wrong number
     * rather than a cosmetic glitch.
     */
    const clock = fakeClock();
    const cancel = startWinCountUp(
      { amount },
      { winMinor: 5000, totalBetMinor: 100, currency: "USD", now: clock.now, schedule: clock.schedule },
    );

    clock.tick(100);
    cancel();
    amount.textContent = "SOMETHING ELSE";
    for (let i = 0; i < 20; i++) clock.tick(100);

    assert.equal(amount.textContent, "SOMETHING ELSE", "a cancelled count-up kept writing");
  });

  it("schedules no further frames once complete", () => {
    // An animation that keeps requesting frames after it has finished is a
    // loop that never ends, on a page that stays open for a whole session.
    const clock = fakeClock();
    startWinCountUp({ amount }, { winMinor: 500, totalBetMinor: 100, now: clock.now, schedule: clock.schedule });

    for (let i = 0; i < 50; i++) clock.tick(100);

    assert.equal(clock.queued, 0, "the count-up is still scheduling frames after finishing");
  });
});

describe("writeFinalWin", () => {
  it("shows the full amount immediately", () => {
    // Skipping is always safe: the server settled the round before any of
    // this ran, so the number is not being decided by the animation.
    writeFinalWin({ amount }, 5000, "USD");
    assert.equal(amount.textContent, "Win $50.00");
  });

  it("clears the line for a losing spin", () => {
    amount.textContent = "Win $50.00";
    writeFinalWin({ amount }, 0, "USD");
    assert.equal(amount.textContent, "");
  });
});
