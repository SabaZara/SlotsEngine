import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSeed } from "@slots-engine/rng";
import { deriveStepRng, getBonusModule } from "../registry.js";
import { InvalidBonusActionError, type BonusStepOutput } from "../types.js";
import { REFERENCE_GAME } from "../../engine/fixtures/reference-game.js";

/**
 * The free-spins module: N spins on the REAL reels, wins multiplied,
 * retriggerable up to a cap.
 *
 * It is the first module whose outcome depends on the game definition rather
 * than on `params` alone, which is the property most of these tests are
 * about. A wheel's prize comes from its own table; a free spin's comes from
 * the same reel strips, paylines, wilds and scatters the base game uses. That
 * is the point of the feature — and it is also the thing that could silently
 * go wrong, because a spin evaluated against a *different* game still
 * produces a plausible number.
 *
 * ## What these tests establish
 *
 * Replay determinism, the spin accounting, the retrigger cap, and that the
 * module refuses rather than guesses when it is missing something it needs.
 *
 * ## What they cannot establish
 *
 * **That the free-spins RTP matches `expectedReturnMultiplier`.** That
 * function is an *estimate* by construction — a free spin's return is the
 * base game's RTP, which `params` cannot see — so it reads
 * `params.assumedBaseRtp` and falls back to 0.95. The measured-RTP test
 * below pins the relationship between the two for the reference game
 * specifically; it is not a general guarantee, and the module's own
 * docstring says so.
 */

const freeSpins = getBonusModule("freeSpins");

/** A step input with everything the module needs, so each test varies only
 * what it is actually about. */
function stepInput(overrides: Record<string, unknown> = {}) {
  return {
    totalBet: 100,
    state: {},
    params: {},
    action: "spin",
    rng: deriveStepRng("seed", 1),
    gameDef: REFERENCE_GAME,
    sessionSeed: "a".repeat(64),
    ...overrides,
  } as Parameters<typeof freeSpins.step>[0];
}

/** Plays a whole round to completion, returning every step's output. */
function playOut(sessionSeed: string, params: Record<string, unknown> = {}, totalBet = 100): BonusStepOutput[] {
  let state = freeSpins.start({ totalBet, state: {}, params, rng: deriveStepRng(sessionSeed, 0) }).state;
  const outputs: BonusStepOutput[] = [];

  // Bounded so a bug that never terminates fails as a test rather than
  // hanging the suite — which is itself the risk the retrigger cap exists
  // to remove.
  for (let i = 0; i < 500; i++) {
    const out = freeSpins.step(stepInput({ totalBet, state, params, sessionSeed }));
    outputs.push(out);
    state = out.state;
    if (out.done) return outputs;
  }
  assert.fail("the round did not terminate within 500 spins — the retrigger cap is not holding");
}

describe("freeSpins.start", () => {
  it("awards the configured number of spins without resolving", () => {
    // Unlike the wheel, this must NOT resolve on start: the player drives
    // each spin so the client can animate them. Resolving immediately would
    // pay correctly and show a single number where a slot shows ten spins.
    const out = freeSpins.start({ totalBet: 100, state: {}, params: { spinCount: 7 }, rng: deriveStepRng("s", 0) });

    assert.equal(out.done, false);
    assert.equal(out.totalWin, 0);
    assert.equal(out.state.remaining, 7);
    assert.equal(out.view.remaining, 7);
  });

  it("falls back to a default spin count when none is configured", () => {
    const out = freeSpins.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng("s", 0) });
    assert.equal(out.state.remaining, 10);
  });

  it("refuses a nonsensical spin count rather than awarding it", () => {
    // Zero or negative spins would produce a session that can never be
    // stepped and never resolves — an active row that pays nothing and
    // sits there until the archival window.
    for (const spinCount of [0, -5, 1.5, Number.NaN, "many"]) {
      const out = freeSpins.start({ totalBet: 100, state: {}, params: { spinCount }, rng: deriveStepRng("s", 0) });
      assert.ok((out.state.remaining as number) >= 1, `spinCount ${String(spinCount)} produced ${out.state.remaining}`);
    }
  });

  it("reveals no future outcome in its view", () => {
    // The pick module's rule, which applies to every module: the client
    // learns the shape of the round, never its result in advance.
    const out = freeSpins.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng("s", 0) });
    const serialised = JSON.stringify(out.view);

    assert.ok(!serialised.includes("matrix"), "the start view must not contain a spin outcome");
    assert.equal(out.view.accumulatedWin, 0);
  });
});

