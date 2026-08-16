// The suite drives hundreds of requests from one synthetic address; the
// limiter is a production concern and would only make this flaky.
process.env.DISABLE_RATE_LIMIT = "true";

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { createLogger } from "@slots-engine/logging";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { fakeMongo } from "../../game-backend/src/testing/fakeMongo.js";
import { buildApp } from "./app.js";
import { createUser } from "./auth/users.js";
import { signSession } from "./auth/jwt.js";
import type { GameDraft } from "./games/drafts.js";

/**
 * Drives the real route table through `app.inject()` rather than calling
 * handlers directly — the auth hook and the role guards are exactly the
 * parts worth testing, and calling a handler in isolation skips both.
 */

before(() => {
  process.env.BACKOFFICE_JWT_SECRET = "a-test-secret-long-enough-to-pass-the-guard";
});

const logger = createLogger("backoffice-api-test");

async function setup() {
  const { db, raw } = fakeMongo();
  const app = await buildApp(db as never, logger);
  await app.ready();

  const designer = await createUser(db as never, {
    email: "designer@example.com",
    password: "correct-horse",
    roles: ["game_designer"],
  });
  const viewer = await createUser(db as never, {
    email: "viewer@example.com",
    password: "correct-horse",
    roles: ["viewer"],
  });

  const tokenFor = (user: { userId: string; email: string; roles: string[]; tokenVersion: number }) =>
    signSession({
      userId: user.userId,
      email: user.email,
      roles: user.roles as never,
      tokenVersion: user.tokenVersion,
    }).token;

  return { app, db, raw, designer, viewer, tokenFor };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("authentication", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("serves health without a token", async () => {
    assert.equal((await ctx.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  });

  it("refuses every other route without a token", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/v1/games" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "missing_auth");
  });

  it("refuses a forged token", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth("not.atoken") });
    assert.equal(response.statusCode, 401);
  });

  it("logs in with correct credentials", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: "correct-horse" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().token, "string");
  });

  it("never returns the password hash", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: "correct-horse" },
    });
    assert.ok(!("passwordHash" in response.json().user), "a password hash must never leave the service");
  });

  it("gives the same answer for a wrong password and an unknown user", async () => {
    // Distinguishing them hands an attacker free account enumeration.
    const wrongPassword = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: "wrong" },
    });
    const unknownUser = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "nobody@example.com", password: "wrong" },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownUser.statusCode, 401);
    assert.deepEqual(wrongPassword.json(), unknownUser.json());
  });

  it("is case-insensitive about the email", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "DESIGNER@Example.com", password: "correct-horse" },
    });
    assert.equal(response.statusCode, 200);
  });

  it("locks an account after repeated failures, and says so with a 429", async () => {
    // The default allowance is 10; this drives the real route table to the
    // limit rather than testing the throttle module again in isolation.
    const attempt = (password: string) =>
      ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "designer@example.com", password } });

    for (let i = 0; i < 10; i++) {
      assert.equal((await attempt("wrong")).statusCode, 401, `attempt ${i + 1} should be a plain rejection`);
    }

    const locked = await attempt("wrong");
    assert.equal(locked.statusCode, 429, "the account should be locked once the allowance is spent");
    assert.equal(locked.json().error, "account_locked");
    assert.ok(Number(locked.headers["retry-after"]) > 0, "a lockout must tell the client when to return");
  });

  it("refuses the CORRECT password while locked", async () => {
    // The point of the whole feature: guessing must stop being useful even
    // if the attacker's next guess happens to be right.
    for (let i = 0; i < 10; i++) {
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "designer@example.com", password: "wrong" },
      });
    }

    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: "correct-horse" },
    });
    assert.equal(response.statusCode, 429);
  });

  it("does not reveal that an account exists by locking it differently", async () => {
    // A locked real address and a locked unknown address must look the
    // same, or the lockout reopens the enumeration oracle that the
    // identical 401 body closes.
    const spend = async (email: string) => {
      let last;
      for (let i = 0; i < 11; i++) {
        last = await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "wrong" } });
      }
      return last!;
    };

    const real = await spend("designer@example.com");
    const unknown = await spend("nobody@example.com");
    assert.equal(real.statusCode, unknown.statusCode);
    assert.deepEqual(real.json(), unknown.json());
  });

  it("locking one account leaves every other administrator able to log in", async () => {
    // The failure mode of the rejected IP+email limiter design: one
    // attacker locking out everyone. This is the regression test for it.
    for (let i = 0; i < 11; i++) {
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "designer@example.com", password: "wrong" },
      });
    }

    const other = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "viewer@example.com", password: "correct-horse" },
    });
    assert.equal(other.statusCode, 200, "one attacked account must not deny service to the rest");
  });

  it("a successful login clears the failure count", async () => {
    const wrong = () =>
      ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "designer@example.com", password: "wrong" },
      });

    for (let i = 0; i < 9; i++) await wrong();

    // One success resets the run, so the next nine failures must not lock.
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: "correct-horse" },
    });
    assert.equal(ok.statusCode, 200);

    for (let i = 0; i < 9; i++) {
      assert.equal((await wrong()).statusCode, 401, "the counter should have restarted");
    }
  });

  it("records a lockout in the audit log", async () => {
    for (let i = 0; i < 10; i++) {
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "designer@example.com", password: "wrong" },
      });
    }

    const entries = await ctx.raw.collection("auditLogs").find({ action: "auth.account_locked" }).toArray();
    assert.equal(entries.length, 1, "a lockout is worth exactly one audit entry");
    assert.equal(entries[0].entityId, ctx.designer.userId);
  });

  it("revokes every issued token when the user logs out everywhere", async () => {
    // The property a stateless token cannot provide on its own, and the
    // reason every request pays for one extra lookup.
    const token = ctx.tokenFor(ctx.designer);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(token) })).statusCode, 200);

    await ctx.app.inject({ method: "POST", url: "/v1/auth/logout", headers: auth(token) });

    const after = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(token) });
    assert.equal(after.statusCode, 401);
    assert.equal(after.json().error, "session_revoked");
  });

  it("accepts a bodyless POST that still declares a JSON content-type", async () => {
    // Caught end to end, missed by every unit test here: Fastify rejects an
    // empty body with a JSON content-type as a 400 before the handler runs,
    // so logout silently never executed and the token stayed valid. Any
    // ordinary client that sets a JSON content-type by default hits this.
    const token = ctx.tokenFor(ctx.designer);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { ...auth(token), "content-type": "application/json" },
      payload: "",
    });
    assert.equal(response.statusCode, 200, "a route taking no body must accept an empty one");
    assert.equal(response.json().loggedOut, true);
  });

  it("still rejects a malformed JSON body", async () => {
    // Absent is benign; corrupt is not.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a deactivated user's existing token immediately", async () => {
    const token = ctx.tokenFor(ctx.designer);
    await ctx.raw.collection("users").updateOne({ userId: ctx.designer.userId }, { $set: { active: false } });

    const response = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(token) });
    assert.equal(response.statusCode, 401, "deactivation must take effect now, not when the token expires");
  });
});

