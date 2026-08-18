import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import type { FastifyInstance } from "fastify";

// Set before any import that reads them. ESM hoists imports above
// statements, so these cannot be assigned inside a `before()` hook — the
// modules would capture the unset value first. Same hazard, and the same
// fix, as the DOM-installation ordering documented in the frontend's test
// setup.
process.env.SECRETS_ENCRYPTION_KEY ??= "b".repeat(64);
process.env.LAUNCH_TOKEN_SECRET ??= "c".repeat(64);

const { encryptSecret } = await import("@slots-engine/secrets");
const { verifyLaunchToken } = await import("@slots-engine/launch-token");
const { applySchemas } = await import("@slots-engine/mongo-schemas");
const { createLogger } = await import("@slots-engine/logging");
const { buildApp } = await import("./app.js");
const { canonicalRequest, computeSignature } = await import("./auth/hmac.js");

/**
 * The integration API against a real MongoDB.
 *
 * **Why real Mongo and not `fakeMongo`.** Two of the things this file
 * asserts are properties of the *database*, not of this code: the replay
 * guard is a unique index raising 11000 (there is no application-level
 * check to test — that is the design), and the wallet routes run inside a
 * real multi-document transaction. The in-memory stand-in models neither a
 * schema validator nor a rollback, and has hidden real bugs in this
 * codebase twice (F1, F9). A money path is not verified here until it has
 * run against the live services.
 *
 * What this suite still cannot establish:
 *
 *   - **It does not cross a process boundary.** `app.inject()` is an
 *     in-process call, so it does not model what a real HTTP client and a
 *     proxy do to a request. F25 was exactly this gap one layer up — a bug
 *     living in what `JSON.stringify` does to `undefined`, invisible to
 *     every test that did not cross a wire. The signing here does build the
 *     canonical string from a serialised body, which covers the specific
 *     hazard that matters most for HMAC, but "the bytes Fastify received"
 *     and "the bytes an operator's HTTP client sent" are only assumed
 *     equal. `scripts/e2e/operator-flow-check.mjs` is what actually
 *     establishes it.
 *   - **It does not establish the rate limiter's behaviour.** Configured in
 *     `app.ts` and exercised by the e2e script; asserting a 429 here would
 *     mean firing 300 requests per test run for a property that is
 *     `@fastify/rate-limit`'s, not ours.
 *   - **It cannot prove the absence of a timing side channel** in signature
 *     comparison. See the note in `hmac.test.ts`.
 *
 * Skips when Mongo is unreachable, so a laptop without Docker and the unit
 * CI job still pass; the e2e job runs it for real.
 */

const MONGO_URI = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";

let client: MongoClient | undefined;
let db: Db;
let app: FastifyInstance;
let skipReason = "";

const OPERATOR_ID = "op-integration-test";
const API_KEY_ID = "test-key-id";
const API_SECRET = "test-operator-secret-not-for-production";

/** A second operator, so every isolation claim is tested against a real
 * neighbour rather than against an absence. */
const OTHER_OPERATOR_ID = "op-integration-other";
const OTHER_API_KEY_ID = "other-key-id";
const OTHER_API_SECRET = "other-operator-secret";

const ENABLED_GAME = "integration-test-game";
const PUBLISHED_BUT_NOT_ENABLED_GAME = "integration-test-game-unentitled";
const DRAFT_GAME = "integration-test-game-draft";

