#!/usr/bin/env node
/**
 * Concurrency check for the money path, against RUNNING services.
 *
 * The unit tests cover the races with an in-memory stand-in that models
 * unique-index violations and atomic findOneAndUpdate. That is a model of
 * Mongo, not Mongo — it cannot show that the indexes are actually declared
 * on the real collections, that the transaction genuinely rolls back, or
 * that a race resolves the same way under real latency and real contention.
 *
 * This drives genuinely parallel requests at one player and then reconciles
 * the ledger against the balance independently.
 *
 * What it proves: under this level of contention, on this machine, these
 * invariants held. What it cannot prove: the absence of a race. A passing
 * concurrency test is evidence, not a proof — an interleaving that never
 * occurred here may still exist. It is written to make a real bug *likely*
 * to surface, not to certify that none is there.
 *
 * Run with:  npm run e2e:load
 * Requires:  docker compose -f infra/docker-compose.yml up
 */

import { createHmac, randomUUID } from "node:crypto";

const BACKEND = process.env.GAME_BACKEND_URL ?? "http://localhost:9102";
const SECRET = process.env.SERVICE_AUTH_SECRET;
const GAME_ID = process.env.GAME_ID ?? "reference-5x3";
const OPERATOR = process.env.LOAD_OPERATOR_ID ?? "load-test";

// Tunable so this can be run harder by hand than CI runs it. The defaults
// are chosen to finish in a few seconds while still producing real overlap.
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 25);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 120);
const BET = Number(process.env.LOAD_BET ?? 100);

if (!SECRET) {
  console.error("SERVICE_AUTH_SECRET must be set — internal calls are signed.");
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

/** Mirrors @slots-engine/service-auth. Deliberately reimplemented: a test
 * that imports the signer cannot detect the signer disagreeing with the
 * verifier, which is exactly the sort of drift this should catch. */
function call(path, body) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET)
    .update(`${timestamp}.POST.${path}.${rawBody}`)
    .digest("base64url");

  return fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-timestamp": timestamp,
      "x-service-signature": signature,
      "x-service-caller": "load-check",
    },
    body: rawBody,
  });
}

async function spin(playerId, { clientRequestId, bet = BET, game = GAME_ID } = {}) {
  const response = await call("/internal/rounds/spin", {
    operatorId: OPERATOR,
    playerId,
    gameId: game,
    totalBet: bet,
    ...(clientRequestId ? { clientRequestId } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ...payload };
}

/**
 * Throws rather than returning `undefined` on a failed read.
 *
 * This used to destructure `balance` straight off the body, so a refused
 * request — most realistically a 429, since this script can spend the
 * caller's whole `GAME_RATE_LIMIT` bucket on its own — silently produced
 * `undefined`. That then flowed into section 3 as
 * "0 of 25 were allowed through from a balance of undefined", which reads
 * like an overdraw bug in the money path rather than a throttled HTTP call.
 *
 * A check that misreports its own failure mode is worse than one that
 * stops: the first sends you looking for a bug that is not there.
 */
async function balanceOf(playerId) {
  const response = await call("/internal/players/balance", { operatorId: OPERATOR, playerId });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200 || typeof body.balance !== "number") {
    throw new Error(
      `balance read failed for ${playerId}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 120)}` +
        (response.status === 429 ? "\n  (rate limited — see GAME_RATE_LIMIT; this script is a heavy single caller)" : ""),
    );
  }
  return body.balance;
}

/** Runs `total` tasks with at most `limit` in flight, so the pressure is
 * sustained rather than one big burst that mostly queues. */
async function pool(total, limit, task) {
  const results = new Array(total);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, total) }, async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        results[i] = await task(i);
      }
    }),
  );
  return results;
}

console.log(`\nMoney-path load check — ${ROUNDS} rounds, ${CONCURRENCY} in flight, bet ${BET}\n`);