describe("role guards", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("lets a viewer read the game list", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(ctx.tokenFor(ctx.viewer)) });
    assert.equal(response.statusCode, 200);
  });

  it("stops a viewer creating a game", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/games",
      headers: auth(ctx.tokenFor(ctx.viewer)),
      payload: { gameId: "nope", name: "Nope" },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json().requiredRoles, ["game_designer"]);
  });

  it("stops a viewer publishing", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/games/anything/publish",
      headers: auth(ctx.tokenFor(ctx.viewer)),
      payload: {},
    });
    assert.equal(response.statusCode, 403);
  });

  it("stops a designer reading the audit log", async () => {
    // Designers change games; operations reviews who changed what.
    const response = await ctx.app.inject({ method: "GET", url: "/v1/audit", headers: auth(ctx.tokenFor(ctx.designer)) });
    assert.equal(response.statusCode, 403);
  });

  it("lets a super_admin through every guard", async () => {
    const admin = await createUser(ctx.db as never, {
      email: "admin@example.com",
      password: "x",
      roles: ["super_admin"],
    });
    const response = await ctx.app.inject({ method: "GET", url: "/v1/audit", headers: auth(ctx.tokenFor(admin)) });
    assert.equal(response.statusCode, 200);
  });
});

describe("game authoring", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;

  beforeEach(async () => {
    ctx = await setup();
    token = ctx.tokenFor(ctx.designer);
  });

  const create = (gameId = "my-game", name = "My Game") =>
    ctx.app.inject({ method: "POST", url: "/v1/games", headers: auth(token), payload: { gameId, name } });

  it("creates a game from a valid starter draft", async () => {
    const response = await create();
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().draft.gameId, "my-game");
  });

  it("refuses to reuse an existing gameId", async () => {
    // A gameId is referenced by every round ever played under it.
    await create();
    assert.equal((await create()).statusCode, 409);
  });

  it("saves an invalid draft but reports why it is invalid", async () => {
    // A designer must be able to leave work half-finished; validity is a
    // publish-time gate, not a save-time one.
    await create();
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/games/my-game",
      headers: auth(token),
      payload: { betOptions: [1.5] },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().valid, false);
    assert.match(response.json().errors[0], /minor units/);
  });

  it("never lets the body rewrite the gameId", async () => {
    await create();
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/games/my-game",
      headers: auth(token),
      payload: { gameId: "someone-elses-game", name: "Renamed" },
    });
    assert.equal(response.json().draft.gameId, "my-game");
  });

  it("editing a draft does not change what players see", async () => {
    // The whole point of the draft/publish split.
    await create();
    await ctx.app.inject({ method: "PUT", url: "/v1/games/my-game", headers: auth(token), payload: { name: "Renamed" } });
    assert.equal(await ctx.raw.collection("games").findOne({ gameId: "my-game" }), null);
  });
});

