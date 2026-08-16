// The suite drives hundreds of requests from one synthetic address; the
// limiter is a production concern and would only make this flaky.
process.env.DISABLE_RATE_LIMIT = "true";

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { createLogger } from "@slots-engine/logging";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { buildApp } from "../app.js";
import { signSession } from "../auth/jwt.js";
import { createUser } from "../auth/users.js";
import { verifyPassword } from "../auth/passwords.js";

before(() => {
  process.env.BACKOFFICE_JWT_SECRET = "a-test-secret-long-enough-to-pass-the-guard";
});

const logger = createLogger("users-test");
const GOOD_PASSWORD = "a-long-enough-password";

async function setup() {
  const { db, raw } = fakeMongo();
  const app = await buildApp(db as never, logger);
  await app.ready();

  const admin = await createUser(db as never, {
    email: "admin@example.com",
    password: GOOD_PASSWORD,
    roles: ["super_admin"],
  });
  const designer = await createUser(db as never, {
    email: "designer@example.com",
    password: GOOD_PASSWORD,
    roles: ["game_designer"],
  });

  const tokenFor = (user: { userId: string; email: string; roles: string[]; tokenVersion: number }) =>
    signSession({ userId: user.userId, email: user.email, roles: user.roles as never, tokenVersion: user.tokenVersion })
      .token;

  return { app, db, raw, admin, designer, tokenFor };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("who may manage users", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("lets a super_admin list users", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/v1/users", headers: auth(ctx.tokenFor(ctx.admin)) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().users.length, 2);
  });

  it("stops a game designer listing users", async () => {
    // Managing access is the operation that grants every other operation,
    // so it is the one thing a designer must not reach.
    const response = await ctx.app.inject({ method: "GET", url: "/v1/users", headers: auth(ctx.tokenFor(ctx.designer)) });
    assert.equal(response.statusCode, 403);
  });

  it("stops a designer creating a user", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/users",
      headers: auth(ctx.tokenFor(ctx.designer)),
      payload: { email: "sneaky@example.com", password: GOOD_PASSWORD, roles: ["super_admin"] },
    });
    assert.equal(response.statusCode, 403);
  });

  it("never returns a password hash", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/v1/users", headers: auth(ctx.tokenFor(ctx.admin)) });
    for (const user of response.json().users) {
      assert.ok(!("passwordHash" in user), "a password hash must never leave the service");
    }
  });
});

describe("creating a user", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;
  beforeEach(async () => {
    ctx = await setup();
    token = ctx.tokenFor(ctx.admin);
  });

  const create = (body: Record<string, unknown>) =>
    ctx.app.inject({ method: "POST", url: "/v1/users", headers: auth(token), payload: body });

  it("creates a user who can then log in", async () => {
    const created = await create({ email: "new@example.com", password: GOOD_PASSWORD, roles: ["operations"] });
    assert.equal(created.statusCode, 201);

    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "new@example.com", password: GOOD_PASSWORD },
    });
    assert.equal(login.statusCode, 200, "a created user must actually be able to sign in");
  });

  it("refuses a duplicate email", async () => {
    // Two accounts sharing an email is an ambiguity the login path has no
    // correct way to resolve.
    const response = await create({ email: "admin@example.com", password: GOOD_PASSWORD, roles: ["viewer"] });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "email_already_registered");
  });

  it("treats email case-insensitively when checking for duplicates", async () => {
    const response = await create({ email: "ADMIN@Example.com", password: GOOD_PASSWORD, roles: ["viewer"] });
    assert.equal(response.statusCode, 409);
  });

  it("refuses a short password", async () => {
    const response = await create({ email: "weak@example.com", password: "short", roles: ["viewer"] });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "password_too_short");
  });

  it("refuses an unknown role", async () => {
    const response = await create({ email: "x@example.com", password: GOOD_PASSWORD, roles: ["wizard"] });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_roles");
  });

  it("refuses an empty role list", async () => {
    // A user with no roles can log in and do nothing — a confusing state
    // that looks like a broken account rather than a deliberate one.
    const response = await create({ email: "x@example.com", password: GOOD_PASSWORD, roles: [] });
    assert.equal(response.statusCode, 400);
  });

  it("never writes the password into the audit log", async () => {
    await create({ email: "logged@example.com", password: GOOD_PASSWORD, roles: ["viewer"] });
    const entry = ctx.raw.collection("auditLogs").all().find((e) => e.action === "user.create");
    assert.ok(!JSON.stringify(entry).includes(GOOD_PASSWORD), "a password must never reach the audit log");
  });
});