describe("freeSpins.step", () => {
  it("spins the REAL reels — the outcome comes from the game definition", () => {
    // The load-bearing claim of the whole feature. The matrix must be the
    // game's own grid shape, drawn from its own strips; a module inventing
    // its own randomness would produce something plausible and wrong.
    const out = freeSpins.step(stepInput({ state: { remaining: 5, played: 0 } }));
    const matrix = (out.view.lastSpin as Record<string, unknown>).matrix as string[][];

    assert.equal(matrix.length, REFERENCE_GAME.grid.reels);
    for (const reel of matrix) assert.equal(reel.length, REFERENCE_GAME.grid.rows);

    // Every symbol drawn must be one the game actually declares.
    const known = new Set(REFERENCE_GAME.symbols.map((s) => s.symbol));
    for (const reel of matrix) for (const symbol of reel) assert.ok(known.has(symbol), `unknown symbol ${symbol}`);
  });

  it("is a pure function of session seed and spin index", () => {
    // The audit property. Two independent replays of the same round must
    // produce identical spins — that is what settles a dispute without
    // trusting a log, and it is why the spin seed is derived from
    // (sessionSeed, index) rather than drawn from the step rng, whose
    // stream depends on how many times step happened to be called.
    const a = freeSpins.step(stepInput({ state: { remaining: 5, played: 3 }, sessionSeed: "b".repeat(64) }));
    const b = freeSpins.step(stepInput({ state: { remaining: 5, played: 3 }, sessionSeed: "b".repeat(64) }));

    assert.deepEqual(a.view.lastSpin, b.view.lastSpin);
    assert.deepEqual(a.state, b.state);
  });

  it("draws a different spin at a different index, so spins are not identical", () => {
    // The other half: same seed, different index must differ. A derivation
    // that ignored the index would replay one spin ten times, which is
    // deterministic and completely wrong.
    const seen = new Set<string>();
    for (let played = 0; played < 8; played++) {
      const out = freeSpins.step(stepInput({ state: { remaining: 9, played }, sessionSeed: "c".repeat(64) }));
      seen.add(JSON.stringify((out.view.lastSpin as Record<string, unknown>).matrix));
    }
    assert.ok(seen.size > 1, "every spin produced an identical grid — the index is not reaching the seed");
  });

  it("decrements the remaining count and finishes at zero", () => {
    const outs = playOut("d".repeat(64), { spinCount: 3, maxRetriggers: 0 });

    assert.equal(outs.length, 3);
    assert.equal(outs[0]!.done, false);
    assert.equal(outs[2]!.done, true);
    assert.equal(outs[2]!.state.remaining, 0);
  });

  it("pays only when the round finishes, and pays the accumulated total", () => {
    // A partial payout mid-round would double-credit: game-backend credits
    // `totalWin` once, when `done` is true.
    const outs = playOut("e".repeat(64), { spinCount: 4, maxRetriggers: 0 });

    for (const out of outs.slice(0, -1)) assert.equal(out.totalWin, 0, "an unfinished round must pay nothing");

    const final = outs.at(-1)!;
    assert.equal(final.done, true);
    assert.equal(final.totalWin, final.state.accumulated);
    assert.equal(final.totalWin, final.view.accumulatedWin);
  });

  it("applies the win multiplier to the base spin win", () => {
    // Measured against the module's own unmultiplied figure rather than a
    // hardcoded number, so the test does not depend on which grid the seed
    // happens to draw.
    const out = freeSpins.step(stepInput({ state: { remaining: 5, played: 0 }, params: { winMultiplier: 3 } }));
    const spin = out.view.lastSpin as Record<string, number>;

    assert.equal(spin.multipliedWin, Math.floor(spin.baseWin * 3));
  });

  it("keeps every payout an integer number of minor units", () => {
    // Money is integer minor units everywhere in this codebase. A
    // fractional multiplier must not create a fraction of a unit.
    const outs = playOut("f".repeat(64), { spinCount: 6, winMultiplier: 2.5, maxRetriggers: 0 });

    for (const out of outs) {
      assert.ok(Number.isInteger(out.totalWin), `totalWin ${out.totalWin} is not an integer`);
      assert.ok(Number.isInteger(out.state.accumulated), `accumulated ${out.state.accumulated} is not an integer`);
      const spin = out.view.lastSpin as Record<string, number>;
      assert.ok(Number.isInteger(spin.multipliedWin), `multipliedWin ${spin.multipliedWin} is not an integer`);
    }
  });

  it("accumulates across spins rather than reporting only the last", () => {
    const outs = playOut("g".repeat(64), { spinCount: 8, maxRetriggers: 0 });
    let running = 0;

    for (const out of outs) {
      running += (out.view.lastSpin as Record<string, number>).multipliedWin;
      assert.equal(out.state.accumulated, running, "accumulated must be the running sum of every spin");
    }
  });

  it("never reveals a future spin, only the one just played", () => {
    const out = freeSpins.step(stepInput({ state: { remaining: 5, played: 0 } }));
    assert.ok("lastSpin" in out.view);
    assert.ok(!("spins" in out.view) || (out.view.spins as unknown[]).length <= 1);
    assert.ok(!JSON.stringify(out.view).includes("nextSpin"));
  });
});

