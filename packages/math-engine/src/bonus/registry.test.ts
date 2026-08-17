import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSeed } from "@slots-engine/rng";
import {
  deriveStepRng,
  getBonusModule,
  listBonusModuleSchemas,
  listBonusModules,
  registerBonusModule,
} from "./registry.js";
import type { BonusModule, BonusStepOutput } from "./types.js";

/**
 * The bonus-module registry: the swap point for "which bonus round is this".
 *
 * `bonus.test.ts` covers the two shipped modules and `deriveStepRng`'s
 * determinism. What it never touches is the registry's own two write-side
 * functions — `registerBonusModule` and `listBonusModules` were exported and
 * asserted **nowhere**, found by checking every exported symbol in the
 * package against whether any test names it.
 *
 * They are small, and they are on the money path for the same reason
 * `registerMathEngine` is (see `../registry.test.ts`): a module keyed under
 * the wrong id means a bonus paid out under mathematics the game did not ask
 * for, while looking entirely successful. The wheel's payouts credited to a
 * pick round is not a crash — it is a wrong number that nothing flags.
 *
 * ## Registry state is global, and these tests share it
 *
 * `registerBonusModule` writes into a module-level `Map` that lives for the
 * process. So every test here registers under an id unique to itself, and
 * none of them re-registers `wheel` or `pick` — a test that clobbered a real
 * module would corrupt every other file in the run, and the failure would
 * surface somewhere else entirely.
 *
 * There is deliberately no `unregister` in the production API: nothing in the
 * running system removes a module, and adding a function only tests use would
 * widen the surface for no gain. Same call as the math-engine registry.
 *
 * ## What these cannot establish
 *
 * That either shipped module computes a correct payout — `bonus.test.ts`
 * owns that, including the RTP bands. These prove only that the right module
 * is handed back, or that none is.
 */

/** A stand-in module that records what it was handed, so "returns the module
 * that was registered" can be asserted rather than assumed. */
function stubModule(moduleId: string): BonusModule & { starts: number } {
  const out: BonusStepOutput = { state: {}, done: true, totalWin: 0, view: {} };
  return {
    moduleId,
    starts: 0,
    start() {
      (this as unknown as { starts: number }).starts++;
      return out;
    },
    step() {
      return out;
    },
  };
}

describe("registerBonusModule", () => {
  it("keys a module under its OWN moduleId, not under a fixed one", () => {
    // The mutation this exists for. Keying every module under the same
    // constant — or under the first registered id — means the second
    // registration silently replaces the first, and a game asking for a
    // wheel gets a pick's payouts. `registerMathEngine` had exactly this
    // failure available to it, which is why that registry is tested too.
    const a = stubModule("test-registry-a");
    const b = stubModule("test-registry-b");
    registerBonusModule(a);
    registerBonusModule(b);

    assert.equal(getBonusModule("test-registry-a").moduleId, "test-registry-a");
    assert.equal(getBonusModule("test-registry-b").moduleId, "test-registry-b");
    // Identity, not just the id field: a registry that stored the id but
    // returned the wrong object would pass the two assertions above.
    assert.equal(getBonusModule("test-registry-a"), a);
    assert.equal(getBonusModule("test-registry-b"), b);
  });

  it("hands back the same object that was registered, not a copy", () => {
    // A module carries `start`, `step` and optionally
    // `expectedReturnMultiplier`. A registry that spread the object would
    // drop nothing visible here but would break `this`-bound state and any
    // non-enumerable property — so identity is the contract, and it is
    // cheap to pin.
    const module = stubModule("test-registry-identity");
    registerBonusModule(module);

    const got = getBonusModule("test-registry-identity");
    got.start({ totalBet: 100, state: {}, params: {}, rng: deriveStepRng(generateSeed(), 0) });

    assert.equal((got as typeof module).starts, 1, "the registered object itself must be invoked");
  });

  it("lets a later registration replace an earlier one under the same id", () => {
    // Deliberate rather than incidental: this is what makes the two
    // `registerBonusModule` calls at the bottom of registry.ts idempotent
    // if the module is ever imported twice. Pinned so a future change to
    // "refuse a duplicate id" is a decision someone makes on purpose,
    // having seen this test fail.
    const first = stubModule("test-registry-replace");
    const second = stubModule("test-registry-replace");
    registerBonusModule(first);
    registerBonusModule(second);

    assert.equal(getBonusModule("test-registry-replace"), second);
  });

  it("registers the two shipped modules at import time", () => {
    // registry.ts calls registerBonusModule(wheelModule) and
    // registerBonusModule(pickModule) as a side effect of being imported.
    // Nothing else does it, so if those calls were removed every bonus in
    // the system would fail at `getBonusModule` — loudly, but only at run
    // time. This is the test that says the side effect is the mechanism.
    assert.equal(getBonusModule("wheel").moduleId, "wheel");
    assert.equal(getBonusModule("pick").moduleId, "pick");
  });
});

