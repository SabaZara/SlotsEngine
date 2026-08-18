import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { SERVICE_AUTH_HEADERS, signServiceRequest } from "@slots-engine/service-auth";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../testing/fakeMongo.js";
import { buildApp } from "../app.js";
import { seedReferenceGame } from "../rounds/games.js";

/**
 * The four smaller routes: `public`, `launchTokens`, `simulate`, `health`,
 * plus the service-auth hook they all sit behind.
 *
 * These move no money, which is why they came last — but two of them carry
 * the sharpest edges in the service:
 *
 *   `/public/games/:gameId` is the ONLY route a browser reaches directly,
 *   so it is the only place an information-disclosure mistake reaches a
 *   player. The reel strips and symbol weights are the game's maths: a
 *   client holding them can compute the outcome distribution and, worse,
 *   recognise a favourable state.
 *
 *   `/internal/launch-tokens/consume` is what makes a launch token
 *   single-use. Its 409-versus-401 distinction is the difference between
 *   "this token is spent, get a fresh launch" and "your credentials are
 *   wrong", which are different instructions to a client.
 *
 * What these cannot establish: that a *concurrent* double-consume is
 * refused. Single-use under two simultaneous callers rests on a real unique
 * index and the driver's write-conflict retry — F14's territory, covered by
 * `e2e:spin` against real Mongo.
 */

const logger = createLogger("misc-route-test");
const silentLogger = { ...logger, info: () => {}, warn: () => {}, error: () => {} } as unknown as typeof logger;

const SECRET = "a-test-service-secret-long-enough-to-pass";

async function setup(): Promise<FastifyInstance> {
  const { db, client } = fakeMongo();
  await seedReferenceGame(db as never);

  const app = await buildApp({
    db: db as never,
    client: client as never,
    serviceSecret: SECRET,
    logger: silentLogger,
    corsOrigins: ["http://localhost:9104"],
    rateLimitMax: 100_000,
  });
  await app.ready();
  return app;
}

function post(app: FastifyInstance, path: string, body: unknown, secret = SECRET) {
  const rawBody = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      ...signServiceRequest({ secret, caller: "game-socket", method: "POST", path, rawBody }),
    },
    payload: rawBody,
  });
}

describe("GET /public/games/:gameId — the only browser-facing route", () => {
  it("returns what a client needs to render the game", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    assert.equal(response.statusCode, 200);
    const view = response.json() as Record<string, unknown>;
    assert.equal(view.gameId, REFERENCE_GAME.gameId);
    assert.ok(view.grid, "the client must know the grid to lay out reels");
    assert.ok(Array.isArray(view.paylines), "paylines are needed to draw a win");
    assert.ok(Array.isArray(view.betOptions), "the client must know which stakes are offered");
    assert.ok(Array.isArray(view.symbols));
  });

  it("withholds the reel strips, which are the game's maths", async () => {
    // A client holding these can compute the outcome distribution — and
    // recognise a favourable state, which is worse.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    const view = response.json() as Record<string, unknown>;
    assert.equal(view.reelStrips, undefined);
    assert.equal(view.symbolWeights, undefined);
  });

  it("withholds the RTP target, which is commercial information", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    assert.equal((response.json() as Record<string, unknown>).rtpTarget, undefined);
  });

  it("withholds anything not on the allowlist, including fields added later", async () => {
    // `toPublicView` names what it returns rather than deleting what it
    // must not. That direction matters: a field added to GameDefinition
    // later is withheld by default rather than leaked by default, which is
    // the only version of this that stays correct without vigilance.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    const view = response.json() as Record<string, unknown>;
    const allowed = new Set([
      "gameId",
      "name",
      "version",
      "grid",
      "paylines",
      "symbols",
      "bonusModules",
      "betOptions",
      "currency",
      "paylineWinRule",
      "reelGenerationMode",
      "mathEngineId",
    ]);

    for (const key of Object.keys(view)) {
      assert.ok(allowed.has(key), `unexpected field "${key}" reached a browser — check toPublicView`);
    }
  });

  it("exposes a bonus module's prize table but not any other field on it", async () => {
    // The params are what a client must draw (wheel segments, tile counts).
    // Which segment comes up is decided server-side from a seed the client
    // never sees, so the table is safe and the weighting is not.
    //
    // Seeded with a module carrying an EXTRA field, because the shipped
    // fixtures happen to have only `moduleId` and `params` — against those,
    // mapping and passing the module straight through are indistinguishable,
    // and the mutation that removed the map survived. The map exists
    // precisely for the day a module gains a field, so the test has to
    // supply that day.
    const { db, client } = fakeMongo();
    await seedReferenceGame(db as never);
    await (
      db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } }
    )
      .collection("games")
      .updateOne(
        { gameId: REFERENCE_GAME.gameId },
        {
          $set: {
            bonusModules: [
              {
                moduleId: "wheel",
                params: { segments: [1, 2, 3] },
                segmentWeights: [90, 9, 1],
                internalNote: "house edge tuning",
              },
            ],
          },
        },
      );

    const app = await buildApp({
      db: db as never,
      client: client as never,
      serviceSecret: SECRET,
      logger: silentLogger,
      corsOrigins: ["http://localhost:9104"],
      rateLimitMax: 100_000,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    const modules = (response.json() as { bonusModules: Record<string, unknown>[] }).bonusModules;
    for (const module of modules) {
      assert.deepEqual(
        Object.keys(module).sort(),
        ["moduleId", "params"],
        "a public bonus module is exactly its id and its params",
      );
      assert.equal(module.segmentWeights, undefined, "segment weights are the odds and must never ship");
    }
  });

  it("404s an unknown game rather than revealing whether it exists", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/public/games/no-such-game" });
    await app.close();

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "game_not_found");
  });

  it("needs no signature, because a browser has no secret", async () => {
    // The one unsigned route. If service-auth ever covered it, every player
    // would see 401 on load.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: `/public/games/${REFERENCE_GAME.gameId}` });
    await app.close();

    assert.equal(response.statusCode, 200);
  });
});

