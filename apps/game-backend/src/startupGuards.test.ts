import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertStartupConfig } from "./startupGuards.js";

/**
 * What these tests cannot establish: that `main()` actually calls this
 * before it binds a port. The guard is verified here as a function; the
 * wiring that makes it a boot refusal is part of `index.ts`, which is
 * itself untested (TODO section A). A guard that works but is never called
 * would pass every test below.
 *
 * `assertStartupConfig` takes its environment as a parameter, so nothing
 * here mutates `process.env` — tests can run in any order and in parallel.
 */

/** A configuration that passes, so each test can break exactly one thing. */
const valid = (): NodeJS.ProcessEnv => ({
  MONGO_URI: "mongodb://localhost:27017/slots",
  SERVICE_AUTH_SECRET: "s".repeat(32),
  LAUNCH_TOKEN_SECRET: "l".repeat(32),
});

/**
 * The refusal message for an environment that must be refused. Fails the
 * test if the guard accepts it — `assert.throws` returns nothing, so the
 * message has to be caught to be asserted on.
 */
function refusalFor(env: NodeJS.ProcessEnv): string {
  try {
    assertStartupConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("expected the guard to refuse this environment, but it started");
}

describe("assertStartupConfig", () => {
  it("accepts a fully configured environment", () => {
    // Load-bearing: without this, every refusal test below would pass
    // against a guard that simply throws on everything.
    assert.doesNotThrow(() => assertStartupConfig(valid()));
  });

  it("refuses to start with no MONGO_URI", () => {
    assert.throws(() => assertStartupConfig({ ...valid(), MONGO_URI: undefined }), /MONGO_URI/);
  });

  it("refuses to start with no SERVICE_AUTH_SECRET, rather than leaving internal routes open", () => {
    assert.throws(
      () => assertStartupConfig({ ...valid(), SERVICE_AUTH_SECRET: undefined }),
      /SERVICE_AUTH_SECRET/,
    );
  });

  it("refuses a SERVICE_AUTH_SECRET one character below the floor", () => {
    // At the boundary rather than with something obviously tiny: an
    // off-by-one in the length check is the realistic bug, and a 4-character
    // secret would not catch `<` written as `<=`.
    assert.throws(
      () => assertStartupConfig({ ...valid(), SERVICE_AUTH_SECRET: "s".repeat(31) }),
      /SERVICE_AUTH_SECRET/,
    );
    assert.doesNotThrow(() => assertStartupConfig({ ...valid(), SERVICE_AUTH_SECRET: "s".repeat(32) }));
  });

  it("refuses to start with no LAUNCH_TOKEN_SECRET", () => {
    assert.throws(
      () => assertStartupConfig({ ...valid(), LAUNCH_TOKEN_SECRET: undefined }),
      /LAUNCH_TOKEN_SECRET/,
    );
  });

  it("refuses a LAUNCH_TOKEN_SECRET one character below the floor", () => {
    assert.throws(
      () => assertStartupConfig({ ...valid(), LAUNCH_TOKEN_SECRET: "l".repeat(31) }),
      /LAUNCH_TOKEN_SECRET/,
    );
    assert.doesNotThrow(() => assertStartupConfig({ ...valid(), LAUNCH_TOKEN_SECRET: "l".repeat(32) }));
  });

  it("refuses an empty secret specifically, since a falsy check and a length check can diverge", () => {
    assert.throws(() => assertStartupConfig({ ...valid(), SERVICE_AUTH_SECRET: "" }), /SERVICE_AUTH_SECRET/);
    assert.throws(() => assertStartupConfig({ ...valid(), LAUNCH_TOKEN_SECRET: "" }), /LAUNCH_TOKEN_SECRET/);
  });

  it("reports every problem at once, not just the first", () => {
    // A guard that throws on the first fault makes fixing a fresh
    // deployment an N-restart game. The message should name all of them.
    const message = refusalFor({});
    assert.match(message, /MONGO_URI/);
    assert.match(message, /SERVICE_AUTH_SECRET/);
    assert.match(message, /LAUNCH_TOKEN_SECRET/);
  });

  it("names the service in the refusal, so a compose log says which container died", () => {
    assert.match(refusalFor({}), /game-backend refusing to start/);
  });

  describe("production-only guards", () => {
    it("refuses two secrets that are the same value", () => {
      // Sharing one secret means a launch token is a valid service
      // credential: a player-supplied value signing internal routes.
      const shared = "x".repeat(32);
      assert.throws(
        () =>
          assertStartupConfig({
            ...valid(),
            NODE_ENV: "production",
            SERVICE_AUTH_SECRET: shared,
            LAUNCH_TOKEN_SECRET: shared,
          }),
        /must be different secrets/,
      );
    });

    it("allows two secrets that are the same value outside production", () => {
      // Deliberate: local compose files reuse one value, and a guard that
      // blocked development would be turned off rather than satisfied.
      const shared = "x".repeat(32);
      assert.doesNotThrow(() =>
        assertStartupConfig({
          ...valid(),
          NODE_ENV: "development",
          SERVICE_AUTH_SECRET: shared,
          LAUNCH_TOKEN_SECRET: shared,
        }),
      );
    });

    it("refuses INITIAL_PLAYER_BALANCE in production, because it grants every new player free money", () => {
      assert.throws(
        () =>
          assertStartupConfig({ ...valid(), NODE_ENV: "production", INITIAL_PLAYER_BALANCE: "100000" }),
        /INITIAL_PLAYER_BALANCE/,
      );
    });

    it("allows INITIAL_PLAYER_BALANCE=0 in production, which grants nothing", () => {
      // The check is on the value, not on the variable being present. An
      // explicit zero is the correct production setting, and refusing it
      // would push operators toward unsetting it instead — which is worse,
      // since the ledger's own default is 100_000.
      assert.doesNotThrow(() =>
        assertStartupConfig({ ...valid(), NODE_ENV: "production", INITIAL_PLAYER_BALANCE: "0" }),
      );
    });

    it("allows INITIAL_PLAYER_BALANCE outside production", () => {
      assert.doesNotThrow(() =>
        assertStartupConfig({
          ...valid(),
          NODE_ENV: "development",
          INITIAL_PLAYER_BALANCE: "100000",
        }),
      );
    });

    it("does not apply the production guards under a NODE_ENV that merely looks like production", () => {
      // The check is `=== "production"`. Pinned so that loosening it to a
      // prefix or substring match is a visible decision rather than a
      // quiet one.
      const shared = "x".repeat(32);
      assert.doesNotThrow(() =>
        assertStartupConfig({
          ...valid(),
          NODE_ENV: "production-eu",
          SERVICE_AUTH_SECRET: shared,
          LAUNCH_TOKEN_SECRET: shared,
        }),
      );
    });
  });
});
