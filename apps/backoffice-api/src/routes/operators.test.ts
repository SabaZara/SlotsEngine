// The suite drives many requests from one synthetic address; the limiter is
// a production concern and would only make this flaky.
process.env.DISABLE_RATE_LIMIT = "true";
// Set before any import that reads it — ESM hoists imports above statements,
// so a `before()` hook would run after @slots-engine/secrets was evaluated.
process.env.SECRETS_ENCRYPTION_KEY ??= "e".repeat(64);

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { createLogger } from "@slots-engine/logging";
import { decryptSecret, isEncrypted } from "@slots-engine/secrets";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import { buildApp } from "../app.js";
import { signSession } from "../auth/jwt.js";
import { createUser } from "../auth/users.js";

/**
 * Operator credential issuance — the operation that lets an outside company
 * move money through this platform.
 *
 * What this suite cannot establish, stated because every suite here with a
 * known blind spot says so:
 *
 *   - **`fakeMongo` models no unique index**, so the 409-on-duplicate path
 *     is tested here only through the explicit pre-check, not through the
 *     11000 race that is the real authority. The `operators` collection's
 *     unique indexes are pinned against real MongoDB in
 *     `packages/mongo-schemas/src/collections.test.ts` instead — that is
 *     where an index claim belongs, and F1 is why.
 *   - **It does not establish that a credential issued here actually
 *     authenticates.** That crosses two services and is the job of
 *     `npm run e2e:operator`, which creates an operator through this API
 *     and then signs a real request with the returned secret.
 */

before(() => {
  process.env.BACKOFFICE_JWT_SECRET = "a-test-secret-long-enough-to-pass-the-guard";
});

const logger = createLogger("operators-test");