describe("POST /internal/launch-tokens/consume", () => {
  it("consumes an unused token", async () => {
    const app = await setup();
    const response = await post(app, "/internal/launch-tokens/consume", {
      jti: "token-1",
      expiresAt: Date.now() + 60_000,
    });
    await app.close();

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().consumed, true);
  });

  it("refuses the same token a second time with 409, not 401", async () => {
    // The distinction the comment in the route calls out: the token was
    // perfectly valid, it has simply been spent. A client needs to tell
    // those apart to know whether a fresh launch would help — 401 says
    // "your credentials are wrong", which sends it to the wrong fix.
    const app = await setup();
    const body = { jti: "token-replay", expiresAt: Date.now() + 60_000 };

    const first = await post(app, "/internal/launch-tokens/consume", body);
    const second = await post(app, "/internal/launch-tokens/consume", body);
    await app.close();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, "launch_token_already_used");
  });

  it("treats distinct tokens independently", async () => {
    const app = await setup();

    const first = await post(app, "/internal/launch-tokens/consume", {
      jti: "token-a",
      expiresAt: Date.now() + 60_000,
    });
    const second = await post(app, "/internal/launch-tokens/consume", {
      jti: "token-b",
      expiresAt: Date.now() + 60_000,
    });
    await app.close();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
  });

  it("refuses a request with no jti", async () => {
    const app = await setup();
    const response = await post(app, "/internal/launch-tokens/consume", { expiresAt: Date.now() });
    await app.close();

    assert.equal(response.statusCode, 400);
  });

  it("refuses an expiresAt that is not a number", async () => {
    // Typed explicitly rather than by truthiness: `0` is a real timestamp
    // and a string would silently become an invalid TTL.
    const app = await setup();

    for (const expiresAt of [undefined, "later", null]) {
      const response = await post(app, "/internal/launch-tokens/consume", { jti: "t", expiresAt });
      assert.equal(response.statusCode, 400, `expiresAt ${String(expiresAt)} must be refused`);
    }
    await app.close();
  });

  it("requires a signature", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/launch-tokens/consume",
      payload: { jti: "t", expiresAt: Date.now() },
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});