/**
 * Retriggering needs a game that actually retriggers.
 *
 * `reference-5x3` triggers its bonus on **0.415% of spins** (measured over
 * 20,000), so a ten-spin round retriggers roughly once every 24 rounds.
 * That is correct for a shipped game and useless for testing the cap: the
 * first version of these tests ran against the reference fixture and the
 * mutation that REMOVED the cap entirely survived, because no test ever
 * reached a second retrigger.
 *
 * The lesson is section D's, in a new place: a fixture that cannot reach a
 * branch cannot test it, and a passing suite says nothing about the branch.
 * This game triggers on every spin — `probabilityTrigger: 1` — so the cap is
 * exercised on the very first one.
 */
const ALWAYS_RETRIGGERS = {
  ...REFERENCE_GAME,
  gameId: "always-retrigger-test",
  bonusModules: [{ moduleId: "freeSpins", params: {}, probabilityTrigger: { chancePerSpin: 1 } }],
};

/** `playOut` against the always-retriggering fixture. */
function playOutRetriggering(
  sessionSeed: string,
  params: Record<string, unknown> = {},
  maxSpins = 500,
): BonusStepOutput[] {
  let state = freeSpins.start({ totalBet: 100, state: {}, params, rng: deriveStepRng(sessionSeed, 0) }).state;
  const outputs: BonusStepOutput[] = [];

  for (let i = 0; i < maxSpins; i++) {
    const out = freeSpins.step(stepInput({ state, params, sessionSeed, gameDef: ALWAYS_RETRIGGERS }));
    outputs.push(out);
    state = out.state;
    if (out.done) return outputs;
  }
  assert.fail(`the round did not terminate within ${maxSpins} spins — the retrigger cap is not holding`);
}