async function setup() {
  const { db, raw } = fakeMongo();
  const app = await buildApp(db as never, logger);
  await app.ready();

  const admin = await createUser(db as never, {
    email: "admin@example.com",
    password: "a-long-enough-password",
    roles: ["super_admin"],
  });
  const ops = await createUser(db as never, {
    email: "ops@example.com",
    password: "a-long-enough-password",
    roles: ["operations"],
  });
  const viewer = await createUser(db as never, {
    email: "viewer@example.com",
    password: "a-long-enough-password",
    roles: ["viewer"],
  });
  const designer = await createUser(db as never, {
    email: "designer@example.com",
    password: "a-long-enough-password",
    roles: ["game_designer"],
  });

  const tokenFor = (user: { userId: string; email: string; roles: string[]; tokenVersion: number }) =>
    signSession({ userId: user.userId, email: user.email, roles: user.roles as never, tokenVersion: user.tokenVersion })
      .token;

  return { app, db, raw, admin, ops, viewer, designer, tokenFor };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const validBody = {
  operatorId: "acme-casino",
  name: "Acme Casino",
  integrationType: "direct" as const,
  enabledGameIds: ["reference-5x3"],
};

describe("who may manage operators", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("lets operations create an operator", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
    assert.equal(response.statusCode, 201);
  });

  it("refuses a game_designer, who has no business issuing money credentials", async () => {
    // The role split is the point: a designer can change what a game pays,
    // which is already sensitive, but issuing a credential to an outside
    // company is a different kind of authority.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.designer)),
      payload: validBody,
    });
    assert.equal(response.statusCode, 403);
  });

  it("refuses a viewer trying to create, while still letting them read", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.viewer)),
      payload: validBody,
    });
    assert.equal(create.statusCode, 403, "reading is not writing");

    const list = await ctx.app.inject({ method: "GET", url: "/v1/operators", headers: auth(ctx.tokenFor(ctx.viewer)) });
    assert.equal(list.statusCode, 200, "support staff legitimately need to see which operators exist");
  });

  it("refuses an unauthenticated request outright", async () => {
    const response = await ctx.app.inject({ method: "POST", url: "/v1/operators", payload: validBody });
    assert.equal(response.statusCode, 401);
  });

  it("refuses a designer trying to rotate a secret", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators/acme-casino/rotate-secret",
      headers: auth(ctx.tokenFor(ctx.designer)),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe("issuing a credential", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("returns the secret exactly once, and never again", async () => {
    // The whole UX rests on this: the created response carries the secret,
    // and no later read can recover it. A route that could return it again
    // is a route that leaks it from wherever it is re-read.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
    const { operator } = created.json();
    assert.ok(operator.apiSecret, "the create response must carry the secret");
    assert.equal(created.json().secretShownOnce, true, "and must flag that this is the only time");

    const fetched = await ctx.app.inject({
      method: "GET",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });
    assert.equal(fetched.json().operator.apiSecret, undefined, "a later read must not carry it");

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });
    assert.equal(listed.json().operators[0].apiSecret, undefined, "nor must the list");
  });

  it("stores the secret encrypted, never in the clear", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
    const issued = created.json().operator.apiSecret;

    const stored = ctx.raw.collection("operators").all()[0].apiSecret;
    assert.notEqual(stored, issued, "the stored form must not be the issued value");
    assert.equal(isEncrypted(stored), true, "and must be in the enc: form");
    assert.equal(decryptSecret(stored), issued, "decrypting it must give back what the operator was handed");
  });

  it("issues a different secret to every operator", async () => {
    // A fixed or derived secret would authenticate every operator as every
    // other. Cheap to assert, catastrophic to get wrong.
    const first = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { ...validBody, operatorId: "other-casino" },
    });

    assert.notEqual(first.json().operator.apiSecret, second.json().operator.apiSecret);
    assert.notEqual(first.json().operator.apiKeyId, second.json().operator.apiKeyId);
  });

  it("issues a secret long enough that guessing is not a strategy", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });

    // 32 bytes, hex-encoded.
    assert.match(created.json().operator.apiSecret, /^[0-9a-f]{64}$/);
  });

  it("records the issuance in the audit log without recording the secret", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });

    const entry = ctx.raw.collection("auditLogs").all().find((e: { action: string }) => e.action === "operator.create");
    assert.ok(entry, "issuing a credential must be audited");
    assert.equal(entry.entityId, "acme-casino");
    assert.equal(entry.actorUserId, ctx.ops.userId, "the audit names who did it");
    // The public half is recorded so a key seen in integration-api's logs
    // can be tied back to its issuance. The secret must not be.
    assert.ok(entry.diff.apiKeyId, "the key id is recorded");
    assert.equal(JSON.stringify(entry.diff).includes("apiSecret"), false, "the secret is not");
  });

  it("refuses a duplicate operatorId rather than issuing a second credential for it", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
    const again = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });

    assert.equal(again.statusCode, 409);
  });

  it("refuses an unknown integrationType instead of storing one nothing implements", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { ...validBody, integrationType: "sideways" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_integration_type");
  });

  it("refuses an enabledGameIds list that is not all strings", async () => {
    // `includes` compares by reference, so a non-string here would sit in
    // the entitlement list and silently never match — a game the operator
    // appears entitled to and can never launch.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { ...validBody, enabledGameIds: ["fine", { gameId: "not-a-string" }] },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_enabled_game_ids");
  });

  it("refuses a missing operatorId or name", async () => {
    const noId = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { ...validBody, operatorId: "   " },
    });
    assert.equal(noId.statusCode, 400);

    const noName = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { ...validBody, name: "" },
    });
    assert.equal(noName.statusCode, 400);
  });

  it("defaults a new operator to launching nothing", async () => {
    // The safe direction. An operator entitled to everything by default is
    // one nobody ever remembers to restrict.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { operatorId: "bare", name: "Bare", integrationType: "direct" },
    });

    assert.deepEqual(response.json().operator.enabledGameIds, []);
  });
});