before(async () => {
  try {
    client = new MongoClient(MONGO_URI, {
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000,
    });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    skipReason = `no usable MongoDB at ${MONGO_URI} (${(err as Error).message.split("\n")[0]})`;
    client = undefined;
    return;
  }

  db = client.db(`integration_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  await applySchemas(db);

  await db.collection("operators").insertMany([
    {
      operatorId: OPERATOR_ID,
      name: "Integration Test Operator",
      integrationType: "direct",
      apiKeyId: API_KEY_ID,
      // Stored encrypted, exactly as the backoffice would write it — a
      // plaintext secret here would be refused by `findOperatorByKeyId`,
      // which is itself one of the properties under test.
      apiSecret: encryptSecret(API_SECRET),
      enabledGameIds: [ENABLED_GAME, DRAFT_GAME],
      createdAt: new Date().toISOString(),
    },
    {
      operatorId: OTHER_OPERATOR_ID,
      name: "Other Operator",
      integrationType: "direct",
      apiKeyId: OTHER_API_KEY_ID,
      apiSecret: encryptSecret(OTHER_API_SECRET),
      enabledGameIds: [PUBLISHED_BUT_NOT_ENABLED_GAME],
      createdAt: new Date().toISOString(),
    },
  ]);

  await db.collection("games").insertMany([
    { gameId: ENABLED_GAME, name: "Enabled Game", version: 1, status: "published" },
    { gameId: PUBLISHED_BUT_NOT_ENABLED_GAME, name: "Someone Else's Game", version: 1, status: "published" },
    { gameId: DRAFT_GAME, name: "Draft Game", version: 1, status: "draft" },
  ]);

  app = await buildApp({
    db,
    client,
    logger: createLogger("integration-api-test"),
    // High enough that no test trips it — the limiter is not what this
    // suite is establishing, and a test failing because a *sibling* test
    // used up a shared bucket is the kind of flake that gets suites
    // disabled.
    rateLimitMax: 100_000,
    gameFrontendUrl: "http://localhost:9104",
  });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (client) {
    await db.dropDatabase().catch(() => {});
    await client.close().catch(() => {});
  }
});

interface SignedRequestOptions {
  method: "GET" | "POST" | "PUT";
  url: string;
  body?: unknown;
  apiKeyId?: string;
  secret?: string;
  timestamp?: string;
  signature?: string;
  omitHeaders?: boolean;
}

/**
 * Signs and sends a request the way an operator's client would.
 *
 * The body is serialised *once* and both signed and sent — never
 * serialised twice — because `JSON.stringify` is not guaranteed to produce
 * identical output for the same object across calls, and a helper that
 * signs one string and sends another would test a request no operator
 * could construct.
 */
function signedRequest(options: SignedRequestOptions) {
  const { method, url, body, apiKeyId = API_KEY_ID, secret = API_SECRET, omitHeaders } = options;
  const timestamp = options.timestamp ?? Date.now().toString();
  const rawBody = body !== undefined ? JSON.stringify(body) : "";
  const signature = options.signature ?? computeSignature(secret, canonicalRequest(timestamp, method, url, rawBody));

  return app.inject({
    method,
    url,
    payload: rawBody.length > 0 ? rawBody : undefined,
    headers: omitHeaders
      ? { "content-type": "application/json" }
      : {
          "content-type": "application/json",
          "x-api-key-id": apiKeyId,
          "x-timestamp": timestamp,
          "x-signature": signature,
        },
  });
}

describe("authentication", () => {
  it("refuses a request carrying no auth headers", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({ method: "GET", url: "/v1/games", omitHeaders: true });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "missing_auth_headers");
  });

  it("refuses a request signed with the wrong secret", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({ method: "GET", url: "/v1/games", secret: "not-the-right-secret" });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "bad_signature");
  });

  it("refuses an unknown api key without revealing that it is unknown", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({ method: "GET", url: "/v1/games", apiKeyId: "no-such-key" });

    assert.equal(response.statusCode, 401);
    // Deliberately the same code a bad signature produces. Distinguishing
    // them would let anyone enumerate valid apiKeyIds by watching the error
    // change.
    assert.equal(response.json().error, "unknown_api_key");
  });

  it("refuses a timestamp outside the skew window, in both directions", async function () {
    if (!client) return this.skip(skipReason);

    const stale = await signedRequest({
      method: "GET",
      url: "/v1/games",
      timestamp: (Date.now() - 10 * 60 * 1000).toString(),
    });
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.json().error, "timestamp_out_of_range");

    // The future direction matters too: without it, a captured request
    // could be given a far-future timestamp and replayed indefinitely.
    const future = await signedRequest({
      method: "GET",
      url: "/v1/games",
      timestamp: (Date.now() + 10 * 60 * 1000).toString(),
    });
    assert.equal(future.statusCode, 401);
    assert.equal(future.json().error, "timestamp_out_of_range");
  });

  it("refuses a non-numeric timestamp rather than treating it as zero", async function () {
    if (!client) return this.skip(skipReason);

    // `Number("banana")` is NaN, and every comparison against NaN is false
    // — so a naive `Math.abs(now - ts) > SKEW` check *passes* for garbage
    // input. `Number.isFinite` is what closes that.
    const response = await signedRequest({ method: "GET", url: "/v1/games", timestamp: "banana" });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "timestamp_out_of_range");
  });

  it("refuses a replay of a request it has already accepted", async function () {
    if (!client) return this.skip(skipReason);

    // Replaying byte-for-byte: same timestamp, same signature. This is the
    // captured-request attack, and without the nonce table the second call
    // would succeed exactly as the first did.
    const timestamp = Date.now().toString();
    const url = "/v1/games";
    const signature = computeSignature(API_SECRET, canonicalRequest(timestamp, "GET", url, ""));

    const first = await signedRequest({ method: "GET", url, timestamp, signature });
    assert.equal(first.statusCode, 200, "the first use must succeed");

    const replay = await signedRequest({ method: "GET", url, timestamp, signature });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error, "replayed_request");
  });

  it("does not record a nonce for a request whose signature failed", async function () {
    if (!client) return this.skip(skipReason);

    // The ordering property. If the nonce were recorded before the
    // signature check, anyone could pre-burn a legitimate operator's
    // signature — send it with a corrupted body, then watch the real
    // request be refused as a replay. An unverified request must not be
    // able to touch state at all.
    const timestamp = Date.now().toString();
    const url = "/v1/games";
    const signature = computeSignature(API_SECRET, canonicalRequest(timestamp, "GET", url, ""));

    const forged = await signedRequest({ method: "GET", url, timestamp, signature, apiKeyId: OTHER_API_KEY_ID });
    assert.equal(forged.statusCode, 401, "a signature valid for one operator must not authenticate another");

    const genuine = await signedRequest({ method: "GET", url, timestamp, signature });
    assert.equal(genuine.statusCode, 200, "the real request must still work — its signature was not burned");
  });

  it("refuses an operator whose stored secret is not encrypted, rather than using it", async function () {
    if (!client) return this.skip(skipReason);

    // A half-migrated collection must fail loudly. The dangerous
    // alternative — treating a plaintext value as the secret — would let
    // unencrypted rows keep authenticating, and nothing would ever report
    // them.
    const plaintextKeyId = "plaintext-key";
    await db.collection("operators").insertOne({
      operatorId: "op-plaintext",
      name: "Legacy Operator",
      integrationType: "direct",
      apiKeyId: plaintextKeyId,
      apiSecret: "stored-in-the-clear",
      enabledGameIds: [],
      createdAt: new Date().toISOString(),
    });

    const response = await signedRequest({
      method: "GET",
      url: "/v1/games",
      apiKeyId: plaintextKeyId,
      secret: "stored-in-the-clear",
    });

    // 401, not 500: from the operator's side the credential does not work,
    // and the internal detail belongs in our logs.
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "unknown_api_key");
  });

  it("refuses a disabled operator with a distinguishable error", async function () {
    if (!client) return this.skip(skipReason);

    const disabledKeyId = "disabled-key";
    await db.collection("operators").insertOne({
      operatorId: "op-disabled",
      name: "Suspended Operator",
      integrationType: "direct",
      apiKeyId: disabledKeyId,
      apiSecret: encryptSecret("disabled-secret"),
      enabledGameIds: [],
      createdAt: new Date().toISOString(),
      disabledAt: new Date().toISOString(),
    });

    const response = await signedRequest({
      method: "GET",
      url: "/v1/games",
      apiKeyId: disabledKeyId,
      secret: "disabled-secret",
    });

    // Only reachable by someone holding a valid credential, so it leaks
    // nothing to a prober — and "access withdrawn" is genuinely different
    // information from "credential wrong" to the operator debugging it.
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "operator_disabled");
  });

  it("verifies against the exact bytes received, not a re-serialisation of them", async function () {
    if (!client) return this.skip(skipReason);

    // Found by mutation testing, and the mutation that exposed it survived
    // every other test in this file.
    //
    // Replacing `rawBody` with `JSON.stringify(JSON.parse(rawBody))` is
    // invisible to `signedRequest`, because a body that helper produced was
    // itself made by `JSON.stringify` and therefore round-trips
    // byte-identically. Real operator clients do not oblige: they
    // pretty-print, they order keys as their struct declares them, they
    // format numbers their own way. Any of those makes the re-serialised
    // form differ from the signed bytes, and every request from that
    // operator fails with `bad_signature` for a reason no log explains.
    //
    // So the body here is written by hand — extra whitespace, keys in a
    // non-alphabetical order — and signed as the literal string it is.
    const playerId = randomUUID();
    const rawBody = `{"amount": 3000,\n  "playerId": "${playerId}",\n  "transactionId": "${randomUUID()}"}`;
    assert.notEqual(rawBody, JSON.stringify(JSON.parse(rawBody)), "the premise: this body does not survive a round trip");

    const timestamp = Date.now().toString();
    const url = "/v1/wallet/cash-in";
    const response = await app.inject({
      method: "POST",
      url,
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        "x-api-key-id": API_KEY_ID,
        "x-timestamp": timestamp,
        "x-signature": computeSignature(API_SECRET, canonicalRequest(timestamp, "POST", url, rawBody)),
      },
    });

    assert.equal(response.statusCode, 200, "a correctly-signed hand-formatted body must verify");
    assert.equal(response.json().balance, 3000);
  });

  it("accepts a signature presented in uppercase hex", async function () {
    if (!client) return this.skip(skipReason);

    // Also found by mutation testing: replacing the constant-time byte
    // comparison with `===` on the hex strings survived every other test
    // here, because nothing sent a signature that differed only in case.
    //
    // Hex case carries no meaning, and some HMAC libraries emit uppercase.
    // An operator using one of those would be unable to authenticate at
    // all, which is a compatibility bug — but the reason to pin it is that
    // this test now fails if anyone replaces the byte comparison with a
    // string one, which is the change that would quietly reintroduce the
    // timing side channel.
    const timestamp = Date.now().toString();
    const url = "/v1/games";
    const signature = computeSignature(API_SECRET, canonicalRequest(timestamp, "GET", url, ""));

    const response = await app.inject({
      method: "GET",
      url,
      headers: {
        "content-type": "application/json",
        "x-api-key-id": API_KEY_ID,
        "x-timestamp": timestamp,
        "x-signature": signature.toUpperCase(),
      },
    });

    assert.equal(response.statusCode, 200);
  });

  it("leaves health reachable without credentials, in both forms", async function () {
    if (!client) return this.skip(skipReason);

    // `/health/ready` matters as much as `/health`: a probe cannot hold an
    // operator credential, and a 401 reads to an orchestrator as an
    // instance that is permanently unready.
    const live = await app.inject({ method: "GET", url: "/health" });
    assert.equal(live.statusCode, 200);

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, "ready");
  });
});

describe("the money path", () => {
  it("credits a brand-new player and absorbs the retry rather than paying twice", async function () {
    if (!client) return this.skip(skipReason);

    const playerId = randomUUID();
    const transactionId = randomUUID();
    const body = { transactionId, playerId, amount: 5_000 };

    const first = await signedRequest({ method: "POST", url: "/v1/wallet/cash-in", body });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().balance, 5_000, "a first cash-in creates the player with exactly the credited amount");
    assert.equal(first.json().alreadyProcessed, false);

    // The retry carries the same transactionId, which is the whole contract
    // an operator relies on: they may retry a timed-out call without
    // knowing whether the first one landed.
    const retry = await signedRequest({ method: "POST", url: "/v1/wallet/cash-in", body });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().balance, 5_000, "the retry must not credit a second time");
    assert.equal(retry.json().alreadyProcessed, true, "and must say that it was absorbed");
  });

  it("refuses to overdraw, leaving the balance untouched", async function () {
    if (!client) return this.skip(skipReason);

    const playerId = randomUUID();
    await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId: randomUUID(), playerId, amount: 1_000 },
    });

    const overdraw = await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-out",
      body: { transactionId: randomUUID(), playerId, amount: 5_000 },
    });

    // 402, not 400: the request is well-formed and correctly
    // authenticated. Nothing about it should change on a retry except the
    // balance.
    assert.equal(overdraw.statusCode, 402);
    assert.equal(overdraw.json().error, "insufficient_funds");

    const balance = await signedRequest({ method: "GET", url: `/v1/wallet/balance?playerId=${playerId}` });
    assert.equal(balance.json().balance, 1_000, "a refused debit must not move money");
  });

  it("refuses a fractional amount with a 400 rather than a 500", async function () {
    if (!client) return this.skip(skipReason);

    // Money is always integer minor units. `applyLedgerOp` would also
    // refuse this, but by throwing — which reaches the operator as a 500
    // for what is an ordinary client mistake.
    const response = await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId: randomUUID(), playerId: randomUUID(), amount: 10.5 },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_request");
  });

  it("refuses a negative amount, so direction belongs to the route and not the sign", async function () {
    if (!client) return this.skip(skipReason);

    // A negative cash-in is a debit wearing the wrong route's name.
    const response = await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId: randomUUID(), playerId: randomUUID(), amount: -5_000 },
    });

    assert.equal(response.statusCode, 400);
  });

  it("keeps one operator's balance invisible to another", async function () {
    if (!client) return this.skip(skipReason);

    // The tenant boundary, tested against a real neighbour. Both operators
    // are asked about the *same* playerId — a collision that is entirely
    // possible, since playerIds are chosen by operators independently.
    const sharedPlayerId = randomUUID();

    await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId: randomUUID(), playerId: sharedPlayerId, amount: 7_777 },
    });

    const theirView = await signedRequest({
      method: "GET",
      url: `/v1/wallet/balance?playerId=${sharedPlayerId}`,
      apiKeyId: OTHER_API_KEY_ID,
      secret: OTHER_API_SECRET,
    });

    assert.equal(theirView.statusCode, 200);
    assert.equal(theirView.json().balance, 0, "the same playerId under a different operator is a different player");
  });

  it("reports an unknown player as zero rather than as missing", async function () {
    if (!client) return this.skip(skipReason);

    // "No player" and "no money" are the same answer to a caller — and a
    // 404 would confirm whether a given playerId exists under this
    // operator.
    const response = await signedRequest({ method: "GET", url: `/v1/wallet/balance?playerId=${randomUUID()}` });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().balance, 0);
  });

  it("returns only the requesting operator's transactions", async function () {
    if (!client) return this.skip(skipReason);

    const playerId = randomUUID();
    await signedRequest({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId: randomUUID(), playerId, amount: 2_500 },
    });

    const mine = await signedRequest({ method: "GET", url: `/v1/wallet/transactions?playerId=${playerId}` });
    assert.equal(mine.statusCode, 200);
    assert.equal(mine.json().transactions.length, 1);

    const theirs = await signedRequest({
      method: "GET",
      url: `/v1/wallet/transactions?playerId=${playerId}`,
      apiKeyId: OTHER_API_KEY_ID,
      secret: OTHER_API_SECRET,
    });
    assert.equal(theirs.json().transactions.length, 0, "operatorId is always in the filter, never optional");
  });

  it("requires a playerId or a roundId on a statement query", async function () {
    if (!client) return this.skip(skipReason);

    // Without this, the filter would be `{ operatorId }` alone — a dump of
    // every transaction the operator has ever had, capped only by the page
    // limit.
    const response = await signedRequest({ method: "GET", url: "/v1/wallet/transactions" });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "must_provide_playerId_or_roundId");
  });
});

describe("launch", () => {
  it("issues a token carrying the verified operator, not one the caller named", async function () {
    if (!client) return this.skip(skipReason);

    const playerId = randomUUID();
    const response = await signedRequest({
      method: "POST",
      url: "/v1/launch",
      // The hostile part: the body names a *different* operator. It must be
      // ignored entirely — this is the same property game-socket defends
      // one layer in ("a client can name a bet, never a player").
      body: { playerId, gameId: ENABLED_GAME, operatorId: OTHER_OPERATOR_ID },
    });

    assert.equal(response.statusCode, 200);

    const payload = verifyLaunchToken(response.json().token);
    assert.equal(payload.operatorId, OPERATOR_ID, "the operator must come from the signature, never from the body");
    assert.equal(payload.playerId, playerId);
    assert.equal(payload.gameId, ENABLED_GAME);
    assert.equal(payload.kind, "launch", "a launch must mint a single-use launch token, never a session token");
  });

  it("returns a launch URL carrying the token", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({
      method: "POST",
      url: "/v1/launch",
      body: { playerId: randomUUID(), gameId: ENABLED_GAME },
    });

    const { token, launchUrl, expiresAt } = response.json();
    assert.ok(launchUrl.startsWith("http://localhost:9104/?token="), "the frontend URL must be the configured one");
    assert.ok(launchUrl.includes(encodeURIComponent(token)));
    assert.ok(expiresAt > Date.now(), "an already-expired token would be useless");
  });

  it("refuses a game this operator is not entitled to, without confirming it exists", async function () {
    if (!client) return this.skip(skipReason);

    // The game IS published and IS launchable — by its own operator. The
    // entitlement check runs before the existence check precisely so that
    // a 404 cannot be used to enumerate the platform's catalogue.
    const response = await signedRequest({
      method: "POST",
      url: "/v1/launch",
      body: { playerId: randomUUID(), gameId: PUBLISHED_BUT_NOT_ENABLED_GAME },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "game_not_enabled_for_operator");
  });

  it("refuses to launch a draft game even for an entitled operator", async function () {
    if (!client) return this.skip(skipReason);

    // The operator IS entitled to this gameId — publishing is the separate
    // gate, and this is where it is enforced for a real player.
    const response = await signedRequest({
      method: "POST",
      url: "/v1/launch",
      body: { playerId: randomUUID(), gameId: DRAFT_GAME },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "game_not_found");
  });

  it("refuses a launch missing a playerId or gameId", async function () {
    if (!client) return this.skip(skipReason);

    const noPlayer = await signedRequest({ method: "POST", url: "/v1/launch", body: { gameId: ENABLED_GAME } });
    assert.equal(noPlayer.statusCode, 400);

    const noGame = await signedRequest({ method: "POST", url: "/v1/launch", body: { playerId: randomUUID() } });
    assert.equal(noGame.statusCode, 400);
  });
});

describe("the game catalogue", () => {
  it("lists exactly the games this operator could actually launch", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({ method: "GET", url: "/v1/games" });
    assert.equal(response.statusCode, 200);

    const listed = (response.json().games as { gameId: string }[]).map((g) => g.gameId);

    // The property that makes this route worth having: everything listed
    // here is something `/v1/launch` would accept. The draft is entitled
    // but unpublished, and the other operator's game is published but not
    // entitled — neither may appear.
    assert.deepEqual(listed, [ENABLED_GAME]);
  });

  it("returns an empty list for an operator entitled to nothing", async function () {
    if (!client) return this.skip(skipReason);

    const emptyKeyId = "empty-catalogue-key";
    await db.collection("operators").insertOne({
      operatorId: "op-empty",
      name: "New Operator",
      integrationType: "direct",
      apiKeyId: emptyKeyId,
      apiSecret: encryptSecret("empty-secret"),
      enabledGameIds: [],
      createdAt: new Date().toISOString(),
    });

    const response = await signedRequest({
      method: "GET",
      url: "/v1/games",
      apiKeyId: emptyKeyId,
      secret: "empty-secret",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().games, [], "an empty entitlement is not the same as no filter");
  });
});

describe("player protection limits", () => {
  const LIMITED_PLAYER = "limits-player-1";

  it("stores the limits an operator sets and reads them back", async function () {
    if (!client) return this.skip(skipReason);

    const limits = [
      { period: "daily", maxStake: 10_000, maxLoss: 5_000 },
      { period: "monthly", maxLoss: 50_000 },
    ];

    const put = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits },
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().limits, limits);

    const get = await signedRequest({
      method: "GET",
      url: `/v1/players/limits?playerId=${LIMITED_PLAYER}`,
    });
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.json().limits, limits);
  });

  it("replaces the whole set, so a tightened period takes hold immediately", async function () {
    if (!client) return this.skip(skipReason);

    // F26's shape on a document that decides whether someone may bet. A
    // `$set` would leave the monthly limit from the call above in place,
    // and the player would keep playing under a ceiling nobody can see in
    // the payload that supposedly replaced it.
    //
    // Both moves here are tightenings — daily 10,000 -> 200, and the
    // monthly ceiling removed... which is NOT a tightening. Dropping a
    // limit opens it to unlimited, so it is deferred, and the assertion
    // below says so. That is the cooling-off rule, not a `$set` leak: the
    // daily change is in force at once, which is what this test is about.
    const put = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits: [{ period: "daily", maxStake: 200 }] },
    });
    assert.equal(put.statusCode, 200);

    const get = await signedRequest({ method: "GET", url: `/v1/players/limits?playerId=${LIMITED_PLAYER}` });
    // Asserted on the field that moved, not on the whole row: the daily
    // `maxLoss` set earlier survives because *dropping* it is a loosening,
    // which is the rule working rather than a `$set` leak.
    assert.equal(
      get.json().limits.find((l: { period: string }) => l.period === "daily")?.maxStake,
      200,
      "the tightened daily ceiling replaced the old one rather than merging with it",
    );
  });

  it("expresses clearing every limit as a pending change, not an instant one", async function () {
    if (!client) return this.skip(skipReason);

    // Removal has to be expressible — a player who lowered their own
    // ceiling must be able to raise it back. But clearing every protection
    // is the largest possible loosening, so it waits out the delay like
    // any other. Applying it immediately would make the whole control
    // defeatable by one request.
    const put = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits: [] },
    });
    assert.equal(put.statusCode, 200);
    assert.ok(put.json().pending, "the clearance is recorded as waiting");
    assert.deepEqual(put.json().pending.limits, []);

    const get = await signedRequest({ method: "GET", url: `/v1/players/limits?playerId=${LIMITED_PLAYER}` });
    assert.ok(get.json().limits.length > 0, "and the existing ceilings still apply until it matures");
  });

  it("answers 200 with no limits for an unknown player, not 404", async function () {
    if (!client) return this.skip(skipReason);

    // A 404 would confirm which player ids exist to a caller enumerating
    // them — the same disclosure rule the balance route follows.
    const get = await signedRequest({ method: "GET", url: "/v1/players/limits?playerId=never-seen-before" });
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.json().limits, []);
  });

  it("keeps one operator's limits invisible to another", async function () {
    if (!client) return this.skip(skipReason);

    await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: "shared-id", limits: [{ period: "daily", maxStake: 999 }] },
    });

    // Same player id, different operator. A player id is only unique within
    // one operator, so reading across the boundary would leak — and worse,
    // writing across it would let one operator lift another's limits.
    const other = await signedRequest({
      method: "GET",
      url: "/v1/players/limits?playerId=shared-id",
      apiKeyId: OTHER_API_KEY_ID,
      secret: OTHER_API_SECRET,
    });
    assert.equal(other.statusCode, 200);
    assert.deepEqual(other.json().limits, [], "another operator must not see these limits");
  });

  it("refuses a fractional or negative ceiling rather than storing nonsense", async function () {
    if (!client) return this.skip(skipReason);

    // A negative maxStake refuses every bet forever, which looks identical
    // to a self-exclusion and is not one. A fractional one is not money.
    for (const bad of [{ period: "daily", maxStake: 10.5 }, { period: "daily", maxLoss: -1 }]) {
      const response = await signedRequest({
        method: "PUT",
        url: "/v1/players/limits",
        body: { playerId: LIMITED_PLAYER, limits: [bad] },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(bad));
      assert.equal(response.json().error, "invalid_amount");
    }
  });

  it("refuses an unknown period, naming the field", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits: [{ period: "hourly", maxStake: 100 }] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_period");
  });

  it("refuses two entries for one period rather than silently picking one", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: {
        playerId: LIMITED_PLAYER,
        limits: [{ period: "daily", maxStake: 100 }, { period: "daily", maxStake: 900 }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "duplicate_period");
  });

  it("refuses a period that names no ceiling at all", async function () {
    if (!client) return this.skip(skipReason);

    // Almost always a misspelled field name. Storing it would store nothing
    // while reporting success.
    const response = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits: [{ period: "daily", maxSteak: 100 }] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "empty_limit");
  });

  it("requires authentication like every other operator route", async function () {
    if (!client) return this.skip(skipReason);

    const response = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: LIMITED_PLAYER, limits: [] },
      omitHeaders: true,
    });
    assert.equal(response.statusCode, 401);
  });
});

describe("raising a limit waits, lowering one does not", () => {
  const COOLING = "cooling-off-player";

  const setLimits = (playerId: string, limits: unknown) =>
    signedRequest({ method: "PUT", url: "/v1/players/limits", body: { playerId, limits } });

  it("applies a tightening at once, with nothing left pending", async function () {
    if (!client) return this.skip(skipReason);

    // Someone protecting themselves must not be made to wait. A delay on
    // this direction would be the control working against the person it
    // exists for.
    await setLimits(COOLING, [{ period: "daily", maxStake: 50_000 }]);
    const response = await setLimits(COOLING, [{ period: "daily", maxStake: 10_000 }]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().limits, [{ period: "daily", maxStake: 10_000 }]);
    assert.equal(response.json().pending, undefined, "a tightening waits for nothing");
  });

  it("holds a raise back and keeps the old ceiling in force", async function () {
    if (!client) return this.skip(skipReason);

    const response = await setLimits(COOLING, [{ period: "daily", maxStake: 90_000 }]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().limits,
      [{ period: "daily", maxStake: 10_000 }],
      "the player is still held to the lower ceiling",
    );
    assert.ok(response.json().pending, "and the raise is recorded as waiting");
    assert.deepEqual(response.json().pending.limits, [{ period: "daily", maxStake: 90_000 }]);
  });

  it("dates the raise 24 hours out", async function () {
    if (!client) return this.skip(skipReason);

    const before = Date.now();
    const response = await setLimits(COOLING, [{ period: "daily", maxStake: 95_000 }]);
    const { effectiveAt, requestedAt } = response.json().pending;

    assert.ok(requestedAt >= before, "requested now");
    assert.equal(effectiveAt - requestedAt, 24 * 60 * 60 * 1000);
  });

  it("treats removing a limit as a raise, not as an instant clearance", async function () {
    if (!client) return this.skip(skipReason);

    // The most dangerous path: clearing every protection is the largest
    // possible loosening, and a reading that let it through immediately
    // would make the whole delay pointless.
    const response = await setLimits(COOLING, []);

    assert.deepEqual(
      response.json().limits,
      [{ period: "daily", maxStake: 10_000 }],
      "the existing ceiling survives a request to drop it",
    );
    assert.ok(response.json().pending, "the removal is pending like any other loosening");
    assert.deepEqual(response.json().pending.limits, []);
  });

  it("applies the tightening and defers the raise when one call does both", async function () {
    if (!client) return this.skip(skipReason);

    // Refusing the whole request would teach a player not to tighten.
    const response = await setLimits(COOLING, [
      { period: "daily", maxStake: 1_000 },
      { period: "monthly", maxLoss: 500_000 },
    ]);

    const applied = response.json().limits;
    assert.deepEqual(
      applied.find((l: { period: string }) => l.period === "daily"),
      { period: "daily", maxStake: 1_000 },
      "the tightening is in force now",
    );
    // The monthly ceiling applies too, and that is correct rather than a
    // leak: the player had no monthly limit, so adding one is a tightening
    // from unlimited. What is deferred is the *daily* removal implied by
    // dropping nothing here — see the pending set below.
    assert.deepEqual(
      applied.find((l: { period: string }) => l.period === "monthly"),
      { period: "monthly", maxLoss: 500_000 },
      "a first-ever monthly ceiling tightens from unlimited, so it is immediate",
    );
  });

  it("lets a later submission replace a pending raise", async function () {
    if (!client) return this.skip(skipReason);

    // A player who changes their mind must not be stuck with yesterday's
    // request maturing behind their back.
    //
    // Its own player, because the earlier tests left this one with a
    // monthly ceiling — and dropping that is itself a loosening, so a
    // shared fixture would leave a pending change for a reason unrelated
    // to what is being tested here. The first draft did exactly that and
    // failed for the wrong reason.
    const player = "cooling-off-rethink";
    await setLimits(player, [{ period: "daily", maxStake: 10_000 }]);
    await setLimits(player, [{ period: "daily", maxStake: 80_000 }]);

    const second = await setLimits(player, [{ period: "daily", maxStake: 500 }]);

    assert.equal(second.json().pending, undefined, "the pending raise is gone");
    assert.deepEqual(second.json().limits, [{ period: "daily", maxStake: 500 }]);
  });

  it("records the direction of every change in the audit log", async function () {
    if (!client) return this.skip(skipReason);

    // "Who changed this player's protection, when, and which way" is the
    // question a regulator asks, and nothing else in this system answers it.
    const entries = await db
      .collection("auditLogs")
      .find({ entityType: "player", entityId: COOLING })
      .sort({ timestamp: 1 })
      .toArray();

    assert.ok(entries.length > 0, "limit changes must be audited");
    assert.ok(
      entries.some((e) => e.action === "player.limits.loosen"),
      "a raise is recorded as a loosening",
    );
    assert.ok(
      entries.some((e) => e.action === "player.limits.tighten"),
      "and a lowering as a tightening",
    );
    assert.equal(entries[0]!.actorUserId, `operator:${OPERATOR_ID}`, "attributed to the operator that made it");
  });
});

describe("a raise that has already matured", () => {
  it("is not treated as a fresh loosening when the player next saves", async function () {
    if (!client) return this.skip(skipReason);

    // The gap a mutation exposed. Comparing a submission against the
    // *stored* set rather than what is actually in force means a raise the
    // player already waited 24 hours for is seen again as a raise — so
    // re-sending it restarts the clock, and the ceiling they are entitled
    // to never arrives. The player experiences a limit that can never be
    // lifted, and nothing errors.
    const player = "cooling-off-matured";

    await db.collection("playerLimits").insertOne({
      operatorId: OPERATOR_ID,
      playerId: player,
      limits: [{ period: "daily", maxStake: 1_000 }],
      pending: {
        limits: [{ period: "daily", maxStake: 9_000 }],
        effectiveAt: Date.now() - 1_000,
        requestedAt: Date.now() - 90_000_000,
      },
    });

    // Re-submitting exactly what has now come into force.
    const response = await signedRequest({
      method: "PUT",
      url: "/v1/players/limits",
      body: { playerId: player, limits: [{ period: "daily", maxStake: 9_000 }] },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().pending, undefined, "a matured raise re-sent is not a new raise");
    assert.deepEqual(response.json().limits, [{ period: "daily", maxStake: 9_000 }]);
  });
});