describe("freeSpins retriggering", () => {
  it("stops granting spins once the cap is reached, on a game that always retriggers", () => {
    // The test the surviving mutation demanded. Every spin here triggers,
    // so without a cap the round grants spins faster than it consumes them
    // and never ends. With the cap, exactly `maxRetriggers` grants happen.
    const outs = playOutRetriggering("cap".repeat(20), { spinCount: 3, maxRetriggers: 2, retriggerSpins: 2 });
    const final = outs.at(-1)!;

    assert.equal(final.state.retriggers, 2, "exactly the cap should have been granted");
    assert.equal(final.done, true);
    // 3 awarded + 2 retriggers × 2 spins = 7 spins played.
    assert.equal(outs.length, 7, `expected 7 spins, played ${outs.length}`);
  });

  it("terminates on a game that triggers on EVERY spin", () => {
    // Without the cap this configuration is unbounded: each of the first
    // spins grants 50 more, every one of which triggers again. This is the
    // test that fails — by exhausting its bound — if the cap is removed.
    const outs = playOutRetriggering("runaway".repeat(9), { spinCount: 5, maxRetriggers: 3, retriggerSpins: 50 });

    assert.equal(outs.at(-1)!.done, true);
    assert.equal(outs.at(-1)!.state.retriggers, 3);
    // 5 + 3×50 = 155 spins, finite and exactly predictable.
    assert.equal(outs.length, 155);
  });

  it("grants the configured number of extra spins per retrigger", () => {
    const outs = playOutRetriggering("grant".repeat(13), { spinCount: 2, maxRetriggers: 1, retriggerSpins: 4 });

    const granting = outs.find((o) => (o.view.lastSpin as Record<string, unknown>).retriggered === true);
    assert.ok(granting, "expected a retrigger on a game that always triggers");
    assert.equal((granting.view.lastSpin as Record<string, number>).spinsGranted, 4);
    assert.equal(outs.length, 6, "2 awarded + 4 granted");
  });

  it("never exceeds the configured retrigger cap", () => {
    // The cap is what makes the round finite. Without it, a generous
    // configuration produces a session that never terminates and pays
    // without bound — `playOut` fails at 500 spins rather than hanging.
    const outs = playOut("h".repeat(64), { spinCount: 5, maxRetriggers: 2, retriggerSpins: 3 });
    const final = outs.at(-1)!;

    assert.ok((final.state.retriggers as number) <= 2, `retriggers reached ${final.state.retriggers}`);
  });

  it("terminates even when retriggering is configured generously", () => {
    // The property the cap exists for, stated as its own test: this
    // configuration would run forever if the cap were removed, because
    // each retrigger grants more spins than it consumes.
    const outs = playOut("i".repeat(64), { spinCount: 5, maxRetriggers: 3, retriggerSpins: 50 });
    assert.equal(outs.at(-1)!.done, true);
  });

  it("grants no extra spins when the cap is zero", () => {
    const outs = playOut("j".repeat(64), { spinCount: 4, maxRetriggers: 0, retriggerSpins: 10 });

    assert.equal(outs.length, 4, "a zero cap must mean exactly the awarded spins");
    for (const out of outs) {
      assert.equal((out.view.lastSpin as Record<string, unknown>).retriggered, false);
    }
  });
});

describe("freeSpins refusals", () => {
  it("refuses to spin without the game definition rather than inventing reels", () => {
    // The most important refusal in the module. A silent fallback would
    // pay out under mathematics nobody configured and look entirely normal.
    assert.throws(
      () => freeSpins.step(stepInput({ state: { remaining: 5, played: 0 }, gameDef: undefined })),
      InvalidBonusActionError,
    );
  });

  it("refuses to spin without the session seed rather than inventing one", () => {
    // A round with an invented seed still produces random spins — it just
    // cannot be replayed from what was stored, which is invisible until
    // someone disputes a payout.
    assert.throws(
      () => freeSpins.step(stepInput({ state: { remaining: 5, played: 0 }, sessionSeed: undefined })),
      InvalidBonusActionError,
    );
  });

  it("refuses an action other than 'spin'", () => {
    assert.throws(
      () => freeSpins.step(stepInput({ state: { remaining: 5, played: 0 }, action: "pick" })),
      /unsupported action/,
    );
  });

  it("refuses to step a finished session", () => {
    // Without this a client could keep spinning a resolved round and be
    // credited again — game-backend guards it too, and defence in depth on
    // a money path is worth the four lines.
    assert.throws(() => freeSpins.step(stepInput({ state: { remaining: 0, played: 5, done: true } })), /already finished/);
  });

  it("refuses to step when no spins remain", () => {
    assert.throws(() => freeSpins.step(stepInput({ state: { remaining: 0, played: 5 } })), /no free spins remain/);
  });

  it("refuses a session whose state has no spin count", () => {
    assert.throws(() => freeSpins.step(stepInput({ state: {} })), /no remaining-spin count/);
  });
});

