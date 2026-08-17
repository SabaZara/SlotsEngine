/**
 * Autoplay's loop.
 *
 * **Held to the money standard rather than the presentation one, because
 * every iteration of this loop is a real bet.** The failure modes are not
 * cosmetic: a loop that fires one extra spin has spent money the player did
 * not authorise, and a loop that keeps running against a dropped socket
 * spends it into a session that may not be answering.
 *
 * So what is asserted here is mostly about *stopping* — the count being
 * exact, every abnormal exit ending the run, and a stop being idempotent so
 * two simultaneous causes do not double-report. The happy path is the easy
 * half.
 *
 * What these cannot establish: that the UI wires them up. A controller can
 * be perfect and unmounted — F24's shape, and the reason `main.ts`'s
 * wiring is exercised separately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOPLAY_SPIN_COUNTS,
  AutoplayController,
  canStartAutoplay,
  isSessionEnding,
  type AutoplayStopReason,
} from "./autoplay.js";
import type { GameState } from "./gameState.js";

const idle: GameState = { phase: "idle" };
const spinning: GameState = { phase: "spinning" };
const revealing: GameState = { phase: "revealing", stopRequested: false };
const bonus: GameState = { phase: "bonus" };
const offline: GameState = { phase: "offline" };

/** A controller plus the record of what it asked for. */
function setup(options: { spinSucceeds?: boolean; initial?: GameState } = {}) {
  const spins: number[] = [];
  const stops: AutoplayStopReason[] = [];
  let succeeds = options.spinSucceeds ?? true;
  const controller = new AutoplayController(options.initial ?? idle, {
    requestSpin: () => {
      spins.push(spins.length);
      return succeeds;
    },
    onStopped: (reason) => stops.push(reason),
  });
  return {
    controller,
    spins,
    stops,
    setSpinSucceeds: (v: boolean) => {
      succeeds = v;
    },
    /** The realistic round trip: a spin is requested, the client leaves
     * idle, and comes back to it when the round finishes. */
    completeRound: () => {
      controller.handleStateChange(spinning);
      controller.handleStateChange(revealing);
      controller.handleStateChange(idle);
    },
  };
}

describe("canStartAutoplay", () => {
  it("starts only from idle", () => {
    assert.equal(canStartAutoplay(idle), true);
  });

  it("refuses to start mid-reveal, where the spin button means skip", () => {
    // Stricter than "is the spin button live". Starting here would fire the
    // first spin into an animation the player is still watching.
    assert.equal(canStartAutoplay(revealing), false);
  });

  it("refuses to start during a spin, a bonus, or while disconnected", () => {
    assert.equal(canStartAutoplay(spinning), false);
    assert.equal(canStartAutoplay(bonus), false);
    assert.equal(canStartAutoplay(offline), false);
    assert.equal(canStartAutoplay({ phase: "unrecoverable", code: "token_spent" }), false);
  });
});

describe("isSessionEnding", () => {
  it("treats a dropped connection as ending the run", () => {
    // A reconnect may succeed, but the run must not silently resume — the
    // player would come back to a client spending money on spins they never
    // watched begin.
    assert.equal(isSessionEnding(offline), true);
  });

  it("treats a terminal error as ending the run", () => {
    assert.equal(isSessionEnding({ phase: "unrecoverable", code: "token_spent" }), true);
  });

  it("does not treat an ordinary round as ending it", () => {
    assert.equal(isSessionEnding(spinning), false);
    assert.equal(isSessionEnding(bonus), false);
  });
});

