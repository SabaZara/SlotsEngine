import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRateLimitStore } from "./index.js";

/**
 * The shared limiter store.
 *
 * Almost everything here is about the *absent* case, because that is the
 * one every local run and every single-instance deployment takes — and a
 * mistake in it is not a crash but a service that refuses to boot without a
 * Redis nobody asked for.
 *
 * The connection options are asserted on the constructed client rather than
 * by observing behaviour: they are a deliberate departure from ioredis's
 * defaults (20 retries, a 10s connect timeout), and the failure they
 * prevent — a slow Redis stalling every request behind twenty retries — is
 * not reproducible in a unit test without a slow Redis.
 *
 * What these cannot establish: that two instances actually share counters.
 * That needs two processes and a real Redis, and is covered by the
 * live-stack check recorded in docs/TODO.md.
 */

const opened: Array<{ close(): Promise<void> }> = [];

/** Every constructed client is closed, or the test process hangs on an open
 * handle after the last assertion passes — which reads as a hung suite
 * rather than as a leaked connection. */
after(async () => {
  for (const store of opened) await store.close().catch(() => {});
});

function build(url?: string) {
  const store = createRateLimitStore(url);
  if (store) opened.push(store);
  return store;
}

describe("when no Redis is configured", () => {
  it("returns nothing rather than throwing", () => {
    // The ordinary path. A single instance counting in its own memory is
    // correct, so an absent REDIS_URL is a supported configuration and not
    // an error — requiring Redis everywhere would mean a developer cannot
    // run a service without standing up another container.
    assert.equal(build(undefined), undefined);
  });

  it("treats an empty string as absent, not as a URL", () => {
    // `REDIS_URL=` in an env file is how a variable gets "unset" in
    // practice. Passing "" to ioredis would be a connection attempt to a
    // default host rather than the opt-out the author intended.
    assert.equal(build(""), undefined);
  });

  it("reads REDIS_URL from the environment when given no argument", () => {
    const previous = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      assert.equal(createRateLimitStore(), undefined);
    } finally {
      if (previous !== undefined) process.env.REDIS_URL = previous;
    }
  });
});

describe("when Redis is configured", () => {
  // A URL that parses but points nowhere. Nothing here connects — these
  // assertions are about how the client was constructed, and ioredis does
  // not require a reachable server to be built.
  const URL = "redis://127.0.0.1:63799";

  it("builds a client the limiter can use", () => {
    const store = build(URL);
    assert.ok(store, "a configured URL must produce a store");
    assert.ok(store.redis, "and the limiter needs the client on `redis`");
  });

  it("bounds retries and the connect timeout, rather than taking ioredis's defaults", () => {
    // The whole reason this is one shared module. ioredis defaults to 20
    // retries and a 10-second connect timeout, so a Redis that is merely
    // slow would stall every request behind the limiter check. A rate
    // limiter is a guard, not a dependency: it should fail fast and get out
    // of the way.
    const store = build(URL);
    const options = (store!.redis as unknown as { options: Record<string, unknown> }).options;

    assert.equal(options.maxRetriesPerRequest, 1);
    assert.equal(options.connectTimeout, 500);
  });

  it("keeps the offline queue, so a command issued before `ready` is not rejected", () => {
    // The first draft disabled it, and that was a real bug found by driving
    // a live Redis: ioredis connects asynchronously, so every command
    // between construction and `ready` is rejected with "Stream isn't
    // writeable". A service starts serving as soon as it boots, so the
    // first requests land in exactly that window — and `skipOnError`
    // swallows the rejection and counts in memory instead. Measured: with
    // it off, Redis ended a full rate-limit run holding zero keys, so the
    // limiter reported healthy while silently not being shared at all.
    //
    // Asserted as an explicit expectation rather than left to the default,
    // because "we did not set it" and "we decided not to set it" read the
    // same in code and only one of them survives a refactor.
    const store = build(URL);
    const options = (store!.redis as unknown as { options: Record<string, unknown> }).options;

    assert.notEqual(options.enableOfflineQueue, false, "disabling this makes the shared store silently inert");
  });

  it("caps reconnect backoff rather than letting it grow without bound", () => {
    const store = build(URL);
    const retry = (store!.redis as unknown as { options: { retryStrategy: (n: number) => number } }).options
      .retryStrategy;

    assert.equal(retry(1), 200, "an early attempt retries quickly");
    assert.equal(retry(50), 2_000, "a late one is capped, so a recovered Redis is picked up promptly");
  });

  it("swallows connection errors instead of crashing the process", () => {
    // ioredis emits `error` on every failed reconnect, and an unhandled
    // `error` on an EventEmitter is a process-level crash. Without a
    // listener a Redis outage would take down the money path rather than
    // degrade the guard in front of it.
    const store = build(URL);
    assert.ok(
      store!.redis.listenerCount("error") > 0,
      "an error listener must be attached, or an outage becomes an unhandled crash",
    );

    // Proven rather than asserted structurally: emitting would throw if
    // nothing were listening.
    store!.redis.emit("error", new Error("simulated outage"));
  });

  it("can be closed twice without throwing", () => {
    // `onClose` can fire more than once across a test run that builds and
    // tears down several apps, and a throwing close would fail a suite
    // whose assertions had all passed.
    const store = build(URL);
    return store!.close().then(() => store!.close());
  });
});