// ---------------------------------------------------------------------
// 1. Concurrent distinct spins: the ledger must reconcile exactly.
//
// This is the invariant that matters most. Every spin debits and may
// credit; when the dust settles, the balance must equal the starting
// balance plus the sum of every transaction. A lost update — two spins
// reading the same balance and one overwriting the other — breaks this
// and nothing else will notice.
// ---------------------------------------------------------------------
console.log("1. Concurrent spins on one player reconcile against the ledger");
{
  const playerId = `load-${randomUUID().slice(0, 8)}`;
  const opening = await balanceOf(playerId);

  const results = await pool(ROUNDS, CONCURRENCY, () => spin(playerId));
  const resolved = results.filter((r) => r.status === 200 && r.round);
  const rejected = results.filter((r) => r.status !== 200);

  check(
    `every spin was answered (${resolved.length} resolved, ${rejected.length} refused)`,
    resolved.length + rejected.length === ROUNDS,
  );

  // Any refusal other than insufficient funds means something actually
  // broke under load rather than the player simply running out of money.
  const unexpected = rejected.filter((r) => r.error !== "insufficient_funds");
  check(
    "no spin failed for an unexpected reason",
    unexpected.length === 0,
    unexpected.length ? `saw: ${[...new Set(unexpected.map((r) => `${r.status} ${r.error}`))].join(", ")}` : "",
  );

  const staked = resolved.length * BET;
  const won = resolved.reduce((sum, r) => sum + r.round.evaluation.totalWin, 0);
  const expected = opening - staked + won;
  const actual = await balanceOf(playerId);

  check(
    "final balance equals opening − staked + won, with no lost update",
    actual === expected,
    `expected ${expected}, got ${actual} (drift ${actual - expected})`,
  );

  check("balance is a whole number of minor units", Number.isInteger(actual));

  // Every resolved round must be distinct: an id collision would mean two
  // spins sharing a round document, and with it a ledger entry.
  const roundIds = new Set(resolved.map((r) => r.round.roundId));
  check("every concurrent spin produced a distinct round", roundIds.size === resolved.length);

  // Distinct seeds matter for fairness, not just tidiness: a repeated seed
  // under load would mean the generator is being reseeded from something
  // time-based rather than from crypto randomness.
  const seeds = new Set(resolved.map((r) => r.round.seed));
  check("every concurrent spin used a distinct seed", seeds.size === resolved.length);
}

// ---------------------------------------------------------------------
// 2. The idempotency race, run for real.
//
// The unit tests cover this against a fake that throws 11000 on a
// duplicate. Here the unique index either exists on the real collection
// or it does not.
// ---------------------------------------------------------------------
console.log("\n2. A retried spin under real contention charges exactly once");
{
  const playerId = `load-${randomUUID().slice(0, 8)}`;
  const opening = await balanceOf(playerId);
  const clientRequestId = `retry-${randomUUID()}`;

  // Fired simultaneously, as a double-click or a client retry on a flaky
  // connection would — the case where an application-level check alone
  // loses the race.
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => spin(playerId, { clientRequestId })),
  );

  const ok = attempts.filter((r) => r.status === 200 && r.round);
  check("every concurrent attempt was answered", ok.length === attempts.length);

  const distinctRounds = new Set(ok.map((r) => r.round.roundId));
  check(
    "all attempts collapsed onto exactly one round",
    distinctRounds.size === 1,
    `got ${distinctRounds.size} distinct rounds`,
  );

  // The stronger claim: they agree on the outcome, not merely the id. Two
  // evaluations that both ran and then deduplicated would show up here.
  const distinctWins = new Set(ok.map((r) => r.round.evaluation.totalWin));
  check("all attempts report the same outcome", distinctWins.size <= 1);

  const only = ok[0]?.round;
  const actual = await balanceOf(playerId);
  check(
    "the player was charged exactly once",
    actual === opening - BET + (only?.evaluation?.totalWin ?? 0),
    `expected ${opening - BET + (only?.evaluation?.totalWin ?? 0)}, got ${actual}`,
  );
}