describe("a run spins exactly as many times as it was asked to", () => {
  it("fires the first spin immediately on start", () => {
    const { controller, spins } = setup();
    controller.setCount(10);

    controller.start();

    assert.equal(spins.length, 1, "a run must start spinning, not wait for a round to end");
  });

  it("fires exactly the configured number of spins and no more", () => {
    /*
     * The assertion this whole file exists for. Every extra iteration is a
     * real bet the player did not authorise, and an off-by-one here is
     * invisible — a run of 11 looks exactly like a run of 10.
     */
    const { controller, spins, completeRound } = setup();
    controller.setCount(10);
    controller.start();

    // Far more rounds than the run should survive.
    for (let i = 0; i < 30; i++) completeRound();

    assert.equal(spins.length, 10, `a run of 10 fired ${spins.length} spins`);
  });

  it("counts down as it goes and reports nothing left when done", () => {
    const { controller, completeRound } = setup();
    controller.setCount(10);
    controller.start();

    assert.equal(controller.status.remaining, 9, "the in-flight spin is already spent");
    completeRound();
    assert.equal(controller.status.remaining, 8);
  });

  it("reports completion when the counter runs out", () => {
    const { controller, stops, completeRound } = setup();
    controller.setCount(10);
    controller.start();
    for (let i = 0; i < 12; i++) completeRound();

    assert.deepEqual(stops, ["completed"]);
    assert.equal(controller.status.running, false);
  });

  it("offers only finite counts, never unlimited", () => {
    // A deliberate scope boundary rather than a missing feature: this engine
    // has no loss limit and no session limit, so "spin until the money runs
    // out" is a materially different product.
    assert.ok(AUTOPLAY_SPIN_COUNTS.length > 0);
    for (const count of AUTOPLAY_SPIN_COUNTS) {
      assert.ok(Number.isInteger(count) && count > 0, `${count} is not a finite spin count`);
    }
  });
});

describe("a run stops on anything unexpected", () => {
  it("stops when a spin cannot be sent, rather than counting down into nothing", () => {
    /*
     * The failure that would look like working software: the counter falls,
     * the label updates, and not one request reaches the server. Stopping is
     * honest; continuing is a client pretending to play.
     */
    const { controller, stops, setSpinSucceeds } = setup();
    controller.setCount(10);
    setSpinSucceeds(false);

    controller.start();

    assert.deepEqual(stops, ["spinRefused"]);
    assert.equal(controller.status.running, false);
  });

  it("charges the count for a spin it attempted, even when the send failed", () => {
    /*
     * Added after a surviving mutation, and the survivor was the important
     * one. Moving the decrement to AFTER `requestSpin()` leaves the spin
     * count identical — every assertion above still passed — and changes
     * only the counter: measured, 7 remaining versus 8 after a refusal on
     * the third spin.
     *
     * The order matters because a refused send is not always a dead
     * session. If the counter were rolled back on failure, a
     * refused-then-recovered run could fire more spins than the player
     * asked for, and every one of those is real money. Decrementing first
     * makes an attempt cost a count, so the run can only ever be shorter
     * than requested — never longer.
     *
     * Observed at the only moment the counter is still visible: `stop()`
     * zeroes it, so the assertion is made from inside `requestSpin` —
     * during the very call whose ordering is in question.
     */
    const seen: number[] = [];
    let succeeds = true;
    const controller = new AutoplayController(idle, {
      requestSpin: () => {
        seen.push(controller.status.remaining);
        return succeeds;
      },
    });
    controller.setCount(10);

    controller.start();
    assert.equal(seen[0], 9, "the count must already be spent when the request is made");

    succeeds = false;
    controller.handleStateChange(spinning);
    controller.handleStateChange(idle);
    assert.equal(seen[1], 8, "a second attempt costs a second count, refused or not");
  });

  it("stops the moment the connection drops", () => {
    const { controller, stops, spins } = setup();
    controller.setCount(50);
    controller.start();

    controller.handleStateChange(offline);

    assert.deepEqual(stops, ["sessionEnded"]);
    assert.equal(spins.length, 1, "no spin may be fired after the session ended");
  });

  it("stops on a terminal error", () => {
    const { controller, stops } = setup();
    controller.setCount(50);
    controller.start();

    controller.handleStateChange({ phase: "unrecoverable", code: "token_spent" });

    assert.deepEqual(stops, ["sessionEnded"]);
  });

  it("stops on a win when the player asked it to", () => {
    const { controller, stops, spins, completeRound } = setup();
    controller.setCount(50);
    controller.setStopOnWin(true);
    controller.start();

    controller.notifySpinResult(250);
    completeRound();

    assert.deepEqual(stops, ["wonWhileStopOnWin"]);
    assert.equal(spins.length, 1, "a stopped run must not fire again when the round ends");
  });

  it("keeps going through a losing spin", () => {
    const { controller, spins, completeRound } = setup();
    controller.setCount(50);
    controller.setStopOnWin(true);
    controller.start();

    controller.notifySpinResult(0);
    completeRound();

    assert.equal(spins.length, 2);
  });

  it("ignores a win when stop-on-win was not asked for", () => {
    const { controller, stops, completeRound } = setup();
    controller.setCount(50);
    controller.start();

    controller.notifySpinResult(5000);
    completeRound();

    assert.deepEqual(stops, []);
  });

  it("reports one ending even when two causes arrive at once", () => {
    // The player clicking stop as the socket drops. Two reports would show
    // the run ending twice, and any UI counting them would be wrong.
    const { controller, stops } = setup();
    controller.setCount(50);
    controller.start();

    controller.stop("stoppedByPlayer");
    controller.handleStateChange(offline);

    assert.deepEqual(stops, ["stoppedByPlayer"]);
  });

  it("is safe to stop when it was never running", () => {
    const { controller, stops } = setup();

    controller.stop();

    assert.deepEqual(stops, [], "stopping an idle controller must not report an ending");
  });
});

