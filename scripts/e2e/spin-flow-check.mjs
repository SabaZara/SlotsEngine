#!/usr/bin/env node
/**
 * End-to-end check against RUNNING services — the honest test.
 *
 * Everything in `npm test` uses an in-memory database stand-in, which
 * cannot prove that transactions roll back, that unique indexes are
 * actually declared, or that the two services agree on how a request is
 * signed. This script exercises the real path a player takes:
 *
 *   sign a launch token -> JOIN over a websocket -> spin -> check the money
 *
 * Run with:  npm run e2e:spin
 * Requires:  docker compose -f infra/docker-compose.yml up
 */

import { WebSocket } from "ws";
import { createHmac, randomUUID } from "node:crypto";

const BACKEND = process.env.GAME_BACKEND_URL ?? "http://localhost:9002";
const SOCKET = process.env.GAME_SOCKET_URL ?? "ws://localhost:9003";
const LAUNCH_SECRET = process.env.LAUNCH_TOKEN_SECRET;
const GAME_ID = process.env.GAME_ID ?? "reference-5x3";

if (!LAUNCH_SECRET) {
  console.error("LAUNCH_TOKEN_SECRET must be set — it is what signs the launch token.");
  process.exit(1);
}

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Mirrors @slots-engine/launch-token's format, deliberately reimplemented
 * here: this script stands in for an operator's server, and an operator
 * integrates against the documented format, not against our package. */
