#!/usr/bin/env node
/**
 * The operator integration, end to end, over real HTTP against the running
 * stack.
 *
 * **Why this exists when `app.test.ts` already covers the same routes.**
 * That suite drives the app through `app.inject()`, which is an in-process
 * call: it never serialises a request through an HTTP client, never crosses
 * a socket, and never involves the container's own JSON handling. F25 lived
 * exactly in that gap one layer up — a bug in what `JSON.stringify` does to
 * `undefined`, invisible to every test that did not cross a wire — and the
 * whole HMAC design here depends on the bytes an operator sends being the
 * bytes the server verifies. Only a real request establishes that.
 *
 * It also verifies the one claim the unit suite is structurally unable to
 * make: that a launch token minted by this service is accepted by
 * game-socket, which is a different process holding a different copy of the
 * shared secret.
 *
 * Run against a started stack:
 *   docker compose -f infra/docker-compose.yml up -d
 *   npm run e2e:operator
 */

import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { WebSocket } from "ws";

const INTEGRATION_URL = process.env.INTEGRATION_API_URL ?? "http://localhost:9107";
const SOCKET_URL = process.env.GAME_SOCKET_URL ?? "ws://localhost:9103";
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27018/?directConnection=true";
const MONGO_DB = process.env.MONGO_DB ?? "slots_engine";
const ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY;

/** The game the stack seeds on boot. */
const GAME_ID = process.env.E2E_GAME_ID ?? "reference-5x3";

let failures = 0;
let checks = 0;

function check(claim, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ok   ${claim}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${claim}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}

/** Mirrors packages/secrets. Duplicated deliberately: this script stands in
 * for an operator's own tooling plus the backoffice's write path, and
 * importing our implementation would let a bug in it cancel itself out. */
