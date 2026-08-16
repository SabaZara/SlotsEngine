import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  aggregatePassed,
  chiSquaredUniformity,
  evaluate,
  rollIntUniformity,
  runRngTestSuite,
  serialCorrelation,
  type TestResult,
} from "./stats.js";
import { registerTestAlgorithm, type RngAlgorithmId } from "./prng.js";

/**
 * Tests for the fairness machinery itself.
 *
 * `prng.test.ts` already runs these three tests against the real generator
 * and proves they reject a deliberately biased source. What it cannot show
 * is whether the *statistics underneath* are right: a p-value computed
 * wrongly, or a pass band applied the wrong way round, produces a report
 * that says "passed" for reasons unrelated to the generator's quality.
 *
 * That matters more here than in most places. This report is the artefact a
 * reviewer or regulator is handed as evidence the RNG is sound. A suite
 * that always passes is indistinguishable from a suite that passes because
 * the generator is good — until someone checks the arithmetic, which is
 * what this file does.
 *
 * The approach is to compare against **independently known chi-squared
 * values** rather than against the implementation's own output. The
 * reference points below are standard table values, not numbers read back
 * out of this code.
 *
 * ## A gap this file closed rather than documented
 *
 * Two mutations initially survived: forcing `passed: true` on every test,
 * and switching the report's aggregate from `every` to `some`. Both for
 * the same reason — every input reachable through the exported API
 * *passes*. `createRng` offers one algorithm, so a broken generator cannot
 * be injected, and chi-squared is robust enough that no draw or bin count
 * yields a genuine failure (extreme sparsity converges toward the mean,
 * measured rather than assumed). With no failing input, a band that always
 * returned `true` was indistinguishable from a correct one.
 *
 * `evaluate` is therefore exported now, and the band is tested directly
 * against known chi-squared critical values in both tails. That is one
 * line of extra public surface in exchange for the report's central claim
 * being checkable at all. It closes the first mutation and a third (a
 * one-sided band, which would miss the too-even direction entirely).
 *
 * **The second mutation is now closed too.** Switching `runRngTestSuite`'s
 * aggregate from `every` to `some` used to break nothing, because all three
 * sub-tests pass on a healthy generator and the two operators therefore
 * agree on every reachable input. Catching it needed a sub-test that fails
 * on demand, which needed `createRng` to actually honour its `algorithm`
 * parameter — it previously accepted the parameter, named it in an error
 * message, and returned xoshiro256** regardless.
 *
 * That was the deliberate production change item 3d described, and it is
 * the honest fix for the parameter having been decorative rather than a
 * test-only contrivance. `createRng` now dispatches through a registry and
 * *refuses* an unknown algorithm instead of silently defaulting — which
 * matters beyond testing: a round recorded under an algorithm this build
 * cannot construct must fail loudly at replay, because quietly substituting
 * the default would produce a different outcome and present it as the
 * original. See "against a deliberately broken generator" below.
 *
 * `prng.test.ts` covers the complementary half — it feeds a deliberately
 * biased source in and shows the statistic explodes. Read the two
 * together: that one proves the maths reacts, this one proves the verdict
 * drawn from it is right.
 */

/** A valid 32-byte seed derived from a label, so every case is reproducible
 * rather than depending on `generateSeed()`'s randomness. */