// ---------------------------------------------------------------------
// 3. Spending down to zero: the debit must never take a balance negative.
//
// Under contention the affordability check and the debit are the classic
// place for a time-of-check/time-of-use gap.
// ---------------------------------------------------------------------
console.log("\n3. Concurrent spins cannot overdraw the balance");
{
  const playerId = `load-${randomUUID().slice(0, 8)}`;
  const bigBet = 5000;

  // Spend down at the largest offered bet, then race a burst at the edge.
  //
  // Getting this to be a *test* rather than a coin flip took three attempts,
  // and the dead ends are worth recording because each looks reasonable:
  //
  // Firing a big batch and expecting some refusals depends entirely on the
  // RNG — one run drained in 38 spins, another finished 105 spins richer
  // than it started.
  //
  // Grinding the balance down first fails the same way, just later. The
  // drain is a random walk at ~95% return: usually 24-192 spins to reach 0,
  // but CI hit its cap at a balance of 525000 and a local run at 260000. No
  // iteration cap makes a random walk deterministic.
  //
  // Betting more than the balance does not work either: bet validation runs
  // before the funds check, so an arbitrary amount is refused as
  // invalid_bet_amount and never reaches the money path at all. There is no
  // route that sets a balance directly, and there should not be one.
  //
  // So the drain is bounded and its outcome is *reported* rather than
  // assumed. If the player did go broke, the overdraw race is asserted in
  // full; if the walk went the other way, the section says it skipped
  // instead of quietly passing. A check that cannot run is not a check that
  // succeeded.
  const spent = [];
  let drained = await balanceOf(playerId);
  for (let i = 0; i < 400 && drained >= bigBet; i++) {
    const result = await spin(playerId, { bet: bigBet });
    if (result.status !== 200) break;
    spent.push(result);
    drained = await balanceOf(playerId);
  }

  if (drained >= bigBet) {
    console.log(`  – the walk never went broke (balance ${drained} after ${spent.length} spins); skipping (not a failure)`);
  } else {
    const opening = drained;
    // Every one of these would overdraw, since the balance is now under a
    // single bigBet. None may be honoured, and none may take the balance
    // below zero — the time-of-check/time-of-use gap, run CONCURRENCY wide.
    const burst = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => spin(playerId, { bet: bigBet })),
    );

    const resolved = burst.filter((r) => r.status === 200 && r.round);
    const refused = burst.filter((r) => r.error === "insufficient_funds");

    check(
      "the unaffordable burst was refused, not partially honoured",
      refused.length === burst.length,
      `${resolved.length} of ${burst.length} were allowed through from a balance of ${opening}`,
    );

    const final = await balanceOf(playerId);
    check("balance never went negative", final >= 0, `final balance ${final}`);
    check("a fully refused burst moved no money at all", final === opening, `expected ${opening}, got ${final}`);
  }
}