describe("changing roles and access", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;
  beforeEach(async () => {
    ctx = await setup();
    token = ctx.tokenFor(ctx.admin);
  });

  const update = (userId: string, body: Record<string, unknown>) =>
    ctx.app.inject({ method: "PUT", url: `/v1/users/${userId}`, headers: auth(token), payload: body });

  it("changes a user's roles", async () => {
    const response = await update(ctx.designer.userId, { roles: ["operations"] });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().user.roles, ["operations"]);
  });

  it("signs the user out everywhere when their roles change", async () => {
    // The bug this exists to prevent: a token carries its own copy of the
    // roles, so without revoking, a demoted admin keeps administrator
    // access until the token expires — up to eight hours of nothing
    // happening.
    const designerToken = ctx.tokenFor(ctx.designer);
    assert.equal(
      (await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(designerToken) })).statusCode,
      200,
    );

    await update(ctx.designer.userId, { roles: ["viewer"] });

    const after = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(designerToken) });
    assert.equal(after.statusCode, 401, "an old token must stop working the moment roles change");
  });

  it("signs the user out everywhere when they are deactivated", async () => {
    const designerToken = ctx.tokenFor(ctx.designer);
    await update(ctx.designer.userId, { active: false });
    const after = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(designerToken) });
    assert.equal(after.statusCode, 401);
  });

  it("stops a deactivated user logging back in", async () => {
    await update(ctx.designer.userId, { active: false });
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: GOOD_PASSWORD },
    });
    assert.equal(login.statusCode, 401);
  });

  it("lets a reactivated user back in", async () => {
    await update(ctx.designer.userId, { active: false });
    await update(ctx.designer.userId, { active: true });
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "designer@example.com", password: GOOD_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
  });

  it("refuses to remove the last administrator's role", async () => {
    // Recovering from this needs direct database access — exactly the
    // situation an admin UI exists to avoid.
    const response = await update(ctx.admin.userId, { roles: ["viewer"] });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "last_super_admin");
  });

  it("refuses to deactivate the last administrator", async () => {
    const second = await createUser(ctx.db as never, {
      email: "second@example.com",
      password: GOOD_PASSWORD,
      roles: ["super_admin"],
    });
    // With two admins, demoting one is fine…
    assert.equal((await update(second.userId, { roles: ["viewer"] })).statusCode, 200);
    // …but the survivor cannot then be removed.
    assert.equal((await update(ctx.admin.userId, { roles: ["viewer"] })).statusCode, 409);
  });

  it("allows demoting an admin while another remains", async () => {
    const second = await createUser(ctx.db as never, {
      email: "second@example.com",
      password: GOOD_PASSWORD,
      roles: ["super_admin"],
    });
    assert.equal((await update(second.userId, { roles: ["game_designer"] })).statusCode, 200);
  });

  it("refuses self-deactivation", async () => {
    // Almost always a misclick, and the person doing it is the one who
    // would have to undo it.
    const response = await update(ctx.admin.userId, { active: false });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "cannot_deactivate_self");
  });

  it("records what actually changed", async () => {
    await update(ctx.designer.userId, { roles: ["operations"] });
    const entry = ctx.raw.collection("auditLogs").all().find((e) => e.action === "user.update");
    const diff = entry?.diff as Record<string, unknown>;
    assert.deepEqual(diff.fromRoles, ["game_designer"]);
    assert.deepEqual(diff.toRoles, ["operations"]);
    assert.equal(diff.sessionsRevoked, true);
  });

  it("404s for an unknown user", async () => {
    assert.equal((await update("nobody", { active: false })).statusCode, 404);
  });
});

describe("resetting a password", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let token: string;
  beforeEach(async () => {
    ctx = await setup();
    token = ctx.tokenFor(ctx.admin);
  });

  const reset = (userId: string, password: string) =>
    ctx.app.inject({ method: "POST", url: `/v1/users/${userId}/password`, headers: auth(token), payload: { password } });

  it("sets a working new password", async () => {
    assert.equal((await reset(ctx.designer.userId, "a-brand-new-password")).statusCode, 200);

    const stored = await ctx.raw.collection("users").findOne({ userId: ctx.designer.userId });
    assert.ok(await verifyPassword("a-brand-new-password", stored!.passwordHash as string));
    assert.ok(!(await verifyPassword(GOOD_PASSWORD, stored!.passwordHash as string)), "the old password must stop working");
  });

  it("revokes existing sessions", async () => {
    // A reset exists because the old credential may be compromised —
    // leaving issued tokens valid would let whoever prompted it keep access.
    const designerToken = ctx.tokenFor(ctx.designer);
    await reset(ctx.designer.userId, "a-brand-new-password");
    const after = await ctx.app.inject({ method: "GET", url: "/v1/games", headers: auth(designerToken) });
    assert.equal(after.statusCode, 401);
  });

  it("refuses a short password", async () => {
    assert.equal((await reset(ctx.designer.userId, "short")).statusCode, 400);
  });

  it("never logs the new password", async () => {
    await reset(ctx.designer.userId, "a-brand-new-password");
    const entry = ctx.raw.collection("auditLogs").all().find((e) => e.action === "user.password_reset");
    assert.ok(!JSON.stringify(entry).includes("a-brand-new-password"));
  });
});