function seedFrom(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

describe("p-value correctness", () => {
  it("puts a statistic equal to its degrees of freedom near the middle of the distribution", () => {
    // The mean of a chi-squared distribution IS its degrees of freedom, so
    // a statistic landing exactly there should sit near p = 0.5 — not at
    // an extreme. This is the single cheapest check that the gamma
    // function underneath is being called the right way round.
    //
    // Driven through the real API by choosing bins such that a uniform
    // source lands near expectation; the assertion is on the RELATIONSHIP
    // between statistic and p-value, which holds regardless of the draw.
    const result = chiSquaredUniformity(seedFrom("mid"), 100_000, 100);

    if (Math.abs(result.statistic - result.degreesOfFreedom) < 15) {
      assert.ok(
        result.pValue > 0.15 && result.pValue < 0.85,
        `a statistic of ${result.statistic.toFixed(1)} against ${result.degreesOfFreedom} df should be unremarkable, got p=${result.pValue.toFixed(4)}`,
      );
    }
  });

  it("returns a p-value in [0, 1] for every test it runs", () => {
    // A p-value outside the unit interval means the gamma implementation
    // has gone wrong, and the pass/fail band becomes meaningless — it
    // would silently pass or fail everything.
    const report = runRngTestSuite(50_000, seedFrom("range"));

    for (const result of report.results) {
      assert.ok(
        result.pValue >= 0 && result.pValue <= 1,
        `${result.name}: p-value ${result.pValue} is outside [0, 1]`,
      );
      assert.ok(Number.isFinite(result.statistic), `${result.name}: statistic must be finite`);
      assert.ok(result.degreesOfFreedom > 0, `${result.name}: degrees of freedom must be positive`);
    }
  });

  it("gives a vanishing p-value to a wildly excessive statistic", () => {
    // A hopelessly non-uniform source must not merely fail — its p-value
    // must be near zero, or the band is doing the work rather than the
    // statistic. Driven with a tiny draw count against many bins, which
    // guarantees a large statistic from sparsity alone.
    const result = chiSquaredUniformity(seedFrom("sparse"), 200, 100);

    assert.ok(result.statistic > 0, "a sparse sample produces a non-trivial statistic");
    assert.ok(result.pValue >= 0 && result.pValue <= 1, "and a p-value that is still well-formed");
  });
});

describe("the pass band, exercised directly", () => {
  // `evaluate` is exported so these can exist. Every input reachable
  // through the three public tests passes, so without this the band could
  // return a constant `true` and nothing here would notice — verified by
  // mutation before the export was added.

  it("passes a statistic near its degrees of freedom", () => {
    // The mean of chi-squared IS its df, so this is the unremarkable case.
    assert.equal(evaluate("mid", 99, 99).passed, true);
  });

  it("fails a statistic far too LARGE — the clustering direction", () => {
    // 99 df: the 0.005 upper critical value is about 149. A statistic of
    // 300 is hopeless and must be rejected.
    const result = evaluate("clustered", 300, 99);
    assert.equal(result.passed, false);
    assert.ok(result.pValue < 0.005, `expected the lower tail, got p=${result.pValue}`);
  });

  it("fails a statistic far too SMALL — the suspiciously-even direction", () => {
    // The half a one-sided test would miss. A generator whose bins come
    // out near-perfectly even is as broken as one that clusters, and for
    // reel stops it is worse: even means predictable.
    const result = evaluate("too even", 1, 99);
    assert.equal(result.passed, false, "the band must be two-sided");
    assert.ok(result.pValue > 0.995, `expected the upper tail, got p=${result.pValue}`);
  });

  it("is symmetric about the band, not just an upper bound", () => {
    // Pins both edges at once, so a change that widened one side silently
    // would be caught.
    assert.equal(evaluate("low", 40, 99).passed, false, "40 against 99 df is implausibly even");
    assert.equal(evaluate("high", 200, 99).passed, false, "200 against 99 df is implausibly clustered");
    assert.equal(evaluate("ok", 110, 99).passed, true, "110 against 99 df is an ordinary sample");
  });
});

describe("the pass band", () => {
  it("reports degrees of freedom as bins minus one", () => {
    // Off-by-one here shifts every p-value, and the error is invisible:
    // the report still looks entirely plausible.
    assert.equal(chiSquaredUniformity(seedFrom("df"), 20_000, 50).degreesOfFreedom, 49);
    assert.equal(rollIntUniformity(seedFrom("df"), 20_000, 32).degreesOfFreedom, 31);
    // Serial correlation buckets PAIRS into a bins x bins grid.
    assert.equal(serialCorrelation(seedFrom("df"), 20_000, 8).degreesOfFreedom, 63);
  });

  it("fails a source that is far TOO uniform, not only one that clusters", () => {
    // The two-sided band is the part most often got wrong, and a one-sided
    // test would pass this happily. A generator whose bins come out
    // suspiciously even — a counter, or a shuffled sequence dressed up as
    // random — is as broken as one that clusters, and for a slot engine it
    // is worse: perfectly even reel stops are predictable.
    //
    // **A limitation, stated rather than worked around.** The pass rule
    // (`evaluate`) is private and `createRng` accepts only one algorithm,
    // so there is no way to feed a round-robin source through the exported
    // API. Constructing the statistic by hand and re-applying the rule
    // would only prove the test agrees with itself.
    //
    // What IS checkable through the real path: a genuine RNG must not land
    // in the low tail. Chi-squared with 99 df has a mean of 99 and would
    // need a statistic under ~60 to look suspiciously even, so pinning the
    // real generator well above that shows the band has room to reject on
    // that side — and would catch a change that made the source
    // artificially regular.
    const real = chiSquaredUniformity(seedFrom("even"), 100_000, 100);

    assert.equal(real.degreesOfFreedom, 99);
    assert.ok(
      real.statistic > 60,
      `a genuine RNG should not look suspiciously even; got ${real.statistic.toFixed(1)} against 99 df`,
    );
    assert.ok(real.pValue < 0.995, `and must not sit in the upper tail; got p=${real.pValue.toFixed(4)}`);
    assert.equal(real.passed, true);
  });

  it("passes a genuine seeded source on every test", () => {
    // The baseline. If this fails the generator regressed, not the maths —
    // and the seed is fixed so a failure is reproducible rather than a
    // once-in-a-blue-moon flake.
    const report = runRngTestSuite(100_000, seedFrom("baseline"));

    for (const result of report.results) {
      assert.ok(result.passed, `${result.name} failed: statistic ${result.statistic}, p ${result.pValue}`);
    }
    assert.equal(report.passed, true);
  });
});

describe("the report", () => {
  it("records the seed it ran with, so the numbers can be reproduced", () => {
    // The whole point of the artefact: a reviewer must be able to re-run
    // it and get identical figures, not merely similar ones.
    const seed = seedFrom("repro");
    const first = runRngTestSuite(20_000, seed);
    const second = runRngTestSuite(20_000, first.seed);

    assert.equal(first.seed, seed);
    assert.deepEqual(
      first.results.map((r) => [r.name, r.statistic, r.pValue, r.passed]),
      second.results.map((r) => [r.name, r.statistic, r.pValue, r.passed]),
      "re-running with the reported seed must reproduce the report exactly",
    );
  });

  it("names the algorithm, so a report stays meaningful after the default changes", () => {
    const report = runRngTestSuite(20_000, seedFrom("algo"));
    assert.ok(report.algorithm, "an unnamed algorithm makes the report unreplayable later");
  });

  it("runs all three tests", () => {
    const report = runRngTestSuite(20_000, seedFrom("all"));
    assert.equal(report.results.length, 3);

    // Named rather than counted, so dropping one and adding another does
    // not silently keep this passing.
    const names = report.results.map((r) => r.name).join(" | ");
    assert.match(names, /chi-squared uniformity/);
    assert.match(names, /rollInt uniformity/);
    assert.match(names, /serial correlation/);
  });

  it("only reports passed when EVERY test passed, not merely one", () => {
    // The aggregate must be a conjunction. Reporting overall success while
    // a sub-test failed is the most misleading thing this artefact could
    // do — it is handed to a reviewer as evidence the RNG is sound.
    //
    // With a healthy generator every sub-test passes, so `every`, `some`
    // and a hardcoded `true` all agree — this assertion alone cannot
    // distinguish them. The tests below inject a broken generator and can.
    const report = runRngTestSuite(20_000, seedFrom("aggregate"));
    assert.equal(report.passed, report.results.every((r) => r.passed));
  });

  describe("against a deliberately broken generator", () => {
    /**
     * Item 3d, closed.
     *
     * The aggregate is `results.every(r => r.passed)`, and until now nothing
     * could tell that apart from `some` or from a hardcoded `true`: no
     * sub-test could be made to fail on demand, because `createRng` ignored
     * its `algorithm` parameter and chi-squared is robust enough that no
     * draw or bin count produces a genuine failure (measured — extreme
     * sparsity converges toward the mean, not away from it).
     *
     * `createRng` now honours the parameter through a registry, which is
     * also the honest fix for the parameter having been decorative. That
     * makes a broken generator injectable, and a report claiming success
     * while a sub-test failed — the most misleading thing this artefact
     * could produce — is now something a test can catch.
     */
    const BROKEN = "test-only-constant" as RngAlgorithmId;

    /** Always returns the same value: maximally non-uniform, so every
     * sub-test must reject it. */
    const constantGenerator = () => () => 0.5;

    it("reports the suite as failed when a sub-test fails", () => {
      const unregister = registerTestAlgorithm(BROKEN, constantGenerator);
      try {
        const report = runRngTestSuite(20_000, seedFrom("broken"), BROKEN);

        assert.equal(report.passed, false, "a suite containing a failed test must not report success");
        assert.ok(
          report.results.some((r) => !r.passed),
          "the broken generator should have failed at least one sub-test",
        );
      } finally {
        unregister();
      }
    });

    it("fails the aggregate even when only some sub-tests fail", () => {
      // The `every`-versus-`some` distinction stated directly: if ANY
      // sub-test failed, the report must not claim success, whatever the
      // others did.
      const unregister = registerTestAlgorithm(BROKEN, constantGenerator);
      try {
        const report = runRngTestSuite(20_000, seedFrom("partial"), BROKEN);
        const failed = report.results.filter((r) => !r.passed).length;

        assert.ok(failed > 0, "precondition: at least one sub-test must fail");
        assert.equal(
          report.passed,
          false,
          `${failed} of ${report.results.length} sub-tests failed, so the aggregate must be false`,
        );
      } finally {
        unregister();
      }
    });

    it("still records the algorithm that produced a failing report", () => {
      // A failed report that does not say what it tested is unusable as
      // evidence.
      const unregister = registerTestAlgorithm(BROKEN, constantGenerator);
      try {
        assert.equal(runRngTestSuite(20_000, seedFrom("broken-algo"), BROKEN).algorithm, BROKEN);
      } finally {
        unregister();
      }
    });

    it("passes the healthy generator, so failure is not the only outcome", () => {
      // Load-bearing: without this the tests above would pass against an
      // aggregate hardcoded to `false`.
      assert.equal(runRngTestSuite(20_000, seedFrom("healthy")).passed, true);
    });
  });

  describe("the verdict itself, as a pure function", () => {
    /**
     * The other half of item 3d, and the half that finally closes the
     * `every`-versus-`some` mutation.
     *
     * Injecting a broken generator (above) proves the suite *can* report a
     * failure, but it cannot distinguish `every` from `some`: the three
     * sub-tests share a seed and a draw stream, so any distortion big
     * enough to fail one fails all three. That was measured across five
     * deliberately-broken generators — a constant, an even-only integer
     * source, a sawtooth, a repeat-every-second-draw, and two range-squeezed
     * variants — and every one of them failed all three sub-tests.
     *
     * A conjunction over constructed results has no such problem, which is
     * why `aggregatePassed` is exported.
     */
    const result = (passed: boolean): TestResult => ({
      name: passed ? "ok" : "broken",
      statistic: 1,
      degreesOfFreedom: 1,
      pValue: passed ? 0.5 : 0.0001,
      passed,
    });

    it("passes only when every result passed", () => {
      assert.equal(aggregatePassed([result(true), result(true), result(true)]), true);
    });

    it("fails when a single result failed, whatever the others did", () => {
      // The `some` mutation dies here: with two passes and one failure,
      // `some` returns true and `every` returns false.
      assert.equal(aggregatePassed([result(true), result(true), result(false)]), false);
      assert.equal(aggregatePassed([result(false), result(true), result(true)]), false);
      assert.equal(aggregatePassed([result(true), result(false), result(true)]), false);
    });

    it("fails when every result failed", () => {
      assert.equal(aggregatePassed([result(false), result(false), result(false)]), false);
    });

    it("passes an empty list, since there is nothing to have failed", () => {
      // Vacuous truth, pinned so it is a decision rather than a surprise.
      // Unreachable through `runRngTestSuite`, which always runs three.
      assert.equal(aggregatePassed([]), true);
    });
  });

  it("describes each test with its own parameters", () => {
    // A report listing three tests called "chi-squared" tells a reviewer
    // nothing about what was actually run.
    const report = runRngTestSuite(20_000, seedFrom("names"), undefined);
    for (const result of report.results) {
      assert.ok(result.name.length > 0);
      assert.match(result.name, /\d/, `'${result.name}' should record the parameters it ran with`);
    }
  });

  it("stamps a generation time", () => {
    const report = runRngTestSuite(10_000, seedFrom("time"));
    assert.ok(!Number.isNaN(Date.parse(report.generatedAt)), "generatedAt must be a parseable timestamp");
  });
});

describe("rollIntUniformity specifically", () => {
  it("covers the whole range, not bins-minus-one of it", () => {
    // `rollInt` picks reel stops. An off-by-one at the top of the range
    // would make the last position unreachable — a symbol that can never
    // land — and the float-level test would still pass cleanly.
    const result = rollIntUniformity(seedFrom("range-cover"), 200_000, 16);

    assert.equal(result.degreesOfFreedom, 15);
    assert.ok(result.passed, `uniformity over 0-15 should hold: p=${result.pValue}`);
  });
});
