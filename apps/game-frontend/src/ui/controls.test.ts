/**
 * That derived enablement actually reaches the controls.
 *
 * A separate claim from `gameState.test.ts`, and the separation is the whole
 * reason this file exists. That suite proves `deriveEnablement` returns the
 * right answer; this one proves the answer is written to the button. **F24
 * is the case where exactly that gap bit**: the engine registry was right,
 * the module was registered, and a designer still could not select it,
 * because nothing connected the two. A phase model that no control reads is
 * the same bug wearing different clothes.
 *
 * Plain jsdom rather than the React harness — nothing here is a component.
 *
 * What this cannot establish: that `main.ts` calls this on every transition.
 * It subscribes once at startup, which is one line and not reachable without
 * standing up a socket and a canvas. Stated rather than left implied.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import globalJsdom from "global-jsdom";
import { applyEnablement, type Controls } from "./controls.js";

let teardown: (() => void) | null = null;
before(() => {
  teardown = globalJsdom(undefined, { pretendToBeVisual: true, url: "http://localhost/" });
});
after(() => teardown?.());

let controls: Controls;

beforeEach(() => {
  document.body.innerHTML = `
    <button id="spin">Spin</button>
    <div id="bets">
      <button class="bet">100</button>
      <button class="bet">200</button>
    </div>`;
  controls = {
    spin: document.getElementById("spin") as HTMLButtonElement,
    bets: document.getElementById("bets") as HTMLElement,
  };
});

const bets = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".bet")];

describe("applyEnablement", () => {
  it("enables spinning and betting when idle", () => {
    applyEnablement(controls, { phase: "idle" });

    assert.equal(controls.spin.disabled, false);
    assert.deepEqual(bets().map((b) => b.disabled), [false, false]);
  });

  it("disables the bet buttons for the whole round, not just the spin", () => {
    applyEnablement(controls, { phase: "spinning" });

    // Changing the stake mid-round would attach a bet to a round already
    // priced by the server. The spin button alone was what the old code
    // disabled; the bets stayed live.
    assert.equal(controls.spin.disabled, true);
    assert.deepEqual(bets().map((b) => b.disabled), [true, true]);
  });

  it("relabels the button to Skip while a result is being revealed", () => {
    applyEnablement(controls, { phase: "revealing", stopRequested: false });

    // The label is part of enablement rather than decoration: a live button
    // reading "Spin" that actually skips is worse than a disabled one,
    // because the player presses it believing they have placed a bet.
    assert.equal(controls.spin.disabled, false);
    assert.equal(controls.spin.textContent, "Skip");
  });

  it("disables the button once a skip has already been asked for", () => {
    applyEnablement(controls, { phase: "revealing", stopRequested: true });

    assert.equal(controls.spin.disabled, true);
  });

  it("restores the Spin label when the round ends", () => {
    applyEnablement(controls, { phase: "revealing", stopRequested: false });
    applyEnablement(controls, { phase: "idle" });

    // The label must not be one-way. A button stuck reading "Skip" on an
    // idle client tells the player the previous round never finished.
    assert.equal(controls.spin.textContent, "Spin");
    assert.equal(controls.spin.disabled, false);
  });

  it("locks everything while a bonus is open", () => {
    applyEnablement(controls, { phase: "bonus" });

    assert.equal(controls.spin.disabled, true);
    assert.deepEqual(bets().map((b) => b.disabled), [true, true]);
  });

  it("locks everything when offline or unrecoverable", () => {
    for (const state of [{ phase: "offline" }, { phase: "unrecoverable", code: "token_expired" }] as const) {
      applyEnablement(controls, state);
      assert.equal(controls.spin.disabled, true, `${state.phase} left the spin button live`);
      assert.deepEqual(bets().map((b) => b.disabled), [true, true], `${state.phase} left the bets live`);
    }
  });

  it("applies to bet buttons created after the first call", () => {
    // `buildBetControls` replaces these nodes when a game loads, so a cached
    // list would disable detached buttons while the real ones stayed live —
    // enabled controls during a round, which is the failure being prevented.
    applyEnablement(controls, { phase: "spinning" });

    controls.bets.innerHTML = `<button class="bet">500</button>`;
    applyEnablement(controls, { phase: "spinning" });

    assert.deepEqual(bets().map((b) => b.disabled), [true]);
  });

  it("copes with a game whose bet options have not been built yet", () => {
    // `fatal()` transitions before `buildBetControls` has run — an empty
    // container must not throw, or a failed launch becomes a crash.
    controls.bets.innerHTML = "";

    assert.doesNotThrow(() => applyEnablement(controls, { phase: "unrecoverable", code: "launch_failed" }));
    assert.equal(controls.spin.disabled, true);
  });
});