describe("listBonusModules", () => {
  it("includes every registered id", () => {
    const module = stubModule("test-registry-listed");
    registerBonusModule(module);

    const listed = listBonusModules();
    assert.ok(listed.includes("test-registry-listed"));
    // The shipped pair must always be there — a list that reported only the
    // most recent registration, or only the test's, would pass a
    // `includes` check on its own.
    assert.ok(listed.includes("wheel"), "wheel must be listed");
    assert.ok(listed.includes("pick"), "pick must be listed");
  });

  it("reports ids, not module objects", () => {
    // The return type is `string[]`, and the obvious wrong implementation
    // (`[...modules.values()]`) still produces an array of the right length
    // — so a length assertion alone would not catch it.
    for (const entry of listBonusModules()) {
      assert.equal(typeof entry, "string", `expected an id string, got ${typeof entry}`);
    }
  });

  it("does not expose the registry's own map for mutation", () => {
    // `[...modules.keys()]` returns a fresh array. Returning the live keys
    // iterator, or the map itself, would let a caller edit the registry by
    // accident — the `toPublicUser` failure (F18) one package over, where
    // returning an internal array by reference made a privilege escalation
    // reachable through the function whose job was producing a safe copy.
    const before = listBonusModules();
    before.push("not-a-real-module");

    assert.ok(!listBonusModules().includes("not-a-real-module"), "the returned array must not alias registry state");
  });
});

describe("getBonusModule", () => {
  it("refuses an unknown id rather than falling back to a default", () => {
    // Already covered in bonus.test.ts; repeated here because it is the
    // reason this registry throws at all, and a reader of this file should
    // not have to go looking. A game referencing an unregistered module is
    // a deployment error, and paying the round out under a substituted
    // module would be worse than refusing.
    assert.throws(() => getBonusModule("no-such-module"), /no bonus module registered/);
  });

  it("names the registered ids in the error, so the failure is actionable", () => {
    // A deployment error that says only "not found" sends someone reading
    // source; one that lists what IS registered usually answers the
    // question on the spot — most often a typo or a module that was never
    // imported.
    try {
      getBonusModule("no-such-module");
      assert.fail("expected a throw");
    } catch (err) {
      assert.match((err as Error).message, /wheel/);
      assert.match((err as Error).message, /pick/);
    }
  });
});

