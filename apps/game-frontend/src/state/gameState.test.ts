/**
 * The client's phase model and the enablement derived from it.
 *
 * These need no DOM, which is the reason this piece was done first: the
 * scattered booleans it replaces (`spinInFlight`, renderer nullability,
 * direct `disabled` assignment) were untestable only because they were
 * spread across a class that owns a canvas. Extracted, they are ordinary
 * functions.
 *
 * The property worth stating: **enablement is a pure function of state**,
 * so two controls can never disagree about whether a round is in flight.
 * The bug that shape prevents is a spin button re-enabled by one path while
 * another still considers itself busy — which on this client would let a
 * player bet into a round that has not finished paying.
 *
 * What these tests cannot establish: that `main.ts` actually drives the
 * machine, or that the renderer honours a skip. Those are integration
 * concerns, and the machine being right is a precondition for them rather
 * than a substitute. Recorded here rather than left implied, per the file
 * headers elsewhere in this repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameStateMachine, deriveEnablement, isRecoverable, type GameState } from "./gameState.js";

describe("deriveEnablement", () => {
  it("lets a player spin and change their bet only when idle", () => {
    assert.deepEqual(deriveEnablement({ phase: "idle" }), {
      spinEnabled: true,
      skipAffordance: false,
      betControlsEnabled: true,
    });
  });

  it("offers no skip while spinning, because no result exists to skip to", () => {
    // The distinction from `revealing`. A button that offers to skip
    // something undecided would either do nothing or, worse, imply the
    // outcome is already on screen.
    assert.deepEqual(deriveEnablement({ phase: "spinning" }), {
      spinEnabled: false,
      skipAffordance: false,
      betControlsEnabled: false,
    });
  });

  it("offers a skip while revealing a known result", () => {
    assert.deepEqual(deriveEnablement({ phase: "revealing", stopRequested: false }), {
      spinEnabled: true,
      skipAffordance: true,
      betControlsEnabled: false,
    });
  });

  it("withdraws the skip once one has been asked for", () => {
    assert.deepEqual(deriveEnablement({ phase: "revealing", stopRequested: true }), {
      spinEnabled: false,
      skipAffordance: false,
      betControlsEnabled: false,
    });
  });

  it("refuses a base-game spin while a bonus is open", () => {
    // Betting into an unfinished round is the money-path consequence, not
    // merely a confusing one.
    assert.equal(deriveEnablement({ phase: "bonus" }).spinEnabled, false);
    assert.equal(deriveEnablement({ phase: "bonus" }).betControlsEnabled, false);
  });

  it("refuses everything while offline or unrecoverable", () => {
    for (const state of [{ phase: "offline" }, { phase: "unrecoverable", code: "token_expired" }] as GameState[]) {
      const enablement = deriveEnablement(state);
      assert.equal(enablement.spinEnabled, false, `${state.phase} must not allow a spin`);
      assert.equal(enablement.betControlsEnabled, false, `${state.phase} must not allow a bet change`);
    }
  });

  it("never enables the bet controls outside idle", () => {
    // Stated as a property over every phase rather than case by case, so a
    // phase added later has to satisfy it or fail here.
    const states: GameState[] = [
      { phase: "spinning" },
      { phase: "revealing", stopRequested: false },
      { phase: "revealing", stopRequested: true },
      { phase: "bonus" },
      { phase: "offline" },
      { phase: "unrecoverable", code: "invalid_token" },
    ];
    for (const state of states) {
      assert.equal(deriveEnablement(state).betControlsEnabled, false, `${state.phase} must not allow a bet change`);
    }
  });

  it("only ever offers a skip when the spin button is live", () => {
    // The two flags are separate, but one combination is incoherent: an
    // affordance on a dead button. Asserted as an implication so it holds
    // for phases added later.
    const states: GameState[] = [
      { phase: "idle" },
      { phase: "spinning" },
      { phase: "revealing", stopRequested: false },
      { phase: "revealing", stopRequested: true },
      { phase: "bonus" },
      { phase: "offline" },
      { phase: "unrecoverable", code: "x" },
    ];
    for (const state of states) {
      const { spinEnabled, skipAffordance } = deriveEnablement(state);
      if (skipAffordance) assert.equal(spinEnabled, true, `${state.phase} offers a skip on a disabled button`);
    }
  });
});

describe("isRecoverable", () => {
  it("separates a dropped connection from a spent token", () => {
    // The client can retry one and not the other, and telling a player to
    // reconnect when the casino has to relaunch them is worse than silence.
    assert.equal(isRecoverable({ phase: "offline" }), true);
    assert.equal(isRecoverable({ phase: "unrecoverable", code: "token_already_used" }), false);
  });
});

describe("GameStateMachine", () => {
  it("starts offline, since nothing is known before the socket joins", () => {
    assert.deepEqual(new GameStateMachine().current, { phase: "offline" });
  });

  it("notifies a subscriber with both the new and previous state", () => {
    const machine = new GameStateMachine({ phase: "idle" });
    const seen: Array<[string, string]> = [];
    machine.subscribe((next, previous) => seen.push([previous.phase, next.phase]));

    machine.transition({ phase: "spinning" });

    assert.deepEqual(seen, [["idle", "spinning"]]);
  });

  it("notifies on a same-phase transition, because revealing carries a payload", () => {
    // Suppressing same-phase notifications is the obvious optimisation and
    // it is wrong here: flipping `stopRequested` never changes the phase,
    // so the one transition the skip depends on would be swallowed.
    const machine = new GameStateMachine({ phase: "revealing", stopRequested: false });
    let notifications = 0;
    machine.subscribe(() => (notifications += 1));

    machine.transition({ phase: "revealing", stopRequested: true });

    assert.equal(notifications, 1);
  });

  it("stops notifying once unsubscribed", () => {
    const machine = new GameStateMachine({ phase: "idle" });
    let notifications = 0;
    const unsubscribe = machine.subscribe(() => (notifications += 1));

    machine.transition({ phase: "spinning" });
    unsubscribe();
    machine.transition({ phase: "idle" });

    assert.equal(notifications, 1);
  });

  it("survives a listener that unsubscribes itself mid-notification", () => {
    const machine = new GameStateMachine({ phase: "idle" });
    const order: string[] = [];
    const unsubscribeFirst = machine.subscribe(() => {
      order.push("first");
      unsubscribeFirst();
    });
    machine.subscribe(() => order.push("second"));

    machine.transition({ phase: "spinning" });

    assert.deepEqual(order, ["first", "second"], "the second listener must still be notified");
  });

  it("notifies a listener that an earlier listener unsubscribed", () => {
    /**
     * This is the case that actually needs the defensive copy, and the
     * distinction was found by mutation rather than by reasoning: replacing
     * `[...this.listeners]` with the live set left the self-unsubscribe test
     * above still passing.
     *
     * Measured why: a `Set` deleting the **current** element mid-iteration
     * still visits every remaining one, so self-removal is invisible.
     * Deleting an element the iterator has **not yet reached** does skip it.
     * So only one listener removing *another* can tell the two apart.
     *
     * Not hypothetical here — a teardown path where one subscriber disposes
     * of its siblings is exactly this shape, and the symptom would be a
     * control left stale because its listener was silently skipped.
     */
    const machine = new GameStateMachine({ phase: "idle" });
    const order: string[] = [];
    let unsubscribeSecond = (): void => {};

    machine.subscribe(() => {
      order.push("first");
      unsubscribeSecond();
    });
    unsubscribeSecond = machine.subscribe(() => order.push("second"));

    machine.transition({ phase: "spinning" });

    assert.deepEqual(
      order,
      ["first", "second"],
      "the snapshot taken before notifying must still include a listener removed during it",
    );
  });

  it("exposes enablement derived from its current state", () => {
    const machine = new GameStateMachine({ phase: "idle" });
    assert.equal(machine.enablement.spinEnabled, true);

    machine.transition({ phase: "bonus" });

    assert.equal(machine.enablement.spinEnabled, false);
  });

  describe("requestSkip", () => {
    it("marks a running reveal as skipped", () => {
      const machine = new GameStateMachine({ phase: "revealing", stopRequested: false });

      machine.requestSkip();

      assert.deepEqual(machine.current, { phase: "revealing", stopRequested: true });
    });

    it("ignores a second request, so a double-click notifies once", () => {
      const machine = new GameStateMachine({ phase: "revealing", stopRequested: false });
      let notifications = 0;
      machine.subscribe(() => (notifications += 1));

      machine.requestSkip();
      machine.requestSkip();

      assert.equal(notifications, 1);
      assert.deepEqual(machine.current, { phase: "revealing", stopRequested: true });
    });

    it("does nothing while spinning, where there is no result to skip to", () => {
      const machine = new GameStateMachine({ phase: "spinning" });
      let notifications = 0;
      machine.subscribe(() => (notifications += 1));

      machine.requestSkip();

      assert.deepEqual(machine.current, { phase: "spinning" });
      assert.equal(notifications, 0);
    });

    it("does not resurrect a finished round from idle", () => {
      // The keypress-after-settle case: space is bound to both spin and
      // skip, so a skip can arrive one frame after the reveal ended.
      const machine = new GameStateMachine({ phase: "idle" });

      machine.requestSkip();

      assert.deepEqual(machine.current, { phase: "idle" });
    });
  });
});
