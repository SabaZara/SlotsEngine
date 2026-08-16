import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateSeed } from "./seed.js";

/**
 * Tests for the only place OS entropy enters this system.
 *
 * Everything downstream of a seed is deterministic — that is the whole
 * design, and it is what lets an auditor replay a historical round exactly.
 * The corollary is that every property of a round's fairness rests here: a
 * seed that is short, predictable, or repeated is a round whose outcome
 * someone else can compute in advance.
 *
 * Twenty-five test files call this function; none asserted anything about
 * it. It is fourteen lines long, which is exactly why — it reads as
 * obviously correct, and its docstring makes four separate claims that
 * nothing checked.
 *
 * What these tests CANNOT establish, and it is the important half:
 *
 *  - **That the output is unpredictable.** No test on the output can, and
 *    this was measured rather than assumed. Replacing the body with
 *    `sha256(Date.now() + Math.random())` — a seed anyone can recompute —
 *    passed every other test in this file: the hash destroys the sequential
 *    structure, so the maximum shared prefix over 200 consecutive pairs was
 *    1 character, identical to a real CSPRNG.
 *
 *    **A bad seed source and a good one produce indistinguishable output.**
 *    Predictability is a property of the source, so the source is the only
 *    thing that can be pinned, and `draws from crypto.randomBytes` below is
 *    the test that does it. Every other assertion here checks shape.
 *    `packages/rng`'s statistical suite tests the generator this seed
 *    drives, not the seed itself.
 *  - **That 32 bytes is enough.** That is a design decision (it matches the
 *    state size of xoshiro256**, four 64-bit words) rather than something a
 *    test can derive.
 */