describe("publishing", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;

  /** A draft whose maths really does hit its target — copied from the
   * reference game, which is simulation-verified. */
  const tunedDraft = (): Partial<GameDraft> => ({
    grid: REFERENCE_GAME.grid,
    reelGenerationMode: REFERENCE_GAME.reelGenerationMode,
    reelStrips: REFERENCE_GAME.reelStrips,
    paylines: REFERENCE_GAME.paylines,
    symbols: REFERENCE_GAME.symbols,
    bonusModules: REFERENCE_GAME.bonusModules,
    rtpTarget: REFERENCE_GAME.rtpTarget,
    betOptions: REFERENCE_GAME.betOptions,
  });

  beforeEach(async () => {
    ctx = await setup();
    token = ctx.tokenFor(ctx.designer);
    await ctx.app.inject({ method: "POST", url: "/v1/games", headers: auth(token), payload: { gameId: "g", name: "G" } });
  });

  const publish = (force = false) =>
    ctx.app.inject({ method: "POST", url: "/v1/games/g/publish", headers: auth(token), payload: { force } });

  it("publishes a well-tuned game and makes it live at version 1", async () => {
    await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });

    const response = await publish();
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
    assert.equal(response.json().gameDef.version, 1);
    assert.equal(response.json().gameDef.status, "published");

    const live = await ctx.raw.collection("games").findOne({ gameId: "g" });
    assert.equal(live?.version, 1);
  });

  it("refuses a game whose measured RTP misses its declared target", async () => {
    // The most valuable gate here: rtpTarget is an intention, the
    // simulation is a measurement, and the two disagreeing means the
    // paytable does not do what its author believes.
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/games/g",
      headers: auth(token),
      payload: { ...tunedDraft(), rtpTarget: 0.5 },
    });

    const response = await publish();
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error, "rtp_out_of_tolerance");
    assert.equal(await ctx.raw.collection("games").findOne({ gameId: "g" }), null, "nothing may go live when refused");
  });

  it("allows a deliberate override, and records that it was forced", async () => {
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/games/g",
      headers: auth(token),
      payload: { ...tunedDraft(), rtpTarget: 0.5 },
    });

    assert.equal((await publish(true)).statusCode, 200);
    const entry = ctx.raw.collection("auditLogs").all().find((e) => e.action === "game.publish");
    assert.equal((entry?.diff as Record<string, unknown>).forcedPastRtpTolerance, true);
  });

  it("refuses to publish an invalid draft", async () => {
    await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: { paylines: [] } });
    const response = await publish();
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "draft_invalid");
  });

  it("bumps the version and keeps every previous one", async () => {
    // A round records the gameVersion it ran under, so history must be
    // append-only for any historical round to stay auditable.
    await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
    await publish();
    await publish();

    assert.equal((await ctx.raw.collection("games").findOne({ gameId: "g" }))?.version, 2);
    const versions = await ctx.raw.collection("gameVersions").find({ gameId: "g" }).toArray();
    assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2]);
  });

  it("records who published, and the measured RTP", async () => {
    await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
    await publish();

    const entry = ctx.raw.collection("auditLogs").all().find((e) => e.action === "game.publish");
    assert.equal(entry?.actorUserId, ctx.designer.userId);
    assert.equal((entry?.diff as Record<string, unknown>).toVersion, 1);
    assert.equal(typeof (entry?.diff as Record<string, unknown>).resultRtp, "number");
  });

  it("stores a simulation run for every publish", async () => {
    await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
    await publish();
    assert.equal(ctx.raw.collection("rtpSimulationRuns").all().length, 1);
  });

  describe("version history", () => {
    it("lists every published version, newest first", async () => {
      // A designer needs to see what shipped and when; ordering matters
      // because the UI shows the current version at the top.
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
      await publish();
      await ctx.app.inject({ method: "POST", url: "/v1/games/g/draft-from-published", headers: auth(token) });
      await publish();

      const response = await ctx.app.inject({ method: "GET", url: "/v1/games/g/versions", headers: auth(token) });
      assert.equal(response.statusCode, 200);
      const versions = response.json().versions as { version: number }[];
      assert.deepEqual(versions.map((v) => v.version), [2, 1], "newest first");
    });

    it("returns an empty list for a game that has never published", async () => {
      // Not a 404 — the game exists, it simply has no history yet, and a
      // client rendering a version list should show "none" rather than an
      // error.
      const response = await ctx.app.inject({ method: "GET", url: "/v1/games/g/versions", headers: auth(token) });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().versions, []);
    });

    it("never leaks Mongo's _id into the response", async () => {
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
      const published = await publish();
      assert.equal(published.statusCode, 200, JSON.stringify(published.json()));

      const versions = (await ctx.app.inject({ method: "GET", url: "/v1/games/g/versions", headers: auth(token) })).json()
        .versions as Record<string, unknown>[];

      assert.equal(versions.length, 1, "the publish above should have produced exactly one version");
      assert.ok(!("_id" in versions[0]), "an internal id has no business reaching a client");
      assert.equal(versions[0].version, 1);
    });
  });

  describe("draft from published", () => {
    it("reopens a published game once its draft has been cleared", async () => {
      // Publishing does NOT delete the draft — verified against the real
      // route rather than assumed — so this route only applies after the
      // draft is gone, which is the state a fresh checkout of an existing
      // game is in. My first version of this test published and
      // immediately expected 200; it got a correct 409.
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
      await publish();
      await ctx.raw.collection("gameDrafts").updateMany({ gameId: "g" }, { $set: { gameId: "archived" } });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/draft-from-published",
        headers: auth(token),
      });
      assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
      assert.equal(response.json().draft.gameId, "g");
      // Carries the published definition's content forward, which is the
      // point — a designer edits from what shipped, not from blank.
      assert.deepEqual(response.json().draft.grid, tunedDraft().grid);
    });

    it("refuses when a draft is already open, rather than discarding it", async () => {
      // The destructive case. Overwriting an in-progress draft with the
      // published version would silently throw away unsaved design work.
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
      await publish();
      await ctx.app.inject({ method: "POST", url: "/v1/games/g/draft-from-published", headers: auth(token) });

      const second = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/draft-from-published",
        headers: auth(token),
      });
      assert.equal(second.statusCode, 409);
      assert.equal(second.json().error, "draft_already_exists");
    });

    it("404s for a game that was never published", async () => {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/nope/draft-from-published",
        headers: auth(token),
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "game_not_found");
    });

    it("is refused to a viewer", async () => {
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });
      await publish();

      const response = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/draft-from-published",
        headers: auth(ctx.tokenFor(ctx.viewer)),
      });
      assert.equal(response.statusCode, 403);
    });
  });

  describe("simulate preview", () => {
    it("runs a preview simulation without publishing anything", async () => {
      // The point of the route: a designer sees measured RTP before
      // committing, and nothing goes live.
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });

      const response = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/simulate",
        headers: auth(token),
        payload: { simCount: 2000 },
      });

      assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
      assert.equal(typeof response.json().simulation.resultRtp, "number");
      assert.equal(await ctx.raw.collection("games").findOne({ gameId: "g" }), null, "nothing may go live");
    });

    it("clamps simCount, so one request cannot cost unbounded work", async () => {
      // Without the ceiling a designer could ask for a billion spins and
      // occupy the service indefinitely. The floor matters too: a handful
      // of spins would report a meaningless RTP as though it were real.
      await ctx.app.inject({ method: "PUT", url: "/v1/games/g", headers: auth(token), payload: tunedDraft() });

      const huge = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/simulate",
        headers: auth(token),
        payload: { simCount: 100_000_000 },
      });
      assert.equal(huge.statusCode, 200);
      assert.ok(huge.json().simulation.simCount <= 100_000, "an absurd request must be capped");

      const tiny = await ctx.app.inject({
        method: "POST",
        url: "/v1/games/g/simulate",
        headers: auth(token),
        payload: { simCount: 1 },
      });
      assert.ok(tiny.json().simulation.simCount >= 1000, "a trivial request must be floored");
    });

    it("refuses to simulate an invalid draft, naming why", async () => {
      // Simulating a broken definition would either throw deep in the
      // engine or produce a number that means nothing.
      await ctx.app.inject({
        method: "PUT",
        url: "/v1/games/g",
        headers: auth(token),
        payload: { ...tunedDraft(), rtpTarget: 95 },
      });

      const response = await ctx.app.inject({ method: "POST", url: "/v1/games/g/simulate", headers: auth(token) });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "draft_invalid");
      assert.match(response.json().message, /fraction like 0\.95/);
    });

    it("404s when there is no draft to simulate", async () => {
      const response = await ctx.app.inject({ method: "POST", url: "/v1/games/nope/simulate", headers: auth(token) });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "draft_not_found");
    });
  });
});
