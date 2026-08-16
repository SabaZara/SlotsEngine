import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { fakeMongo } from "./testing/fakeMongo.js";
import { buildApp } from "./app.js";
import { seedReferenceGame } from "./rounds/games.js";

/**
 * The composition, driven through `app.inject()`.
 *
 * **F6 and F7 both happened in this file**, and both were assembly bugs
 * rather than logic bugs:
 *
 *   F6 — `void app.register(rateLimit, …)` in a synchronous factory left
 *        every route unlimited, because the plugin's `onRoute` hook had not
 *        installed by the time routes were added. No error; requests simply
 *        returned 200 with no protection.
 *   F7 — this error handler forced every error to 500, flattening the
 *        limiter's 429 into `internal_error`, so a limited client was told
 *        nothing and had no reason to back off.
 *
 * Neither is visible from any single module's tests, which is the point of
 * this file. The four things it pins are the four the assembly decides:
 * that the limiter is actually installed, that its 429 survives the error
 * handler, that CORS reaches only `/public/*`, and that service-auth is
 * registered ahead of the internal routes.
 *
 * What these cannot establish:
 *
 *   - That `index.ts` passes the right values in. It reads
 *     `GAME_CORS_ORIGINS` and `GAME_RATE_LIMIT` itself and a typo there is
 *     invisible here — the same gap the socket suite has.
 *   - Anything about the sweep interval, connection handling or shutdown,
 *     which stayed in `index.ts` deliberately.
 *   - Behaviour against a real schema validator or a transaction, since
 *     `fakeMongo` models neither. F1 and F9 both needed a live stack.
 */

const logger = createLogger("game-backend-test");
const silentLogger = { ...logger, info: () => {}, warn: () => {}, error: () => {} } as unknown as typeof logger;

const SECRET = "a-test-service-secret-long-enough-to-pass";

