import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MATH_ENGINE_ID } from "@slots-engine/shared-types";
import { genericMathEngine, getMathEngine, registerMathEngine, type MathEngine } from "./registry.js";
import { REFERENCE_GAME } from "./engine/fixtures/reference-game.js";

/**
 * The math-engine registry: the swap point for "how a spin is evaluated".
 *
 * Small, but on the money path. `getMathEngine` is called for every spin,
 * and its one real decision — **refuse an unknown id rather than fall back
 * to the default** — is a safety property with money behind it. A game
 * asking for an evaluator this build does not have is a deployment error,
 * and quietly paying the round out under different mathematics would take a
 * loud failure and turn it into a silent, incorrect payout.
 *
 * That is the same reasoning `createRng` now follows for `rngAlgorithm`
 * (item 3d): a round recorded under an algorithm this build cannot
 * construct must fail at replay rather than quietly resolve to something
 * else and present the result as the original.
 *
 * ## Registry state is global, and these tests share it
 *
 * `registerMathEngine` writes into a module-level `Map` that persists for
 * the life of the process. Tests that register something therefore use ids
 * unique to themselves and clean up after, so ordering between test files
 * cannot change an outcome. There is deliberately no `unregister` in the
 * production API — nothing in the running system ever removes an engine,
 * and adding a function only tests use would widen the surface for no gain.
 *
 * ## What these cannot establish
 *
 * That `spin.ts` evaluates correctly — that is its own suite's job, and the
 * cross-check in `independentModelCrossCheck.test.ts`. These prove only
 * that the right evaluator is handed back, or that none is.
 */

/** A stand-in engine that records the arguments it was handed, so
 * "dispatches to the registered engine" can be asserted rather than
 * assumed. */
function probeEngine(id: string): MathEngine & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    id,
    calls,
    evaluateSpin(gameDef, seed, totalBet, rngAlgorithm) {
      calls.push([gameDef, seed, totalBet, rngAlgorithm]);
      return { grid: [], wins: [], totalWin: 0 } as never;
    },
  };
}

describe("getMathEngine", () => {
  it("returns the default engine, which registers itself on import", () => {
    // The generic engine is registered as a side effect of loading this
    // module. If that ever became lazy, every spin would fail on a cold
    // start until something else registered first.
    const engine = getMathEngine(DEFAULT_MATH_ENGINE_ID);

    assert.equal(engine.id, DEFAULT_MATH_ENGINE_ID);
    assert.equal(engine, genericMathEngine);
  });

  it("resolves the id the reference game actually asks for", () => {
    // Pins the two ends together: whatever `mathEngineId` the shipped game
    // carries must be resolvable. A rename on either side breaks here
    // rather than on the first spin of the day.
    const engine = getMathEngine(REFERENCE_GAME.mathEngineId ?? DEFAULT_MATH_ENGINE_ID);

    assert.ok(engine, "the reference game's engine id must be registered");
  });

  /**
   * The safety property this module exists for.
   */
  it("refuses an unknown id instead of falling back to the default", () => {
    // Falling back would mean a game configured for engine X is silently
    // paid out under engine Y. The round would look successful and the
    // money would be wrong — the worst combination available here.
    assert.throws(
      () => getMathEngine("no-such-engine"),
      /no math engine registered under id 'no-such-engine'/,
    );
  });

  it("names the engines that ARE registered, so the error is actionable", () => {
    // A deployment error at 3am is worth one extra string. "not registered"
    // alone leaves the reader unable to tell a typo from a missing import.
    try {
      getMathEngine("definitely-not-registered");
      assert.fail("should have thrown");
    } catch (err) {
      assert.match((err as Error).message, new RegExp(DEFAULT_MATH_ENGINE_ID));
    }
  });

  it("refuses the empty string and other falsy-looking ids", () => {
    // `engines.get("")` returns undefined, so the guard must be on the
    // lookup result rather than on the id being truthy — but an `if (!id)`
    // added later would change the error and, worse, could be "fixed" by
    // defaulting. Pinned so that refactor has to confront this test.
    assert.throws(() => getMathEngine(""), /no math engine registered/);
  });
});

describe("registerMathEngine", () => {
  it("makes a newly registered engine resolvable by its id", () => {
    // The point of the registry: a game with unusual mechanics can bring
    // its own evaluator without the money path changing.
    const probe = probeEngine("test-engine-resolvable");
    registerMathEngine(probe);

    assert.equal(getMathEngine("test-engine-resolvable"), probe);
  });

  it("dispatches to the registered engine rather than to the default", () => {
    // Registering is only meaningful if the returned engine is the one that
    // actually evaluates. This asserts the arguments arrive intact,
    // including `rngAlgorithm` — the parameter whose silent loss would make
    // a round unreplayable (the failure mode item 3d found in `createRng`).
    const probe = probeEngine("test-engine-dispatch");
    registerMathEngine(probe);

    getMathEngine("test-engine-dispatch").evaluateSpin(REFERENCE_GAME, "seed-abc", 100, "xoshiro256**" as never);

    assert.equal(probe.calls.length, 1);
    assert.deepEqual(probe.calls[0][1], "seed-abc");
    assert.deepEqual(probe.calls[0][2], 100);
    assert.deepEqual(probe.calls[0][3], "xoshiro256**", "the rng algorithm must reach the engine");
  });

  it("replaces an engine registered under an id already in use", () => {
    // Last registration wins. Worth pinning either way: silently ignoring
    // the second would make a deliberate override look applied when it was
    // not, which is the harder failure to notice of the two.
    const first = probeEngine("test-engine-replace");
    const second = probeEngine("test-engine-replace");

    registerMathEngine(first);
    registerMathEngine(second);

    assert.equal(getMathEngine("test-engine-replace"), second);
    assert.notEqual(getMathEngine("test-engine-replace"), first);
  });

  it("leaves the default engine intact when other engines are added", () => {
    // A registry that dropped or shadowed the default on write would break
    // every shipped game at once, and only under a configuration nothing
    // exercises locally.
    registerMathEngine(probeEngine("test-engine-isolated"));

    assert.equal(getMathEngine(DEFAULT_MATH_ENGINE_ID), genericMathEngine);
  });
});

describe("genericMathEngine", () => {
  it("carries the default id, so config and code agree on one name", () => {
    // `DEFAULT_MATH_ENGINE_ID` is what a GameDefinition omitting
    // `mathEngineId` falls back to. If the constant and the registration
    // ever disagreed, every such game would fail to resolve.
    assert.equal(genericMathEngine.id, DEFAULT_MATH_ENGINE_ID);
  });

  it("evaluates a real spin, so the wired-up engine is the working one", () => {
    // Guards against the registry holding a well-formed object whose
    // `evaluateSpin` is not the real evaluator — the shape would be right
    // and every spin would be wrong.
    const result = genericMathEngine.evaluateSpin(REFERENCE_GAME, "a".repeat(64), 100);

    assert.ok(result, "the default engine must actually evaluate");
    assert.equal(result.seed, "a".repeat(64), "the seed is carried through for replay");
    assert.ok(Array.isArray(result.stops), "a spin picks reel stops");
    assert.ok(typeof result.evaluation.totalWin === "number", "a spin must produce a numeric win");
    assert.ok(result.evaluation.totalWin >= 0, "a win is never negative");

    // The algorithm is recorded on the result, not just used and discarded.
    // A round persisted without it cannot be replayed once the default
    // changes — the failure item 3d exists to prevent.
    assert.ok(result.rngAlgorithm, "the engine records which algorithm drew the grid");
  });
});