// ---------------------------------------------------------------------
// 4. Bonus stepping under concurrency — the fix from the review.
//
// Two concurrent steps must not both evaluate. Ledger idempotency would
// keep the amount right, but independent randomness could compute
// different wins, leaving the recorded outcome disagreeing with what was
// actually paid. This is the audit-trail bug, exercised for real.
// ---------------------------------------------------------------------
console.log("\n4. Concurrent bonus steps: exactly one wins the claim");
{
  const playerId = `load-${randomUUID().slice(0, 8)}`;
  let opened = null;

  // Run against the pick-bonus fixture, whose module is MULTI-STEP. The
  // reference game's wheel resolves entirely at `start`, so there is no
  // second step to race and this section could only ever skip against it.
  // The fixture is seeded by game-backend when SEED_TEST_FIXTURES=true.
  const bonusGame = process.env.BONUS_GAME_ID ?? "pick-bonus-5x3";
  const probe = await fetch(`${BACKEND}/public/games/${bonusGame}`);

  if (!probe.ok) {
    console.log(
      `  – '${bonusGame}' is not published; skipping (not a failure).` +
        " Start game-backend with SEED_TEST_FIXTURES=true to run this section.",
    );
  } else {
  // Spin until a bonus triggers. Bounded so a game without a reachable
  // bonus reports honestly instead of hanging.
  for (let i = 0; i < 400 && !opened; i++) {
    const result = await spin(playerId, { game: bonusGame });
    if (result.status !== 200) break;
    if (result.round?.evaluation?.bonusTriggered) opened = result.round;
  }

  if (!opened) {
    console.log("  – no bonus triggered in 400 spins; skipping (not a failure)");
  } else {
    const start = await call("/internal/bonus/start", {
      operatorId: OPERATOR,
      playerId,
      gameId: bonusGame,
      roundId: opened.roundId,
      moduleId: opened.evaluation.bonusModuleId,
      totalBet: opened.totalBet,
    });
    const session = await start.json();

    if (session.done) {
      console.log("  – bonus resolved in one step; nothing to race (not a failure)");
    } else {
      const before = await balanceOf(playerId);
      const id = session.publicState.bonusSessionId;

      // Ten callers race the SAME step of the SAME session, all naming the
      // same tile. Exactly one may advance it; the losers must be refused,
      // not silently allowed to evaluate a second time. Before the atomic
      // claim, both could pass the status check, and because each derived
      // its own randomness they could compute different wins — one paid,
      // the other recorded. That is the audit-trail bug, run for real.
      const stepped = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const response = await call("/internal/bonus/step", {
            operatorId: OPERATOR,
            playerId,
            gameId: bonusGame,
            bonusSessionId: id,
            action: "pick",
            payload: { tileIndex: 0 },
          });
          return { status: response.status, ...(await response.json().catch(() => ({}))) };
        }),
      );

      const accepted = stepped.filter((r) => r.status === 200);

      // The assertion that matters is about the TILE, not the HTTP count.
      //
      // "Exactly one caller gets a 200" is the obvious check and it is
      // wrong: several callers can read the same stepIndex before any of
      // them writes, so more than one claim can legitimately succeed
      // against different indexes. Those extra claimants are then refused
      // by the module itself, because tile 0 is already revealed. The
      // stepIndex claim and the module's own state check are two layers of
      // the same guard, and asserting on the first alone reports a defect
      // where there is none.
      //
      // What must never happen is the tile being evaluated twice — that is
      // the audit-trail bug: two evaluations, two possibly different
      // prizes, one paid and one recorded. So the check reads the session
      // and asserts the reveal happened exactly once.
      const inspected = await call("/internal/bonus/step", {
        operatorId: OPERATOR,
        playerId,
        gameId: bonusGame,
        bonusSessionId: id,
        action: "pick",
        payload: { tileIndex: 0 },
      });
      check(
        "the tile cannot be revealed again, however many callers claimed a step",
        inspected.status !== 200,
        `a repeat reveal of tile 0 returned ${inspected.status}`,
      );

      check("at least one caller was refused outright", accepted.length < stepped.length, `${accepted.length} of ${stepped.length} accepted`);

      // Every accepted step must agree about what was revealed. Two
      // independent evaluations of the same tile could disagree, which is
      // precisely what the fix prevents.
      const revealedMultipliers = new Set(
        accepted.flatMap((r) => (r.publicState?.picks ?? []).map((p) => `${p.tileIndex}:${p.multiplier}`)),
      );
      check(
        "every accepted step reports the same reveal",
        revealedMultipliers.size <= 1,
        `saw ${[...revealedMultipliers].join(", ")}`,
      );

      const after = await balanceOf(playerId);
      const credited = accepted[0]?.balanceAfter;
      if (accepted[0]?.done && credited !== undefined) {
        check("the balance matches the single accepted evaluation", after === credited, `expected ${credited}, got ${after}`);
      } else {
        check("an unresolved bonus paid nothing yet", after === before, `before ${before}, after ${after}`);
      }
    }
  }
  }
}

console.log(
  failures === 0
    ? "\nAll load checks passed.\n\nThis is evidence under contention, not a proof of correctness:\n" +
        "an interleaving that did not occur here may still exist.\n"
    : `\n${failures} load check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