describe("listBonusModuleSchemas", () => {
  /** Only the modules this repo ships. The registry is process-global and
   * the tests above register stubs into it, so "everything registered" is
   * a different set from "everything we ship". */
  const shippedSchemas = () =>
    listBonusModuleSchemas().filter((s) => ["wheel", "pick", "freeSpins"].includes(s.moduleId));

  /**
   * The backoffice builds its bonus parameter form from this.
   *
   * F24 was a **module** list kept in a second place; a **parameter** list
   * kept in a second place is the identical bug one level down, and it is
   * quieter — a form offering a field the module ignores, or omitting one it
   * depends on, fails nothing at publish time, because every module silently
   * substitutes a default for anything malformed. The game then pays out
   * under parameters nobody chose while looking entirely successful.
   *
   * These tests therefore assert the *contract* rather than the contents. A
   * test restating that `spinCount` defaults to 10 pins nothing — it passes
   * whatever the number is, and makes retuning the module harder.
   */
  it("describes every registered module, including any with no parameters", () => {
    // Omitting a schema-less module would make it unselectable in the
    // editor, which is F24 exactly. Absence must be an empty list, not a
    // missing entry.
    const ids = listBonusModuleSchemas().map((s) => s.moduleId);
    assert.deepEqual([...ids].sort(), [...listBonusModules()].sort());
  });

  it("gives every shipped module a non-empty schema", () => {
    /**
     * Not a requirement of the interface — `paramSchema` is optional, and
     * deliberately so — but a standard the three *shipped* modules are held
     * to, so that no designer meets a raw JSON blob for a module we wrote.
     *
     * Named explicitly rather than iterating everything registered, because
     * the registry is process-global and the tests above register stubs
     * into it. The first version of this test iterated the whole registry
     * and failed on `test-registry-a`, which is a fixture rather than a
     * gap — a reminder that "everything registered" and "everything we
     * ship" are different sets in a file that writes to the registry.
     */
    const shipped = ["wheel", "pick", "freeSpins"];
    const schemas = listBonusModuleSchemas();

    for (const moduleId of shipped) {
      const entry = schemas.find((s) => s.moduleId === moduleId);
      assert.ok(entry, `${moduleId} is not registered`);
      assert.ok(entry.params.length > 0, `${moduleId} ships without a parameter schema`);
    }
  });

  it("describes each parameter completely enough to render a field", () => {
    // A half-filled spec produces a form control with no label or no
    // default, which is worse than no form: it looks authoritative.
    for (const { moduleId, params } of shippedSchemas()) {
      for (const spec of params) {
        assert.ok(spec.key.length > 0, `${moduleId} has a spec with no key`);
        assert.ok(spec.label.length > 0, `${moduleId}.${spec.key} has no label`);
        assert.ok(spec.help.length > 0, `${moduleId}.${spec.key} has no help text`);
        assert.ok(
          ["number", "integer", "numberList"].includes(spec.type),
          `${moduleId}.${spec.key} has an unrenderable type ${spec.type}`,
        );
        assert.ok(spec.defaultValue !== undefined, `${moduleId}.${spec.key} has no default`);
      }
    }
  });

  it("declares a default that satisfies the parameter's own bounds", () => {
    // The default is what the module substitutes for a malformed value, so
    // a default outside the advertised range would mean the form warns
    // about a value the module itself uses.
    for (const { moduleId, params } of shippedSchemas()) {
      for (const spec of params) {
        const values = Array.isArray(spec.defaultValue) ? spec.defaultValue : [spec.defaultValue];
        for (const value of values) {
          if (spec.min !== undefined) {
            assert.ok(value >= spec.min, `${moduleId}.${spec.key} defaults to ${value}, below its own min ${spec.min}`);
          }
          if (spec.max !== undefined) {
            assert.ok(value <= spec.max, `${moduleId}.${spec.key} defaults to ${value}, above its own max ${spec.max}`);
          }
        }
      }
    }
  });

  it("uses each key only once per module", () => {
    // A duplicate key renders two fields writing the same value, where the
    // one the designer did not edit silently wins.
    for (const { moduleId, params } of shippedSchemas()) {
      const keys = params.map((p) => p.key);
      assert.equal(new Set(keys).size, keys.length, `${moduleId} declares a duplicate parameter key`);
    }
  });

  it("returns copies, so a caller cannot edit the registry in place", () => {
    // F18's shape: handing back internal state from the function whose job
    // is producing a safe view is how a read turns into a write.
    const first = listBonusModuleSchemas();
    const spec = first[0].params[0];
    spec.label = "mutated";
    first[0].params.push({ ...spec, key: "injected" });

    const second = listBonusModuleSchemas();
    assert.notEqual(second[0].params[0].label, "mutated", "a caller edited a spec through the returned array");
    assert.ok(!second[0].params.some((p) => p.key === "injected"), "a caller added a parameter to the registry");
  });

  it("names freeSpins' parameters, the module F24 left unreachable", () => {
    // The one concrete assertion, and it earns its place: F24 made this
    // module selectable and stopped, leaving five parameters documented
    // only in its source. Naming them here means removing one from the
    // schema fails rather than quietly returning the editor to a blob.
    const freeSpins = listBonusModuleSchemas().find((s) => s.moduleId === "freeSpins");
    assert.ok(freeSpins, "freeSpins is not registered");
    assert.deepEqual(
      [...freeSpins.params.map((p) => p.key)].sort(),
      ["assumedBaseRtp", "maxRetriggers", "retriggerSpins", "spinCount", "winMultiplier"],
    );
  });
});