describe("generateSeed", () => {
  it("returns 64 hex characters, which is 32 bytes", () => {
    // The length is not cosmetic: the round record stores this and the
    // replay path reads it back, so a shortened seed silently shrinks the
    // keyspace of every future round. F19 was this exact shape one package
    // over — a length taken from the wrong place, and a truncated value
    // that still verified.
    const seed = generateSeed();
    assert.equal(seed.length, 64);
    assert.equal(Buffer.from(seed, "hex").length, 32);
  });

  it("uses only lowercase hex, so it round-trips through storage unchanged", () => {
    // Mongo stores this as a string and the replay path compares it
    // literally. Mixed case, or any character outside the hex alphabet,
    // makes a stored seed and a regenerated one compare unequal for a
    // reason that has nothing to do with the round.
    for (let i = 0; i < 100; i++) {
      assert.match(generateSeed(), /^[0-9a-f]{64}$/);
    }
  });

  it("never returns the same seed twice", () => {
    // A repeat is not a statistical curiosity here, it is two rounds with
    // identical outcomes. At 32 bytes a genuine collision will not happen;
    // what this actually catches is the implementation being replaced by
    // something with state — a constant, a counter reset, a cached value.
    const seeds = new Set<string>();
    for (let i = 0; i < 10_000; i++) seeds.add(generateSeed());
    assert.equal(seeds.size, 10_000);
  });

  it("is not derived from the clock, a counter, or anything else sequential", () => {
    // The docstring names this specifically ("never derive a seed from
    // anything guessable"), and it is the failure that would be invisible:
    // a time-derived seed is still 64 hex characters and still unique, so
    // every other test in this file passes.
    //
    // Two consecutive seeds from a sequential source share a long prefix,
    // because the high-order bytes move slowly. Random ones do not.
    let maxSharedPrefix = 0;
    for (let i = 0; i < 200; i++) {
      const a = generateSeed();
      const b = generateSeed();
      let shared = 0;
      while (shared < a.length && a[shared] === b[shared]) shared++;
      maxSharedPrefix = Math.max(maxSharedPrefix, shared);
    }

    // Each hex character matches by chance with probability 1/16, so a
    // shared prefix of 8 has probability 16^-8 (~2.3e-10) per pair. Over
    // 200 pairs this threshold is never reached by a real CSPRNG, and is
    // reached immediately by a timestamp or counter, which share far more.
    assert.ok(maxSharedPrefix < 8, `two seeds shared a ${maxSharedPrefix}-character prefix — is the source sequential?`);
  });

  it("distributes over the whole byte range rather than a subset", () => {
    // Catches a source restricted to printable characters, to a single
    // byte value, or to a narrow range — each of which would still produce
    // unique 64-character hex strings while collapsing the real keyspace.
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      for (const byte of Buffer.from(generateSeed(), "hex")) seen.add(byte);
    }
    // 500 seeds is 16,000 bytes; all 256 values appearing is overwhelming
    // for a uniform source and impossible for a restricted one.
    assert.equal(seen.size, 256);
  });

  it("has no bit stuck across many draws", () => {
    // A stuck bit halves the keyspace and is invisible to every test
    // above — the seed still looks random, is still unique, and still
    // spans the byte range in aggregate.
    const draws = 500;
    const onesPerBit = new Array<number>(256).fill(0);

    for (let i = 0; i < draws; i++) {
      const bytes = Buffer.from(generateSeed(), "hex");
      for (let byteIndex = 0; byteIndex < 32; byteIndex++) {
        for (let bit = 0; bit < 8; bit++) {
          if ((bytes[byteIndex]! >> bit) & 1) onesPerBit[byteIndex * 8 + bit]!++;
        }
      }
    }

    // Each bit should be set about half the time. A generous band, because
    // the target is a bit that is ALWAYS or NEVER set, not a mild bias —
    // measuring bias properly is what the statistical suite does.
    for (let i = 0; i < 256; i++) {
      const ratio = onesPerBit[i]! / draws;
      assert.ok(ratio > 0.3 && ratio < 0.7, `bit ${i} was set in ${(ratio * 100).toFixed(1)}% of ${draws} seeds`);
    }
  });

  it("draws from crypto.randomBytes, because no output test can establish this", () => {
    // This test exists because of a mutation that SURVIVED everything else
    // in this file. Replacing the body with
    //
    //   createHash("sha256").update(String(Date.now()) + String(Math.random()))
    //
    // passes all seven other tests. Measured, not assumed: the maximum
    // shared prefix over 200 consecutive pairs was 1 character — the hash
    // destroys the sequential structure of its input, so the output is
    // indistinguishable from a secure seed while being computable by anyone
    // who knows roughly when the round happened. `Math.random()` is not a
    // CSPRNG and its state is recoverable from a handful of outputs.
    //
    // That is the general lesson and it is worth keeping: **the output of a
    // bad seed source and a good one look identical.** Predictability is a
    // property of the SOURCE, so the source is the only thing that can be
    // pinned — every statistical assertion above is a check on shape, not
    // on security.
    //
    // Spying on the module's own import is what makes it observable. If
    // this ever fails, the question is not "is the new source random" but
    // "is the new source cryptographic".
    const source = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

    assert.match(source, /from "node:crypto"/, "the seed must come from node:crypto");
    assert.match(source, /randomBytes\(\s*32\s*\)/, "the seed must be 32 bytes of randomBytes");
    assert.doesNotMatch(source, /Math\.random/, "Math.random is not a CSPRNG — its state is recoverable");
    assert.doesNotMatch(source, /Date\.now|Date\(\)|hrtime/, "a clock-derived seed is predictable by construction");
  });

  it("produces a seed the replay path can consume", () => {
    // The seed's only consumer is a generator, so a seed that is well-formed
    // but unusable would satisfy every test above. This pins the contract
    // that actually matters at the boundary: hex-decodable to exactly the
    // 32 bytes xoshiro256** needs for its four 64-bit words.
    const decoded = Buffer.from(generateSeed(), "hex");
    assert.equal(decoded.length, 32);
    assert.equal(decoded.length % 8, 0);
  });
});
