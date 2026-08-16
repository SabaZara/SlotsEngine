import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { registerAuthHook, requireRole } from "./middleware.js";
import { signSession } from "./jwt.js";

/**
 * The hook is mounted on a bare Fastify instance with throwaway routes
 * rather than on the real app. `app.test.ts` already drives the real route
 * table, and it is good at what it covers — but a failure there names a
 * route, not the rule that broke, and the revocation lookup (the reason
 * every request pays an extra database read) is reachable there only
 * incidentally. Here the hook is the subject.
 *
 * What these tests cannot establish: that `buildApp` actually registers the
 * hook, or registers it before the route handlers. That wiring is
 * `app.test.ts`'s territory, and a hook that works perfectly but is never
 * mounted would pass everything below.
 */

before(() => {
  process.env.BACKOFFICE_JWT_SECRET = "a-test-secret-long-enough-to-pass-the-guard";
});

interface SeededUser {
  userId: string;
  email: string;
  roles: string[];
  tokenVersion: number;
  active: boolean;
}

/**
 * A Fastify app carrying only the hook and three probe routes: one plain
 * authenticated route, one role-guarded, and one public path.
 */
async function setup(users: Partial<SeededUser>[] = []) {
  const { db, raw } = fakeMongo();

  const seeded: SeededUser[] = [];
  for (const [index, overrides] of users.entries()) {
    const user: SeededUser = {
      userId: `user-${index}`,
      email: `user-${index}@example.com`,
      roles: ["viewer"],
      tokenVersion: 0,
      active: true,
      ...overrides,
    };
    await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
      .collection("users")
      .insertOne(user);
    seeded.push(user);
  }

  const app: FastifyInstance = Fastify();
  registerAuthHook(app, db as never);

  // Echoes what the hook attached, so a test can assert on the identity the
  // rest of the app will see — not merely on the status code.
  app.get("/v1/probe", async (request) => ({ user: request.user ?? null }));
  app.get("/v1/designers-only", { preHandler: [requireRole("game_designer")] }, async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  // Registered here rather than in the one test that needs it: Fastify
  // refuses to add a route after `ready()`, and a prefix-matching bug would
  // expose exactly this shape of path.
  app.get("/health-secrets", async () => ({ leaked: true }));
  await app.ready();

  return { app, db, raw, seeded };
}

/** A valid token for a seeded user, matching their current tokenVersion. */
const tokenFor = (user: SeededUser): string =>
  signSession({
    userId: user.userId,
    email: user.email,
    roles: user.roles as never,
    tokenVersion: user.tokenVersion,
  }).token;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("registerAuthHook", () => {
  it("lets a valid token through and attaches the session to the request", async () => {
    // Load-bearing: without a passing case, every refusal below would also
    // pass against a hook that rejected everything.
    const { app, seeded } = await setup([{ email: "designer@example.com", roles: ["game_designer"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: bearer(tokenFor(seeded[0])),
    });

    assert.equal(response.statusCode, 200);
    const { user } = response.json() as { user: { userId: string; email: string; roles: string[] } | null };
    assert.ok(user, "the hook should attach request.user");
    assert.equal(user.userId, seeded[0].userId);
    assert.equal(user.email, "designer@example.com");
    assert.deepEqual(user.roles, ["game_designer"]);
  });

  describe("the public paths", () => {
    it("allows the health check with no token at all", async () => {
      const { app } = await setup();
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200);
    });

    it("allows a public path carrying a query string", async () => {
      // The hook compares `request.url.split("?")[0]`. Matching on the raw
      // URL would let `/health?x=1` fall through to the auth branch and 401
      // a health check — which reads as the service being down.
      const { app } = await setup();
      const response = await app.inject({ method: "GET", url: "/health?verbose=1" });
      assert.equal(response.statusCode, 200);
    });

    it("does not treat a path that merely starts with a public one as public", async () => {
      // Exact set membership, not a prefix test. `/health-secrets` must not
      // inherit the health check's exemption.
      const { app } = await setup();
      const response = await app.inject({ method: "GET", url: "/health-secrets" });
      assert.equal(response.statusCode, 401);
    });
  });

  describe("the bearer header", () => {
    it("refuses a request with no Authorization header", async () => {
      const { app } = await setup();
      const response = await app.inject({ method: "GET", url: "/v1/probe" });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "missing_auth");
    });

    it("refuses a header that is not a Bearer scheme", async () => {
      const { app, seeded } = await setup([{}]);
      for (const header of [
        `Basic ${tokenFor(seeded[0])}`,
        tokenFor(seeded[0]), // the raw token, no scheme
        "Bearer", // the scheme with no space and no token
        "",
      ]) {
        const response = await app.inject({
          method: "GET",
          url: "/v1/probe",
          headers: { authorization: header },
        });
        assert.equal(response.statusCode, 401, `expected 401 for authorization: ${JSON.stringify(header)}`);
        assert.equal(response.json().error, "missing_auth");
      }
    });

    it("is case-sensitive about the scheme, as the check is written", async () => {
      // Pinned as current behaviour rather than endorsed: RFC 7235 says the
      // scheme is case-insensitive, so a spec-compliant client sending
      // `bearer` is refused here. Recorded so that relaxing it is a
      // decision rather than an accident.
      const { app, seeded } = await setup([{}]);
      const response = await app.inject({
        method: "GET",
        url: "/v1/probe",
        headers: { authorization: `bearer ${tokenFor(seeded[0])}` },
      });
      assert.equal(response.statusCode, 401);
    });

    it("refuses a well-formed header carrying a junk token", async () => {
      const { app } = await setup();
      for (const token of ["not-a-token", "a.b", "...", "null"]) {
        const response = await app.inject({
          method: "GET",
          url: "/v1/probe",
          headers: bearer(token),
        });
        assert.equal(response.statusCode, 401, `expected 401 for token ${token}`);
        assert.equal(response.json().error, "invalid_or_expired_session");
      }
    });

    it("distinguishes a missing credential from an invalid one", async () => {
      // Different codes on purpose: the client's remedy differs. "Send a
      // token" and "your session ended, sign in again" are not the same
      // instruction.
      const { app } = await setup();
      const missing = await app.inject({ method: "GET", url: "/v1/probe" });
      const invalid = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer("junk") });
      assert.notEqual(missing.json().error, invalid.json().error);
    });
  });

  describe("the revocation check", () => {
    it("refuses a token whose tokenVersion is behind the stored one", async () => {
      // The whole reason for the per-request database read. This is a
      // correctly signed, unexpired token — only the version says it is
      // stale, which is what a role change or a deactivation leaves behind.
      const { app, db, seeded } = await setup([{}]);
      const token = tokenFor(seeded[0]);

      await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
        .collection("users")
        .updateOne({ userId: seeded[0].userId }, { $set: { tokenVersion: 1 } });

      const response = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer(token) });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "session_revoked");
    });

    it("refuses a token issued to a user who has since been deactivated", async () => {
      const { app, db, seeded } = await setup([{}]);
      const token = tokenFor(seeded[0]);

      await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
        .collection("users")
        .updateOne({ userId: seeded[0].userId }, { $set: { active: false } });

      const response = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer(token) });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "session_revoked");
    });

    it("refuses a token for a user who no longer exists", async () => {
      // A deleted user's signed token must not outlive the record. The
      // token itself still verifies — only the lookup fails.
      const { app, db, seeded } = await setup([{}]);
      const token = tokenFor(seeded[0]);

      // Deleted through the collection API. This used to splice the fake's
      // backing array directly, because `fakeMongo` had no `deleteOne` —
      // which worked but bypassed every guarantee the API provides, so the
      // test exercised a path no production caller can take. The stand-in
      // now implements it, pinned against real Mongo in the conformance
      // suite.
      await db.collection("users").deleteMany({});

      const response = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer(token) });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "session_revoked");
    });

    it("accepts a user document with no tokenVersion field, treating it as 0", async () => {
      // Documents predating the field would otherwise 401 every request
      // from an account that was never revoked.
      const { app, db, seeded } = await setup([{}]);
      const token = tokenFor(seeded[0]); // signed with tokenVersion 0

      await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
        .collection("users")
        .updateOne({ userId: seeded[0].userId }, { $unset: { tokenVersion: "" } });

      const response = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer(token) });
      assert.equal(response.statusCode, 200);
    });

    it("refuses a token whose tokenVersion is ahead of the stored one", async () => {
      // Not a normal state — it means a forged or rolled-back payload. The
      // check is an equality, not a `<`, and this pins that.
      const { app, seeded } = await setup([{ tokenVersion: 0 }]);
      const token = signSession({
        userId: seeded[0].userId,
        email: seeded[0].email,
        roles: seeded[0].roles as never,
        tokenVersion: 7,
      }).token;

      const response = await app.inject({ method: "GET", url: "/v1/probe", headers: bearer(token) });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "session_revoked");
    });

    it("looks the user up by the token's userId, not by anything client-supplied", async () => {
      // Two users, one token: the session that comes back must be the one
      // the token names, whatever else is in the database.
      const { app, seeded } = await setup([
        { userId: "user-a", email: "a@example.com" },
        { userId: "user-b", email: "b@example.com" },
      ]);
      const response = await app.inject({
        method: "GET",
        url: "/v1/probe",
        headers: bearer(tokenFor(seeded[1])),
      });

      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as { user: { userId: string } }).user.userId, "user-b");
    });
  });
});