function signLaunchToken({ operatorId, playerId, gameId }) {
  const now = Date.now();
  const payload = { kind: "launch", operatorId, playerId, gameId, jti: randomUUID(), iat: now, exp: now + 60_000 };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${createHmac("sha256", LAUNCH_SECRET).update(b64).digest("base64url")}`;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(SOCKET);
    const messages = [];
    const waiters = [];

    socket.on("open", () => socket.send(JSON.stringify({ type: "JOIN", token })));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      // Hand it straight to a waiter if one is already blocked on this
      // type; only buffer it when nobody is waiting yet.
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else messages.push(message);
    });

    /** Consumes the matched message rather than peeking at it. A
     * non-consuming wait would hand the second spin the first spin's
     * buffered result and quietly report a false failure. */
    const waitFor = (type, timeoutMs = 10_000) =>
      new Promise((res, rej) => {
        const index = messages.findIndex((m) => m.type === type);
        if (index >= 0) return res(messages.splice(index, 1)[0]);
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), timeoutMs);
        const waiter = { type, timer, resolve: (m) => { clearTimeout(timer); res(m); } };
        waiters.push(waiter);
      });

    /** Drops every still-registered waiter, so a raced-away waiter cannot
     * silently consume a message a later check is expecting. */
    const cancelWaiters = () => {
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer);
    };

    // Settle on whichever the server sends first. A refused JOIN answers
    // with ERROR rather than closing the socket, so waiting only on JOINED
    // would hang until the timeout.
    //
    // The losing waiter must be cancelled, not left registered: an
    // abandoned ERROR waiter would swallow the first error of the rest of
    // the run, and a later check would time out waiting for a message that
    // had already been delivered to nobody.
    const joinWaiter = waitFor("JOINED");
    const errorWaiter = waitFor("ERROR");
    Promise.race([
      joinWaiter.then((joined) => ({ ok: true, joined })),
      errorWaiter.then((error) => ({ ok: false, error })),
    ]).then((result) => {
      cancelWaiters();
      if (!result.ok) {
        socket.close();
        reject(new Error(`JOIN refused: ${result.error.code}`));
        return;
      }
      resolve({ socket, joined: result.joined, waitFor, send: (m) => socket.send(JSON.stringify(m)) });
    }, reject);
  });
}

async function main() {
  const operatorId = "e2e-operator";
  const playerId = `e2e-player-${randomUUID().slice(0, 8)}`;

  console.log("\n1. Public game view (the only browser-facing route)");
  const view = await fetch(`${BACKEND}/public/games/${GAME_ID}`).then((r) => r.json());
  check("returns the game", view.gameId === GAME_ID, JSON.stringify(view).slice(0, 120));
  check("withholds reelStrips", !("reelStrips" in view));
  check("withholds symbolWeights", !("symbolWeights" in view));
  check("withholds rtpTarget", !("rtpTarget" in view));
  check("exposes betOptions the client needs", Array.isArray(view.betOptions));

  console.log("\n2. Internal API rejects an unsigned call");
  const unsigned = await fetch(`${BACKEND}/internal/rounds/spin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operatorId, playerId, gameId: GAME_ID, totalBet: 100 }),
  });
  check("unsigned spin is refused with 401", unsigned.status === 401, `got ${unsigned.status}`);

  console.log("\n3. Launch token -> JOIN");
  const token = signLaunchToken({ operatorId, playerId, gameId: GAME_ID });
  const { socket, joined, waitFor, send } = await connect(token);
  check("JOINED with the player from the token", joined.playerId === playerId);
  check("hands back a reusable session token", typeof joined.sessionToken === "string");
  check("reports an integer balance", Number.isInteger(joined.balance));

  console.log("\n4. A launch token is single-use");
  // The second JOIN must be refused. `connect` only resolves on JOINED, so
  // a rejection here means the server sent an ERROR instead — which is the
  // outcome we want. Resolving would mean the token was accepted twice.
  const replayAccepted = await connect(token).then(
    (c) => { c.socket.close(); return true; },
    () => false,
  );
  check("the same launch token cannot be reused", replayAccepted === false, "a spent launch token was accepted again");

  console.log("\n5. Spin");
  const betAmount = view.betOptions[0];
  send({ type: "SPIN_REQUEST", betAmount, clientRequestId: randomUUID() });
  const spinResult = await waitFor("SPIN_RESULT");
  const balanceUpdate = await waitFor("BALANCE_UPDATE");
  const round = spinResult.round;

  check("round is resolved", round.status === "resolved");
  check("stores a 32-byte seed for replay", typeof round.seed === "string" && round.seed.length === 64);
  check("records the rng algorithm", typeof round.rngAlgorithm === "string");
  check("records the game version", Number.isInteger(round.gameVersion));
  check("totalWin is an integer", Number.isInteger(round.evaluation.totalWin));
  check(
    "balance moved by exactly win minus bet",
    balanceUpdate.balance === joined.balance - betAmount + round.evaluation.totalWin,
    `${joined.balance} - ${betAmount} + ${round.evaluation.totalWin} !== ${balanceUpdate.balance}`,
  );

  console.log("\n6. A retried spin does not charge twice");
  const retryId = randomUUID();
  send({ type: "SPIN_REQUEST", betAmount, clientRequestId: retryId });
  const firstTry = await waitFor("SPIN_RESULT");
  const balanceAfterFirst = (await waitFor("BALANCE_UPDATE")).balance;

  // A fresh socket, as a genuinely reconnecting client would use.
  const second = await connect(joined.sessionToken);
  second.send({ type: "SPIN_REQUEST", betAmount, clientRequestId: retryId });
  const retried = await second.waitFor("SPIN_RESULT");
  const balanceAfterRetry = (await second.waitFor("BALANCE_UPDATE")).balance;

  check("the retry returns the original round", retried.round.roundId === firstTry.round.roundId);
  check("the retry does not move the balance again", balanceAfterRetry === balanceAfterFirst);

  console.log("\n7. An unoffered bet is refused — the client cannot invent a stake");
  second.send({ type: "SPIN_REQUEST", betAmount: 137, clientRequestId: randomUUID() });
  const error = await second.waitFor("ERROR");
  check("rejected as an invalid bet amount", error.code === "invalid_bet_amount", error.code);

  console.log("\n8. Round recovery replays, never re-rolls");
  second.send({ type: "ROUND_RECOVER", roundId: round.roundId });
  const recovered = await second.waitFor("ROUND_RECOVERED");
  check("recovers the same round", recovered.round.roundId === round.roundId);
  check("with the identical seed", recovered.round.seed === round.seed);
  check("and the identical outcome", recovered.round.evaluation.totalWin === round.evaluation.totalWin);

  socket.close();
  second.socket.close();

  console.log(failures === 0 ? "\nAll end-to-end checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\ne2e check failed to run:", err.message);
  console.error("Are the services up?  docker compose -f infra/docker-compose.yml up");
  process.exit(1);
});