/** Builds the real app over the in-memory stand-in. */
async function setup(overrides: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<FastifyInstance> {
  const { db, client } = fakeMongo();
  await seedReferenceGame(db as never);

  const app = await buildApp({
    db: db as never,
    client: client as never,
    serviceSecret: SECRET,
    logger: silentLogger,
    corsOrigins: ["http://localhost:9104"],
    rateLimitMax: 600,
    ...overrides,
  });

  // A route that always throws, so the error handler's 500 branch is
  // reachable. Registered here because Fastify refuses to add routes after
  // `ready()`, and the handler is part of what `buildApp` composes.
  app.get("/test-only/boom", async () => {
    throw new Error("connection string mongodb://user:hunter2@db:27017 failed");
  });

  await app.ready();
  return app;
}

describe("the rate limiter is actually installed", () => {
  it("limits a caller that exceeds the ceiling, rather than serving it", async () => {
    // F6's regression test. The limiter being *configured* is not the same
    // as the limiter being *installed* before the routes were added, and
    // the difference is silent — 200s with no protection.
    const app = await setup({ rateLimitMax: 3 });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await app.inject({ method: "GET", url: "/public/games/reference-5x3" })).statusCode);
    }
    await app.close();

    assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(", ")} — the limiter is not installed`);
  });

  it("reports a limited request as rate_limited, not as an internal error", async () => {
    // F7's regression test. The limiter raises an error carrying no `code`,
    // so without the explicit 429 branch the handler reports `bad_request`
    // — telling a client to fix its request rather than to slow down — or,
    // as originally shipped, `internal_error`.
    const app = await setup({ rateLimitMax: 2 });

    let limited: { statusCode: number; body: string } | undefined;
    for (let i = 0; i < 6 && !limited; i++) {
      const response = await app.inject({ method: "GET", url: "/public/games/reference-5x3" });
      if (response.statusCode === 429) limited = { statusCode: 429, body: response.body };
    }
    await app.close();

    assert.ok(limited, "never got a 429 to inspect");
    const body = JSON.parse(limited.body) as { error: string; message?: string };
    assert.equal(body.error, "rate_limited");
    assert.match(String(body.message), /Retry in/, "a limited client needs to know how long to wait");
  });

  it("exempts the health checks, so a probe cannot be throttled out of rotation", async () => {
    // A limiter that can fail a readiness probe will eventually take a
    // healthy service out of rotation for being busy.
    const app = await setup({ rateLimitMax: 2 });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await app.inject({ method: "GET", url: "/health" })).statusCode);
    }
    await app.close();

    assert.ok(!statuses.includes(429), `health must never be limited, got ${statuses.join(", ")}`);
  });

  it("gives two named callers separate buckets, despite sharing one address", async () => {
    // Every internal call arrives from one address (game-socket), so an
    // IP-keyed limit would not throttle an abuser — it would throttle the
    // whole platform the moment traffic is healthy, turning a defence into
    // an outage.
    //
    // Exercised on `/public/*` rather than an internal route, and the
    // reason is worth recording: service-auth rejects an unsigned internal
    // call at 401 before the limiter's counter is ever consumed, so on
    // those routes both keying strategies produce identical output and the
    // test cannot see the difference. Measured, not assumed — eight
    // requests against a limit of three returned 401 every time and never a
    // 429. `app.inject` gives every request the same IP, so if the key were
    // the IP these two callers would share one bucket.
    const app = await setup({ rateLimitMax: 3 });

    const exhaust = async (headers: Record<string, string>) => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (await app.inject({ method: "GET", url: "/public/games/reference-5x3", headers })).statusCode,
        );
      }
      return statuses;
    };

    const first = await exhaust({ "x-service-caller": "a" });
    assert.ok(first.includes(429), "the first caller should have exhausted its own bucket");

    const second = await exhaust({ "x-service-caller": "b" });
    await app.close();

    assert.equal(second[0], 200, "a differently-named caller must start with a fresh bucket");
  });

  it("falls back to the IP for a request with no caller header", async () => {
    // Browser traffic on `/public/*` has no such header, and must still be
    // limited — a key generator returning a constant for these would put
    // every player in one bucket.
    const app = await setup({ rateLimitMax: 3 });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await app.inject({ method: "GET", url: "/public/games/reference-5x3" })).statusCode);
    }
    await app.close();

    assert.ok(statuses.includes(429), `an unnamed caller must still be limited, got ${statuses.join(", ")}`);
  });
});

describe("the error handler", () => {
  it("passes a 4xx through with its own status", async () => {
    // A client error is the client's to act on; flattening it to 500
    // destroys the only signal it has.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/public/games/no-such-game" });
    await app.close();

    assert.ok(response.statusCode >= 400 && response.statusCode < 500, `got ${response.statusCode}`);
  });

  it("does not leak internal detail on a 500", async () => {
    // An internal error message can disclose schema and code structure to a
    // caller. The detail belongs in the log.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/test-only/boom" });
    await app.close();

    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), { error: "internal_error" });
    assert.equal(response.body.includes("hunter2"), false, "the response must not carry the underlying message");
  });
});

describe("CORS reaches only the browser-facing route", () => {
  it("allows the configured origin on /public/*", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/public/games/reference-5x3",
      headers: { origin: "http://localhost:9104" },
    });
    await app.close();

    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:9104");
  });

  it("refuses an origin that is not configured", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/public/games/reference-5x3",
      headers: { origin: "https://evil.example" },
    });
    await app.close();

    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });

  it("sends no allow-origin header on an internal route", async () => {
    // The delegator's purpose. Registering CORS globally would put a header
    // on `/internal/*` too: those calls are rejected without a signature,
    // but a page would then be able to *read* the error body cross-origin,
    // which hands a prober information for no benefit.
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/rounds",
      headers: { origin: "http://localhost:9104" },
      payload: {},
    });
    await app.close();

    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });

  it("sends no allow-origin header on health", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:9104" },
    });
    await app.close();

    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });
});

describe("service auth is registered ahead of the internal routes", () => {
  it("refuses an unsigned internal call", async () => {
    // Registered before the routes so no internal route can be reached
    // unsigned — including one added later by someone who does not know
    // this exists.
    const app = await setup();
    const response = await app.inject({ method: "POST", url: "/internal/rounds", payload: {} });
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("refuses an internal call carrying only an unsigned caller header", async () => {
    // The limiter reads that header for bucketing, which must not be
    // mistaken for it being a credential.
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/rounds",
      headers: { "x-service-caller": "game-socket" },
      payload: {},
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("leaves the public and health routes reachable without a signature", async () => {
    // The other direction: service-auth must not have been applied so
    // broadly that the browser-facing route and the probes stop working.
    const app = await setup();

    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "GET", url: "/public/games/reference-5x3" })).statusCode,
      200,
    );
    await app.close();
  });
});