describe("requireRole", () => {
  it("allows a user holding the required role", async () => {
    const { app, seeded } = await setup([{ roles: ["game_designer"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.equal(response.statusCode, 200);
  });

  it("refuses a user holding a different role, with 403 rather than 401", async () => {
    // The distinction matters to a client: 401 means "sign in", 403 means
    // "you are signed in and this is not yours". Collapsing them sends a
    // viewer to the login page in a loop.
    const { app, seeded } = await setup([{ roles: ["viewer"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "forbidden");
  });

  it("names the roles that would have been accepted", async () => {
    const { app, seeded } = await setup([{ roles: ["viewer"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.deepEqual(response.json().requiredRoles, ["game_designer"]);
  });

  it("always admits super_admin, without it being listed", async () => {
    // Deliberate simplification: no role list has to enumerate the admin,
    // and there is exactly one answer to "who can always get in".
    const { app, seeded } = await setup([{ roles: ["super_admin"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.equal(response.statusCode, 200);
  });

  it("admits a user holding several roles when any one of them matches", async () => {
    const { app, seeded } = await setup([{ roles: ["viewer", "game_designer"] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.equal(response.statusCode, 200);
  });

  it("refuses a user with no roles at all", async () => {
    const { app, seeded } = await setup([{ roles: [] }]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/designers-only",
      headers: bearer(tokenFor(seeded[0])),
    });
    assert.equal(response.statusCode, 403);
  });

  it("refuses an unauthenticated request rather than throwing on a missing user", async () => {
    // `requireRole` reads `request.user?.roles ?? []`. If the auth hook is
    // ever removed or reordered, this guard must still deny rather than
    // crash — a 500 here would be a guard failing open into an error page.
    const app = Fastify();
    app.get("/v1/designers-only", { preHandler: [requireRole("game_designer")] }, async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/v1/designers-only" });
    assert.equal(response.statusCode, 403);
  });

  it("accepts any of several allowed roles", async () => {
    const { db } = fakeMongo();
    const app = Fastify();
    registerAuthHook(app, db as never);
    app.get("/v1/either", { preHandler: [requireRole("game_designer", "operations")] }, async () => ({ ok: true }));

    const user: SeededUser = {
      userId: "ops-1",
      email: "ops@example.com",
      roles: ["operations"],
      tokenVersion: 0,
      active: true,
    };
    await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
      .collection("users")
      .insertOne(user);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/v1/either",
      headers: bearer(tokenFor(user)),
    });
    assert.equal(response.statusCode, 200);
  });
});