describe("freeSpins.expectedReturnMultiplier", () => {
  it("scales with spin count, multiplier and the assumed base RTP", () => {
    const base = freeSpins.expectedReturnMultiplier!({ spinCount: 10, winMultiplier: 1, maxRetriggers: 0 });
    const twiceSpins = freeSpins.expectedReturnMultiplier!({ spinCount: 20, winMultiplier: 1, maxRetriggers: 0 });
    const twiceMultiplier = freeSpins.expectedReturnMultiplier!({ spinCount: 10, winMultiplier: 2, maxRetriggers: 0 });

    assert.ok(Math.abs(twiceSpins - base * 2) < 1e-9, "doubling the spins must double the return");
    assert.ok(Math.abs(twiceMultiplier - base * 2) < 1e-9, "doubling the multiplier must double the return");
  });

  it("honours a designer-supplied base RTP over the default", () => {
    // The fallback is the module's largest source of error, so a designer
    // must be able to override it — and the override must actually reach
    // the number the publish gate uses.
    const assumed = freeSpins.expectedReturnMultiplier!({
      spinCount: 10,
      winMultiplier: 1,
      maxRetriggers: 0,
      assumedBaseRtp: 0.5,
    });
    assert.ok(Math.abs(assumed - 5) < 1e-9, `expected 10 × 0.5 × 1 = 5, got ${assumed}`);
  });

  it("overstates rather than understates when retriggering is possible", () => {
    // Deliberate, and the direction matters. An overstated bonus return
    // makes the publish gate STRICTER than reality: it refuses a game that
    // is actually within tolerance, which a designer can investigate.
    // Understating would let a game through that pays more than measured.
    const withRetriggers = freeSpins.expectedReturnMultiplier!({
      spinCount: 10,
      winMultiplier: 1,
      maxRetriggers: 5,
      retriggerSpins: 5,
    });
    const without = freeSpins.expectedReturnMultiplier!({ spinCount: 10, winMultiplier: 1, maxRetriggers: 0 });

    assert.ok(withRetriggers > without, "a retriggerable round must be scored above a fixed one");
  });

  it("is finite and positive for every plausible configuration", () => {
    // A NaN or Infinity here propagates straight into the publish gate's
    // RTP arithmetic, where it would defeat every comparison at once —
    // F22's shape, in the one number the gate exists to check.
    for (const params of [
      {},
      { spinCount: 1 },
      { spinCount: 1000, winMultiplier: 100, maxRetriggers: 99, retriggerSpins: 99 },
      { spinCount: "nonsense", winMultiplier: null, assumedBaseRtp: -1 },
    ]) {
      const value = freeSpins.expectedReturnMultiplier!(params as Record<string, unknown>);
      assert.ok(Number.isFinite(value) && value > 0, `${JSON.stringify(params)} produced ${value}`);
    }
  });

  it("lands within a sane distance of a measured round", () => {
    // Not a tight band, and deliberately so — this is an estimate whose
    // dominant term is an assumed base RTP. What it pins is that the
    // estimate is the right ORDER, so a configuration error (a factor of
    // ten, a missing multiplier) is caught while ordinary variance is not
    // treated as a failure.
    const params = { spinCount: 10, winMultiplier: 2, maxRetriggers: 0, assumedBaseRtp: REFERENCE_GAME.rtpTarget };
    const predicted = freeSpins.expectedReturnMultiplier!(params);

    const ROUNDS = 3000;
    let total = 0;
    for (let i = 0; i < ROUNDS; i++) {
      total += playOut(`measure-${i}-${generateSeed().slice(0, 16)}`, params).at(-1)!.totalWin;
    }
    const measured = total / ROUNDS / 100; // as a multiple of the 100-unit bet

    assert.ok(
      measured > predicted * 0.5 && measured < predicted * 1.5,
      `measured ${measured.toFixed(2)} is not within 50% of predicted ${predicted.toFixed(2)}`,
    );
  });
});