describe("a bonus round is waited out, not driven", () => {
  it("fires no spin while a bonus is open", () => {
    /*
     * A bonus needs real player decisions — which tile, when to spin the
     * free game. Autoplay must not race those, and it does not need to know
     * what a bonus is: it resumes on `idle`, which only arrives once the
     * bonus has resolved.
     */
    const { controller, spins } = setup();
    controller.setCount(50);
    controller.start();

    controller.handleStateChange(spinning);
    controller.handleStateChange(bonus);
    controller.handleStateChange(bonus);

    assert.equal(spins.length, 1, "autoplay must not spin the base game during a bonus");
  });

  it("resumes once the bonus hands control back", () => {
    const { controller, spins } = setup();
    controller.setCount(50);
    controller.start();

    controller.handleStateChange(bonus);
    controller.handleStateChange(idle);

    assert.equal(spins.length, 2);
  });
});

describe("the controls", () => {
  it("cannot be started twice", () => {
    const { controller, spins } = setup();
    controller.setCount(10);

    controller.start();
    controller.start();

    assert.equal(spins.length, 1, "a second start must not fire an extra spin");
  });

  it("locks its settings mid-run", () => {
    // "50" mid-run is ambiguous — 50 more, or 50 total? Every answer
    // surprises someone, so the question is not asked.
    const { controller } = setup();
    controller.setCount(10);
    controller.start();

    controller.setCount(100);

    assert.equal(controller.currentSettings.count, 10);
    assert.equal(controller.status.settingsEnabled, false);
  });

  it("accepts settings again once stopped", () => {
    const { controller } = setup();
    controller.start();
    controller.stop();

    controller.setCount(100);

    assert.equal(controller.currentSettings.count, 100);
    assert.equal(controller.status.settingsEnabled, true);
  });

  it("stays stoppable from a phase it could not have started in", () => {
    // Otherwise a player wanting out has to wait for the current spin to
    // finish first, which is the moment they least want to wait.
    const { controller } = setup();
    controller.start();
    controller.handleStateChange(spinning);

    assert.equal(controller.status.toggleEnabled, true);
  });

  it("offers no start from a phase that cannot begin a run", () => {
    const { controller } = setup({ initial: offline });

    assert.equal(controller.status.toggleEnabled, false);
  });

  it("toggles on and off", () => {
    const { controller, stops } = setup();

    controller.toggle();
    assert.equal(controller.status.running, true);

    controller.toggle();
    assert.equal(controller.status.running, false);
    assert.deepEqual(stops, ["stoppedByPlayer"]);
  });
});
