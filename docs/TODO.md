# Known bugs, gaps and next steps

Ordered by what I would actually do next, not by severity alone — a few
cheap items near the top because they unblock or de-risk the rest.

Status key: **Open** · **Open (accepted)** — a known limitation we have
decided to live with for now, recorded so it is a decision rather than an
oversight.

---

## ⚠️ Read this first: the reference repo

This project is a response to a review of a larger existing codebase. That
codebase and the review documents are on disk, and **both should be
consulted before starting any piece of work** — not after, and not only
when stuck.

| What | Where |
|---|---|
| Reference codebase (~28k lines, 7 apps, 11 packages) | `~/Desktop/irakli/slot-engine` — [backdoor-ge/slot-engine](https://github.com/backdoor-ge/slot-engine) @ `c3b93d3` |
| Full repository review | `~/Desktop/irakli/review-docs/full-repo-review.md` |
| Review brief (findings + suggested sequence) | `~/Desktop/irakli/review-docs/slot-engine-review-brief.md` |
| Paytable audit | `~/Desktop/irakli/slot-engine-paytable-audit.txt` |
| Study guide | `~/Desktop/irakli/slot-engine-study-guide.txt` |

**Every "the review" reference in this file and in the README points at
those documents.** F5, and the framing of the whole project, come from
them.

### The routine, before touching a module

1. **Look for the counterpart there first.**
   `find ~/Desktop/irakli/slot-engine -path '*<name>*' -not -path '*/node_modules/*' -not -path '*/dist/*'`
2. **If it has tests, read them before writing your own.** Ask what they
   cover that a fresh attempt would miss — not to copy, but because the
   gaps are the expensive ones to rediscover.
3. **Check the review for a finding on it.** Several are already closed
   here; do not "fix" what is fixed, and do not re-derive a finding that is
   written up in detail.
4. **Adapt, never transplant.** The two codebases differ in real ways —
   different payline win rule, different collection names, different module
   layout. Ported code that compiles is not the same as ported code that is
   correct here.

### What ignoring this already cost

Recorded because the cost was concrete, not hypothetical:

- **F14.** The ledger's concurrency tests were written from scratch against
  the in-memory fake, covering only *sequential* replay. The reference had
  real-replica-set concurrency tests for exactly this, and the guarantee
  they prove — two callers at the same instant, resting on the unique index
  plus the driver's write-conflict retry — is the one that actually matters
  on a money path. Found only after being asked about it directly.
- **The independent model cross-check** (a second, hand-derived probability
  model, checked against the real evaluator) existed there as an idea and
  was absent here. It is now the strongest test in `math-engine`.

Both were found by reading, not by reasoning harder. The lesson is cheap to
apply and was expensive to skip.

---

## Fixed (recorded so the reasoning survives)

These are done. They are listed because in each case the *reason* the bug
existed matters more than the fix, and that reasoning is easy to lose.

| # | What was wrong | How it was found |
|---|---|---|
| F1 | Idempotency index declared `sparse` on a **compound** key, so it indexed every round and a player's second ordinary spin collided with their first. 119 of 120 concurrent spins returned 500. | Load check, first run. No unit test could see it — the in-memory stand-in models the index we intended, not the one Mongo builds. |
| F2 | `applySchemas` could not change an existing index: Mongo returns `IndexOptionsConflict` rather than updating in place, so the F1 fix would have prevented boot on every existing database. | Found while fixing F1, before it shipped. |
| F3 | Workspace build ran alphabetically — `apps/` compiled before the `packages/` they import. 87 type errors on a clean checkout, invisible locally behind stale `dist/`. | CI, first run. |
| F4 | Test discovery glob was shell- and Node-version-dependent: 15 files under zsh, 2 under dash, and no glob form works on Node 20. It reported success while running a fraction of the suite. | CI. Took three attempts to fix; the first two were "verified" on Node 24. |
| F5 | `game-socket` had no tests at all — 405 lines on the service that decides who a player is. | The review. Now 29 tests, each verified by mutation. |
| F6 | `void app.register(rateLimit, …)` in a synchronous factory left **every** route unlimited — the plugin's `onRoute` hook had not installed yet. No error; requests just returned 200 with no protection. | Flooding the running service and finding the limit never fired. |
| F7 | game-backend's error handler forced every error to 500, flattening the limiter's 429 into `internal_error` — a limited client was told nothing and had no reason to back off. | Same flood; the status code was wrong. |
| F8 | `game-socket` accepted a WebSocket handshake from any origin — the service that owns the identity boundary held the most permissive position of the three, while both HTTP surfaces named their origins explicitly. Now refused with `403` at `verifyClient`. | Working down this list. 23 tests, each verified by mutation, plus a live handshake check against a running server. |
| F9 | The `loginAttempts` validator specified `bsonType: ["long", "int"]` — the types those values conceptually are. Every JavaScript number serialises to BSON **double**, so Mongo rejected every write and each failed login returned 500. | Driving the real stack. 333 unit tests passed throughout: the in-memory stand-in has no validator, so it models the schema we intended rather than the one Mongo enforces — the same blind spot as F1. |
| F10 | Login was throttled **per IP only**, so an attacker spreading attempts across many addresses got the full allowance *per address* against one account — every attempt looking like a first attempt. Now also counted per account, after body parsing, where the email is actually known. | Working down this list. 23 tests, each verified by mutation, plus the real-stack run that found F9. |
| F11 | `e2e:load` is a heavy single caller (~400 spins plus a balance read each, one service name) against a per-caller 600/min limit, so it exhausted its own bucket mid-run. `balanceOf` destructured `balance` off a 429 body and returned `undefined`, which surfaced as "0 of 25 allowed through from a balance of undefined" — an overdraw failure that never happened. | Running it. The check now throws on a non-200 balance read and names the 429; CI raises the limit for its stack only. |
| F12 | Bonus session expiry depended on an in-process interval: if every instance was down for twenty minutes, or one tick was missed, a session that timed out long ago was still `active` and would be played on the next request — a money path deciding correctness from a timer. The deadline is now checked on every read. | Working down this list. Verified against the running stack by backdating a live session: HTTP 410, nothing paid, row intact, and its stored status still `active` — proving the sweep had not run. |
| F13 | `verifySession` typed `JSON.parse`'s result as `SessionPayload` and read fields straight off it. A correctly signed token whose payload was the literal `null` threw a TypeError instead of returning null, and the auth middleware does not catch — so junk produced **500 instead of 401** on every admin route. Now refuses any non-object, and the parsed value is typed `unknown` so the compiler requires the check. | Writing the first tests for the file. Confirmed against the running service — 500 before, 401 after, for `null`, an array, a number and a string. |
| F14 | The ledger's idempotency was only ever tested as a **sequential** replay — call, then call again — on a stand-in that models no transactions. Two callers arriving at the same instant is a different guarantee, resting on the unique index plus the driver's write-conflict retry, and nothing exercised it at this level. Now covered against a real replica set. | Reading the reference repo's own ledger suite (`~/Desktop/irakli/slot-engine`), which had exactly these tests and which I had not consulted. Both mutations caught: removing the in-flight check fails even with the index intact. |
| F15 | `evaluateScatter` looks a count up **exactly** (`payout[count]`), so a table of `{3,4,5}` pays **nothing** at 6 — the biggest outcome in the game silently returning zero. Unreachable for `reference-5x3` (one scatter per strip caps it at 5), but one edit in the backoffice makes it live, and draft validation checked each entry's shape without ever checking the table covered the reachable range. `validateDraft` now refuses to publish an under-covered table. | Writing the first tests for `scatter.ts`, after the reference's suite flagged that its own engine uses N-or-more semantics where this one does not. Verified the shipped game still publishes and the dangerous edit is refused. |
| F16 | `fakeMongo` ignored `projection` entirely, so `_id` survived in tests while the real routes correctly stripped it. **More permissive than Mongo**, which is the inverse of F1/F9 and just as misleading — a correct assertion ("no `_id` in the response") failed against correct code. The fake now honours `{ _id: 0 }` on `find` and `findOne`. | Writing route tests for `/v1/games/:gameId/versions`. The test failed, the route was right, and comparing the two engines directly showed real Mongo stripping `_id` and the fake keeping it. Now pinned by two conformance tests. |

---

## Open

### 1. No deploy pipeline — CI verifies, nothing ships
**Severity: high (process) · Effort: medium**

`ci.yml` builds, typechecks, tests and runs three end-to-end suites, and
then stops. There is no deploy job, no environment, no rollback path. The
gate the review asked for exists; the thing it is supposed to gate does
not.

This is deliberate for now — there is nowhere to deploy to — but it means
"CI is green" currently proves less than it sounds like it does.

### 2. Branch protection is not enforced
**Severity: medium · Effort: trivial (needs a paid plan)**

GitHub requires Pro for branch protection on a private repo, so CI reports
but cannot block a merge. A `pre-push` hook covers the realistic case
locally (build, typecheck, 557 tests, ~40s), and is skippable with
`--no-verify` by design.

Options: GitHub Pro at $4/month, make the repo public, or accept it. See
the note in the README about why public is the wrong trade here.

### 3. Account lockout is a denial-of-service lever
**Severity: low-medium · Effort: medium**

Per-account throttling now exists (F10): ten consecutive failures lock an
address for fifteen minutes, counted against the account rather than the
source IP, so distributing an attack across many addresses no longer buys
more guesses.

The trade it introduces is the one every lockout scheme has: anyone who
knows an administrator's email can keep that account locked by failing on
purpose, indefinitely and from anywhere. That is a real cost, accepted
deliberately here — a fifteen-minute window that expires on its own is a
far smaller problem than an unbounded distributed guessing rate against a
password.

The standard mitigations, none of which are free:

- **Exponential backoff instead of a flat window.** Slows a real attacker
  without ever fully denying a legitimate user. Probably the best next step.
- **A CAPTCHA or proof-of-work after N failures**, rather than a refusal.
- **Not locking, but requiring a second factor** once the count is high.

Worth doing before this is exposed to the public internet, not before.

### 3d. `runRngTestSuite`'s aggregate cannot be tested
**Severity: low · Effort: low, but widens production surface**

The RNG report's `passed` field is `results.every(r => r.passed)`. Changing
that to `some` breaks no test, because all three sub-tests pass on a
healthy generator, so the two operators agree on every input reachable
through the exported API. A report that claimed success while a sub-test
failed would be the most misleading thing this artefact could do, and
nothing currently prevents it.

The blocker is that no sub-test can be made to fail on demand.
`createRng` takes an `algorithm` parameter but ignores it — there is only
one implementation — so a deliberately broken generator cannot be
injected. Chi-squared is also robust enough that no draw or bin count
produces a genuine failure; extreme sparsity converges toward the mean
rather than away from it, which was measured, not assumed.

Two ways to close it, both real changes rather than test-only ones:

- **Honour the `algorithm` parameter** in `createRng` and register a
  deliberately-biased implementation for tests. Also the honest fix for the
  parameter being decorative today.
- **Take the results array as an argument** so the aggregate is a pure
  function that can be handed constructed values.

The narrower half of this gap is already closed: `evaluate` is exported and
its two-sided band is tested directly against known critical values, which
catches both an always-pass band and a one-sided one.

### 3c. `e2e:backoffice` can exhaust the login rate limit
**Severity: low (test-only) · Effort: low**

The suite signs in many times — the bootstrap admin, then each user it
creates — against a per-IP limit of 10 logins per 5 minutes. A single clean
run fits. Running it twice in quick succession, or running it after any
manual login attempts, does not: the second run fails with
`a deactivated user cannot sign back in — got 429`, which reads like a
broken deactivation check rather than a throttled request.

Same shape as F11, and found the same way — by running it. The recovery is
simply to wait out the window, which is what makes it easy to misdiagnose:
the suite passes on retry, so the failure looks flaky rather than
explained.

Two honest fixes, neither done yet: have the e2e client assert on a 429
explicitly ("rate limited, not a real failure") instead of reporting the
status mismatch, and give the e2e stack a raised `LOGIN_RATE_LIMIT` the way
CI already raises `GAME_RATE_LIMIT` for the load check. The limiter itself
is correct and has its own tests; it is the suite that assumes it can log
in freely.

### 3b. Rate limits are per-instance, held in memory
**Severity: medium before horizontal scaling · Effort: low**

Every limiter here counts in the process's own memory. Two instances behind
a load balancer means an effective limit of double the configured value,
and a restart clears every counter. Fine for one instance; wrong the moment
there are two.

`@fastify/rate-limit` supports a Redis store, which is the standard answer.
The socket's token buckets would need the same treatment.

### 4. Secrets live in environment variables
**Severity: medium · Effort: medium-high**

`SERVICE_AUTH_SECRET`, `LAUNCH_TOKEN_SECRET` and `BACKOFFICE_JWT_SECRET`
are passed as plain env vars through compose. Fine for local development;
not fine for production, where they belong in a secret manager with
rotation. The startup guards already refuse weak or missing values, so the
remaining gap is storage and rotation, not validation.

Worth noting this is the same finding the review made about the reference
architecture's encryption key — a fair characterisation there, and it
applies here too.

### 5. Bonus session rows are never reaped
**Severity: low · Effort: low**

The correctness half of this is fixed (F12): `stepBonus` now checks the
deadline on every read, so an expired session is refused whether or not
`sweepAbandonedSessions` has run. Expiry is a property of the data, not of
a process being alive.

**The TTL index this item originally proposed was the wrong fix**, and the
reasoning is worth keeping. A TTL *deletes* the row — but `abandoned` is a
meaningful state, not garbage: a player returning to a timed-out bonus gets
a precise 410 `bonus_session_abandoned` ("that bonus round timed out"). Had
the row been deleted, they would get "no such session" instead, which is
strictly worse information on a money path. Cheaper storage is not worth a
worse answer to a player asking where their bonus went.

What remains is genuine housekeeping: resolved and abandoned sessions
accumulate forever. That wants an archival policy with a retention window
long enough to answer a player dispute — a different decision from
"expire it", and one that should be made deliberately rather than by
setting `expireAfterSeconds`.

### 6. The load check's bonus race depends on a seeded fixture
**Severity: low · Effort: low**

Section 4 needs `pick-bonus-5x3`, which is only seeded when
`SEED_TEST_FIXTURES=true`. CI sets it. Run the load check against a stack
started without it and the section skips — honestly, with a message
naming the flag, but it skips.

Acceptable, because the alternative is seeding a game with a
deliberately-broken RTP into every environment. Worth knowing before
reading a local run as complete.

---

## Open (accepted)

### 7. A passing load check is evidence, not proof
**Accepted — inherent, not fixable**

The load check drives real concurrency against real Mongo and asserts
invariants that a genuine race would break. It cannot prove the absence of
a race: an interleaving that did not occur on this machine may still
exist. The script says so on success rather than implying more than it
established.

The mitigation is that each section was verified by breaking the code and
watching it fail — removing the atomic bonus claim takes accepted steps
from 2 to 10; dropping the idempotency index produced 12 rounds and 12
charges for one `clientRequestId`.

### 8. The overdraw section can skip
**Accepted — the alternatives are worse**

Draining a balance is a random walk at ~95% return. Three approaches were
tried and discarded (batch-and-hope, grind-then-race, bet-over-balance —
the last fails because bet validation precedes the funds check). The
current version bounds the drain and reports whether it ran, so a skip is
visible rather than a silent pass. Observed: ran in 5 of 6 local runs.

### 9. `reference-5x3` cannot exercise a multi-step bonus
**Accepted — solved by fixture, not by changing the reference game**

Its `wheel` module resolves at `start`. Rather than distort a game tuned
to a believable 0.95 RTP, `pick-bonus-5x3` exists purely as a test
instrument: 100% bonus trigger rate, nine tiles, one blank. It is seeded
only behind a flag and refused in production.

---

## Deliberately not doing

- **Load-testing beyond one player.** The interesting races are all
  per-player; cross-player contention shares no state worth racing.
- **A second RNG algorithm.** Rounds record `rngAlgorithm` so a future one
  can be added without breaking replay. Adding one now would be
  scaffolding for a need that does not exist.