function encryptSecret(plaintext, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Signs and sends exactly as a third-party integrator would — building the
 * canonical string from the literal body bytes, not from a parsed object.
 */
async function operatorRequest({ method, url, body, apiKeyId, apiSecret, rawBodyOverride }) {
  const timestamp = Date.now().toString();
  const rawBody = rawBodyOverride ?? (body !== undefined ? JSON.stringify(body) : "");
  const canonical = `${timestamp}.${method.toUpperCase()}.${url}.${rawBody}`;
  const signature = createHmac("sha256", apiSecret).update(canonical).digest("hex");

  const response = await fetch(`${INTEGRATION_URL}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key-id": apiKeyId,
      "x-timestamp": timestamp,
      "x-signature": signature,
    },
    body: rawBody.length > 0 ? rawBody : undefined,
  });

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function main() {
  if (!ENCRYPTION_KEY) {
    console.error("SECRETS_ENCRYPTION_KEY must be set — it must match the value integration-api is running with.");
    console.error("  export $(grep SECRETS_ENCRYPTION_KEY infra/.env | xargs)");
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(MONGO_DB);

  // Provision an operator the way the backoffice would: secret encrypted at
  // rest, never stored in the clear.
  const operatorId = `e2e-op-${randomUUID().slice(0, 8)}`;
  const apiKeyId = `e2e-key-${randomUUID().slice(0, 8)}`;
  const apiSecret = randomUUID();
  const playerId = `e2e-player-${randomUUID().slice(0, 8)}`;

  await db.collection("operators").insertOne({
    operatorId,
    name: "E2E Operator",
    integrationType: "direct",
    apiKeyId,
    apiSecret: encryptSecret(apiSecret, ENCRYPTION_KEY),
    enabledGameIds: [GAME_ID],
    createdAt: new Date().toISOString(),
  });

  const call = (options) => operatorRequest({ ...options, apiKeyId, apiSecret });

  try {
    console.log(`\nOperator flow against ${INTEGRATION_URL}\n`);

    console.log("health");
    const health = await fetch(`${INTEGRATION_URL}/health/ready`);
    check("readiness answers without a credential", health.status, 200);

    console.log("\nauthentication over a real wire");
    const unsigned = await fetch(`${INTEGRATION_URL}/v1/games`);
    check("an unsigned request is refused", unsigned.status, 401);

    const wrongSecret = await operatorRequest({
      method: "GET",
      url: "/v1/games",
      apiKeyId,
      apiSecret: "not-the-secret",
    });
    check("a wrongly-signed request is refused", wrongSecret.status, 401);
    check("  and says why", wrongSecret.body.error, "bad_signature");

    console.log("\nthe catalogue");
    const games = await call({ method: "GET", url: "/v1/games" });
    check("lists the entitled game", games.status, 200);
    check("  exactly one", games.body.games.map((g) => g.gameId), [GAME_ID]);

    console.log("\nthe money path, over HTTP");
    const transactionId = randomUUID();
    const cashIn = await call({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId, playerId, amount: 50_000 },
    });
    check("cash-in credits a new player", cashIn.status, 200);
    check("  with exactly the credited amount", cashIn.body.balance, 50_000);

    // The property no in-process test can establish: a retry that crosses a
    // real HTTP boundary, serialised independently, still lands on the same
    // idempotency key.
    const retry = await call({
      method: "POST",
      url: "/v1/wallet/cash-in",
      body: { transactionId, playerId, amount: 50_000 },
    });
    check("a retry over a fresh connection is absorbed", retry.body.balance, 50_000);
    check("  and reports that it was", retry.body.alreadyProcessed, true);

    // A body no `JSON.stringify` would produce: whitespace and key order
    // chosen by hand, exactly as a Go or Java client might emit. If the
    // server verified against a re-serialisation rather than the received
    // bytes, this is the request that fails.
    const handFormatted = `{"amount": 2500,\n  "playerId": "${playerId}",\n  "transactionId": "${randomUUID()}"}`;
    const oddBody = await call({ method: "POST", url: "/v1/wallet/cash-in", rawBodyOverride: handFormatted });
    check("a hand-formatted body verifies against the exact bytes sent", oddBody.status, 200);
    check("  and credits on top of the balance", oddBody.body.balance, 52_500);

    const overdraw = await call({
      method: "POST",
      url: "/v1/wallet/cash-out",
      body: { transactionId: randomUUID(), playerId, amount: 999_999 },
    });
    check("an overdraw is refused", overdraw.status, 402);

    const balance = await call({ method: "GET", url: `/v1/wallet/balance?playerId=${playerId}` });
    check("and the balance is untouched", balance.body.balance, 52_500);

    console.log("\nreplay protection");
    // Byte-identical replay, which needs the same timestamp and signature —
    // so it is built by hand rather than through the helper.
    const replayTimestamp = Date.now().toString();
    const replayUrl = "/v1/games";
    const replaySignature = createHmac("sha256", apiSecret)
      .update(`${replayTimestamp}.GET.${replayUrl}.`)
      .digest("hex");
    const replayHeaders = {
      "content-type": "application/json",
      "x-api-key-id": apiKeyId,
      "x-timestamp": replayTimestamp,
      "x-signature": replaySignature,
    };

    const firstUse = await fetch(`${INTEGRATION_URL}${replayUrl}`, { headers: replayHeaders });
    check("the first use of a signature succeeds", firstUse.status, 200);
    const replayed = await fetch(`${INTEGRATION_URL}${replayUrl}`, { headers: replayHeaders });
    check("replaying it is refused", replayed.status, 401);
    check("  as a replay, specifically", (await replayed.json()).error, "replayed_request");

    console.log("\nlaunch, and the handoff to game-socket");
    const launch = await call({
      method: "POST",
      url: "/v1/launch",
      body: { playerId, gameId: GAME_ID },
    });
    check("a launch is issued", launch.status, 200);
    check("  with a URL pointing at the game frontend", launch.body.launchUrl.includes("/?token="), true);

    // The claim this script exists to make that no unit test can: the token
    // this service minted is accepted by a DIFFERENT PROCESS holding its own
    // copy of the shared secret. A mismatch here is invisible to every test
    // in the repo and fatal to every real player.
    const joined = await joinSocket(launch.body.token);
    check("game-socket accepts the token this service minted", joined.type, "JOINED");
    check("  and resolves the player from it", joined.playerId, playerId);

    // Single-use is enforced by game-backend, across yet another process
    // boundary.
    const secondJoin = await joinSocket(launch.body.token);
    check("the same launch token cannot be used twice", secondJoin.type, "ERROR");
    check("  and says it was already used", secondJoin.code, "token_already_used");
  } finally {
    await db.collection("operators").deleteOne({ operatorId });
    await db.collection("players").deleteMany({ operatorId });
    await db.collection("transactions").deleteMany({ operatorId });
    await db.collection("usedRequestSignatures").deleteMany({ operatorId });
    await client.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nThis establishes the operator path over a real wire and across three processes.");
  console.log("It does NOT establish behaviour under concurrency — see npm run e2e:load.");
}

/** Opens a socket, sends JOIN, resolves on the first reply. */
function joinSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SOCKET_URL, { origin: "http://localhost:9104" });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for a JOIN reply"));
    }, 10_000);

    ws.on("open", () => ws.send(JSON.stringify({ type: "JOIN", token })));
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(data.toString()));
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error("\nthe operator flow could not complete:", err.message);
  process.exit(1);
});