describe("changing an operator", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
  });

  it("updates entitlement, which is how an operator gets a new game", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { enabledGameIds: ["reference-5x3", "free-spins-5x3"] },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().operator.enabledGameIds, ["reference-5x3", "free-spins-5x3"]);
  });

  it("disables an operator by recording when, not merely that", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { disabled: true },
    });

    assert.equal(response.statusCode, 200);
    // A timestamp rather than a boolean, so the record answers "when was
    // this withdrawn" — which is the question asked during an incident.
    assert.ok(response.json().operator.disabledAt, "disabling records a timestamp");
  });

  it("re-enables by removing the field rather than setting it false", async () => {
    // integration-api tests `operator.disabledAt` for truthiness. A `false`
    // or `null` left behind would read as enabled either way, but an absent
    // field is the shape the rest of this schema uses — and F17 is why the
    // difference between `$unset` and `$set: null` is worth pinning.
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { disabled: true },
    });
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { disabled: false },
    });

    assert.equal(response.json().operator.disabledAt, undefined, "the field must be gone, not falsy");
  });

  it("never lets an update change the credential", async () => {
    // Rotation is a separate route on purpose. An update that could also
    // rotate would let a rename invalidate a live credential.
    const before = ctx.raw.collection("operators").all()[0].apiSecret;
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { name: "Renamed", apiSecret: "attacker-chosen", apiKeyId: "attacker-chosen" },
    });

    assert.equal(ctx.raw.collection("operators").all()[0].apiSecret, before, "the secret must be untouched");
    assert.notEqual(ctx.raw.collection("operators").all()[0].apiKeyId, "attacker-chosen", "and so must the key id");
  });

  it("refuses an update naming an operator that does not exist", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/no-such-operator",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: { name: "Ghost" },
    });

    assert.equal(response.statusCode, 404);
  });

  it("refuses an empty update rather than reporting a change it did not make", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: {},
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "nothing_to_update");
  });
});

describe("rotating a secret", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators",
      headers: auth(ctx.tokenFor(ctx.ops)),
      payload: validBody,
    });
  });

  it("issues a new credential and invalidates the old one", async () => {
    // A rotation that leaves the old credential working is a file edit, not
    // a rotation — the same standard applied to the secrets rotated in
    // infra/.env on 2026-08-17.
    const originalSecret = decryptSecret(ctx.raw.collection("operators").all()[0].apiSecret);
    const originalKeyId = ctx.raw.collection("operators").all()[0].apiKeyId;

    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators/acme-casino/rotate-secret",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });

    assert.equal(response.statusCode, 200);
    const rotated = response.json().operator;
    assert.notEqual(rotated.apiSecret, originalSecret, "a new secret");
    assert.notEqual(rotated.apiKeyId, originalKeyId, "and a new key id, so a stale client is told it is unknown");
    assert.equal(decryptSecret(ctx.raw.collection("operators").all()[0].apiSecret), rotated.apiSecret, "the stored copy matches the new one");
  });

  it("shows the rotated secret once and stores it encrypted", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators/acme-casino/rotate-secret",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });

    assert.equal(response.json().secretShownOnce, true);
    assert.equal(isEncrypted(ctx.raw.collection("operators").all()[0].apiSecret), true);

    const fetched = await ctx.app.inject({
      method: "GET",
      url: "/v1/operators/acme-casino",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });
    assert.equal(fetched.json().operator.apiSecret, undefined, "and is not recoverable afterwards");
  });

  it("audits the rotation as its own action, distinct from an update", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/v1/operators/acme-casino/rotate-secret",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });

    const entry = ctx.raw.collection("auditLogs").all().find((e: { action: string }) => e.action === "operator.rotate_secret");
    assert.ok(entry, "rotation is its own audited action");
    assert.equal(JSON.stringify(entry.diff).includes("apiSecret"), false, "and still records no secret");
  });

  it("refuses to rotate an operator that does not exist", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/v1/operators/no-such-operator/rotate-secret",
      headers: auth(ctx.tokenFor(ctx.ops)),
    });

    assert.equal(response.statusCode, 404);
  });
});