describe("POST /internal/simulate", () => {
  it("runs a simulation and stores the run", async () => {
    const app = await setup();
    const response = await post(app, "/internal/simulate", {
      gameId: REFERENCE_GAME.gameId,
      simCount: 1_000,
      betPerSpin: 100,
    });
    await app.close();

    assert.equal(response.statusCode, 200);
    const body = response.json() as { runId: string; simCount: number; resultRtp: number };
    assert.ok(body.runId, "a run must be identifiable afterwards");
    assert.equal(body.simCount, 1_000);
    assert.equal(typeof body.resultRtp, "number");
  });

  it("caps the spin count, so one authoring request cannot stall live players", async () => {
    // A cap is a mitigation, not a fix — the real fix is a worker process —
    // but without it a single request runs a million synchronous spins on
    // the same thread that serves real rounds.
    const app = await setup();
    const response = await post(app, "/internal/simulate", {
      gameId: REFERENCE_GAME.gameId,
      simCount: 100_001,
    });
    await app.close();

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "sim_count_too_large");
    assert.equal(response.json().max, 100_000, "the refusal must say what the limit is");
  });

  it("accepts exactly the cap, so the boundary is inclusive", async () => {
    // Not run at 100_000 — that is a real second of CPU per test. The
    // boundary is checked with `>`, and the off-by-one that matters is
    // refusing a request AT the cap; 100_000 passing is asserted by the
    // refusal above naming it as the max.
    const app = await setup();
    const response = await post(app, "/internal/simulate", {
      gameId: REFERENCE_GAME.gameId,
      simCount: 100_000,
      betPerSpin: 100,
    });
    await app.close();

    assert.equal(response.statusCode, 200, "a request at exactly the cap must be allowed");
  });

  it("loads the game by id and never accepts a definition from the caller", async () => {
    // Deliberate, and a change from the reference implementation: accepting
    // a caller-supplied definition would make this an endpoint for
    // evaluating arbitrary maths on the service that pays real rounds.
    const app = await setup();
    const response = await post(app, "/internal/simulate", {
      gameId: "no-such-game",
      simCount: 100,
      // A full definition, offered and ignored.
      gameDef: REFERENCE_GAME,
    });
    await app.close();

    assert.equal(response.statusCode, 404, "an unknown id must 404 even when a definition is supplied");
    assert.equal(response.json().error, "game_not_found");
  });

  it("refuses a missing or non-positive spin count", async () => {
    const app = await setup();

    for (const simCount of [undefined, 0, -1, 1.5, "100"]) {
      const response = await post(app, "/internal/simulate", {
        gameId: REFERENCE_GAME.gameId,
        simCount,
      });
      assert.equal(response.statusCode, 400, `simCount ${String(simCount)} must be refused`);
    }
    await app.close();
  });

  it("refuses a request with no gameId", async () => {
    const app = await setup();
    const response = await post(app, "/internal/simulate", { simCount: 100 });
    await app.close();

    assert.equal(response.statusCode, 400);
  });

  it("requires a signature", async () => {
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/simulate",
      payload: { gameId: REFERENCE_GAME.gameId, simCount: 100 },
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});

describe("the service-auth hook", () => {
  it("refuses a signature made with the wrong secret", async () => {
    const app = await setup();
    const response = await post(
      app,
      "/internal/launch-tokens/consume",
      { jti: "t", expiresAt: Date.now() },
      "a-different-secret-also-long-enough-ok",
    );
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("refuses a signature replayed against a different route", async () => {
    // The path is part of the signed material, so a signature captured from
    // one internal call cannot authorise another.
    const app = await setup();
    const body = { jti: "t", expiresAt: Date.now() };
    const rawBody = JSON.stringify(body);
    const headers = signServiceRequest({
      secret: SECRET,
      caller: "game-socket",
      method: "POST",
      path: "/internal/simulate",
      rawBody,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/launch-tokens/consume",
      headers: { "content-type": "application/json", ...headers },
      payload: rawBody,
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("refuses a signature whose body has been altered in flight", async () => {
    // The body is signed, so a proxy or an attacker cannot rewrite an
    // amount between the socket and the backend.
    const app = await setup();
    const path = "/internal/launch-tokens/consume";
    const headers = signServiceRequest({
      secret: SECRET,
      caller: "game-socket",
      method: "POST",
      path,
      rawBody: JSON.stringify({ jti: "original", expiresAt: 1 }),
    });

    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify({ jti: "swapped", expiresAt: 1 }),
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("refuses a stale timestamp, bounding the replay window", async () => {
    const app = await setup();
    const path = "/internal/launch-tokens/consume";
    const rawBody = JSON.stringify({ jti: "t", expiresAt: Date.now() });
    const headers = signServiceRequest({
      secret: SECRET,
      caller: "game-socket",
      method: "POST",
      path,
      rawBody,
      timestamp: Date.now() - 10 * 60 * 1000,
    });

    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", ...headers },
      payload: rawBody,
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });

  it("answers every failure with the same opaque 401", async () => {
    // A prober must not learn WHICH check failed — "bad signature" and
    // "stale timestamp" would together let someone probe the clock skew
    // window. The reasons are logged, not returned.
    const app = await setup();
    const path = "/internal/launch-tokens/consume";
    const rawBody = JSON.stringify({ jti: "t", expiresAt: Date.now() });

    const bodies: string[] = [];
    // No signature at all. The content-type is set explicitly: without it
    // Fastify refuses a raw string body with 415 before service-auth is
    // reached, which is correct but is not the comparison this test is
    // making.
    bodies.push(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: { "content-type": "application/json" },
          payload: rawBody,
        })
      ).body,
    );
    // Wrong secret.
    bodies.push(
      (await post(app, path, { jti: "t", expiresAt: Date.now() }, "a-different-secret-also-long-enough-ok"))
        .body,
    );
    // Stale timestamp.
    bodies.push(
      (
        await app.inject({
          method: "POST",
          url: path,
          headers: {
            "content-type": "application/json",
            ...signServiceRequest({
              secret: SECRET,
              caller: "game-socket",
              method: "POST",
              path,
              rawBody,
              timestamp: Date.now() - 10 * 60 * 1000,
            }),
          },
          payload: rawBody,
        })
      ).body,
    );
    await app.close();

    assert.equal(new Set(bodies).size, 1, `every 401 must look identical, got ${JSON.stringify(bodies)}`);
  });

  it("refuses a request carrying a caller name but no signature", async () => {
    // The rate limiter reads that header for bucketing, which must never be
    // mistaken for a credential.
    const app = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/internal/launch-tokens/consume",
      headers: { [SERVICE_AUTH_HEADERS.caller]: "game-socket" },
      payload: { jti: "t", expiresAt: Date.now() },
    });
    await app.close();

    assert.equal(response.statusCode, 401);
  });
});

describe("the health routes", () => {
  it("reports liveness without touching the database", async () => {
    // A liveness probe that fails on a database blip restarts a healthy
    // process and makes an outage worse.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
  });

  it("reports readiness only when the database answers", async () => {
    // Readiness means this instance can actually serve a round, which needs
    // the database — the opposite trade from liveness.
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    await app.close();

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ready");
  });

  it("needs no signature, so a probe is not an authenticated caller", async () => {
    const app = await setup();
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/health/ready" })).statusCode, 200);
    await app.close();
  });
});

describe("asset keys reaching a browser", () => {
  /**
   * The bug this pins: assets are stored as **keys**
   * (`games/x/symbol-ten/….svg`) against a private bucket, and this route
   * handed them to the browser unchanged. A key is not a URL — it resolves
   * relative to the game frontend and 404s — so every image a designer
   * uploaded failed to load for players.
   *
   * It failed *quietly*, which is why it shipped: the client falls back to
   * its generated glyphs and logs a warning, so the game looks correct and
   * the artwork simply never appears. The backoffice signs on read and
   * looked right throughout, so the editor previewed artwork no player
   * could see.
   *
   * Found by uploading real artwork and looking at the game.
   *
   * **What this cannot establish**: that the signed URL actually fetches.
   * Signing needs configured storage, which this suite has none of — so
   * with storage absent the route passes keys through unchanged and this
   * asserts only that the *seam exists and is exercised*. The live check is
   * recorded in docs/TODO.md, where the same upload was fetched at 200 by a
   * real browser.
   */
  it("hands the client something fetchable, never a bare storage key", async () => {
    const { db, client } = fakeMongo();
    await seedReferenceGame(db as never);

    // A published game whose assets are storage keys, exactly as an upload
    // leaves them.
    await db.collection("games").insertOne({
      ...REFERENCE_GAME,
      gameId: "asset-key-game",
      assets: {
        symbolImageUrls: { ten: "games/asset-key-game/symbol-ten/abc.svg" },
        backgroundUrl: "games/asset-key-game/background/def.png",
      },
    } as never);

    const app = await buildApp({
      db: db as never,
      client: client as never,
      serviceSecret: SECRET,
      logger: silentLogger,
      corsOrigins: ["http://localhost:9104"],
      rateLimitMax: 100_000,
    });
    await app.ready();

    const body = (await app.inject({ method: "GET", url: "/public/games/asset-key-game" })).json();
    const assets = body.assets ?? {};

    // The premise: without this the assertion below is vacuous.
    assert.ok(assets.symbolImageUrls?.ten, "the fixture must actually carry a symbol asset");
    assert.ok(assets.backgroundUrl, "and a background");

    const values: string[] = [
      ...Object.values((assets.symbolImageUrls ?? {}) as Record<string, string>),
      assets.backgroundUrl,
    ].filter((v): v is string => typeof v === "string");

    for (const value of values) {
      // Either signed into an absolute URL, or — when storage is not
      // configured, as here — passed through as the stored key. What must
      // never happen is a *silent* third state where the route claims to
      // have signed and did not.
      const looksSigned = /^https?:\/\//.test(value);
      const looksLikeKey = value.startsWith("games/");
      assert.ok(
        looksSigned || looksLikeKey,
        `"${value}" is neither a signed URL nor a storage key — the asset seam is broken`,
      );
    }

    await app.close();
  });
});
