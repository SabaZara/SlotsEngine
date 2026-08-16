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
| F21 | `fakeMongo` honoured **exclusion** projections (`{ _id: 0 }`, the F16 fix) but ignored **inclusion** ones (`{ gameId: 1, name: 1 }`) entirely, so a projected list query returned whole documents in tests and three fields against real Mongo. The third time this same asymmetry has bitten — F16 fixed half of it and the other half went unnoticed because nothing tested it. Projection is now a shared `applyProjection` handling both shapes, including Mongo's quirk that `_id` rides along with an inclusion projection unless excluded, and it is applied **after** sort rather than before — Mongo sorts then projects, so a query may legally order by a field the caller never receives. | A `listDrafts` test asserting the summary shape failed against correct code. Pinned by three new conformance tests against real Mongo, one of them specifically for the sort-then-project ordering. |
| F19 | **`verifyPassword` derived a key of `expected.length` — the length taken from the stored record — so a truncated hash verified.** Shorten a stored digest to one byte and scrypt derives one byte, which matches roughly one guess in 256: measured, an arbitrary password verified against a 1-byte hash after **274 guesses**. Anyone able to write to a user record could downgrade an account to trivially guessable without knowing or changing the password. The required length is now fixed at `KEY_LENGTH` and a digest of any other length is refused. | Writing the first tests for `passwords.ts`. A shape test ("refuses a hash of the right length but wrong content") failed by returning `true`, which made no sense until the derive call was read closely. Verified on the live stack: a 1-byte hash planted in the real database now yields 401 for every guess. |
| F20 | `verifyPassword` **threw** on a stored cost that was not a power of two, or was large enough to exceed `maxmem` — Node's scrypt rejects both with `RangeError: Invalid scrypt params`. Its own docstring promised the opposite ("never throws on a malformed stored value — a corrupt hash must read as wrong password, not as a 500"). On the login path an uncaught throw is a 500 that confirms to an attacker that this particular account exists and is broken. Both are now refused before the scrypt call. | The same first tests. This is F13's shape exactly, one file over: a value parsed out of stored data and used without checking it is in the domain the callee accepts. Verified live — both cases return 401 through the running service. |
| F18 | `toPublicUser` returned the source `roles` **array by reference**, so `publicUser.roles.push("super_admin")` edited the underlying user record in place — a privilege escalation through the one function whose job is producing a safe copy. Latent rather than live (no caller mutates it today), and the fix is a one-line spread. | Writing the first tests for `rbac.ts`. The test was originally drafted to *pin the weakness*, which is backwards; checking whether it was exploitable took one script, and it was, so it was fixed instead. |
| F17 | `fakeMongo`'s `applyUpdate` handled `$set` and `$inc` and **silently dropped every other operator**. A `$unset` in a test did nothing, the document kept the field, and the test asserting on the missing-field fallback passed while asserting nothing. Same family as F16 — the stand-in more permissive than Mongo — but worse, because the test *looked* like it covered the branch. `$unset` is now implemented, and an unrecognised `$`-operator throws instead of being ignored. | Mutation testing the auth middleware. Changing `?? 0` to `?? -1` was the one mutation of twelve that survived; the test that should have caught it was the `$unset` one. Pinned now by two conformance tests, one of them against real Mongo. |
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

## Remaining work, in the order I would do it

A full sweep of what is left, taken from the codebase rather than from
memory: every source file was checked for a sibling test, and modules with
no direct test were then checked for indirect coverage through the route
suites. Sizes are real line counts.

The short version: **the money path, the identity boundary and the schema
layer are now covered.** What remains is mostly the surfaces around them —
boot guards, the admin auth hook, the frontend, and the operational gaps
that were always known.

### A. Untested and genuinely uncovered — do these first

These have no direct test AND no meaningful indirect coverage.

| Module | Lines | Why it matters |
|---|---:|---|
| ~~`game-backend/src/startupGuards.ts`~~ | 45 | **Done.** 15 tests, all six mutations caught (length floor, `=== "production"` loosened to a prefix, each production guard removed, first-problem-only reporting, and the guard made a no-op). Both directions are covered — a guard that throws on everything fails the "accepts a valid environment" test. What they still cannot establish: that `main()` calls it before binding a port, which is `index.ts`'s job and untested below. |
| ~~`backoffice-api/src/auth/middleware.ts`~~ | 69 | **Done.** 23 tests on a bare Fastify instance with probe routes, so a failure names the rule rather than a route. All 12 mutations caught — including the revocation lookup in all four of its states (version behind, version ahead, deactivated, user gone). The twelfth mutation is what surfaced F17. Still cannot establish that `buildApp` mounts the hook at all; that is `app.test.ts`'s territory. |
| ~~`backoffice-api/src/games/simulateClient.ts`~~ | 66 | **Done.** 10 tests, all seven mutations caught — including the one that matters most, the adapter silently ceasing to pass `ASSUMED_BONUS_RETURN_MULTIPLIER` (`runSimulation` defaults it to 0, so every bonus would score nothing and a tuned game would be refused for a reason no report explains). The constant's leverage is now measured by a test rather than asserted from memory, and writing it turned up the sampling-noise figures added to item G. |
| ~~`game-socket/src/index.ts`~~ | 118 | **Done**, by splitting it. The assembly moved to `server.ts` as `createSocketServer`, following `backoffice-api`'s existing `app.ts`/`index.ts` convention, leaving `index.ts` as config-plus-listen. 17 tests drive a real server on an ephemeral port with a real `ws` client. Two gaps are stated in the file header rather than left silent: the `maxPayload` ceiling and the `readyState` guard both survive mutation, and both were judged not worth a fragile test. Verified end to end — `e2e:spin` passes in full against the rebuilt container. |
| ~~`game-backend/src/index.ts`~~ | 175 | **Done**, split the same way: composition moved to `app.ts` as `buildApp`, leaving `index.ts` with connections, the sweep interval and shutdown. 14 tests, 10 of 11 mutations caught — **including regression tests for F6 and F7 themselves**, the two bugs that actually happened in this file. Verified live: rebuilt, `e2e:spin` and all four sections of `e2e:load` pass under real concurrency. |

### B. Covered indirectly, worth direct tests

Real logic reachable only through route tests today, so a failure names a
route rather than the rule that broke.

| Module | Lines | Gap |
|---|---:|---|
| ~~`backoffice-api/src/auth/users.ts`~~ | 135 | **Done.** 33 tests, all 12 mutations caught. The `tokenVersion` invariant now has direct tests on all four paths that must bump it (role change, deactivation, password reset, explicit revoke), plus monotonicity and the empty-patch no-op. Pairs with `middleware.test.ts`: that file proves the hook rejects a stale version, this one proves the version actually moves. |
| ~~`backoffice-api/src/games/drafts.ts`~~ | 131 | **Done.** 25 tests, all nine mutations caught. The structural promise — a draft is not a `GameDefinition`, carrying no `version` and no `status` so neither can be edited — is pinned on both construction paths, `blankDraft` and `draftFromPublished`. Writing them found F21. |
| `backoffice-api/src/games/publish.ts` | 131 | The RTP gate is well covered through routes (and closes the review's finding #2). The versioning and audit-write paths are not directly tested. |
| ~~`backoffice-api/src/auth/passwords.ts`~~ | 73 | **Done, and it was not subtle.** 29 tests; found F19 (a truncated hash verified — 274 guesses to log in as anyone) and F20 (a malformed cost threw a 500 instead of returning false). 7 of 10 mutations caught; the three survivors are documented equivalents in the file header, not silence. Verified against the live stack, including all 12 pre-existing hashes in the real database and planted corrupt records. |
| `game-backend/src/routes/*.ts` | ~250 | `rounds`, `bonus`, `simulate`, `public`, `launchTokens`, `serviceAuth`. Well exercised by the three e2e suites, which is real coverage — but e2e failures are slow and name a flow, not a branch. |
| ~~`shared-types/src/money.ts`~~ | 84 | **Done.** 26 tests, all eight mutations caught. The "no minor unit created or lost" property is pinned exhaustively over totals 0–60 × parts 1–12, plus a spread check — summing correctly is not enough on its own, since `[total, 0, 0, …]` also sums correctly. Adapted from the reference's `money.test.ts` (near-identical module), extended with the cases it lacked: negative totals, `-0`, and the `70.07 * 100 = 7006.999…` float error that is the reason this module exists. |
| ~~`shared-types/src/rbac.ts`~~ | 65 | **Done.** 14 tests, all six mutations caught. Note the file is types plus `ROLE_IDS` and `toPublicUser` — there are no "permission sets" here, so this row overstated it; authorisation lives in `requireRole`. Writing the tests found F18. |

### C. Frontend — untouched this whole session

`game-frontend` and `backoffice-frontend` have **12 source files and 2 test
files** between them. Nothing in this session went near them. The review's
assessment was that the frontend is sound (no client-side money
calculation, `sessionStorage` rather than `localStorage`, a clean XSS
surface), so this is a coverage gap rather than a known-defect list — but
it is the largest single untested area remaining.

Worth checking specifically, since the review looked at a *different*
codebase's frontend and these findings may not transfer:

- The client never computes a win amount, only renders what the server sent.
- Token handling on reconnect: a stored session token must never substitute
  for a missing launch token.
- The socket client's behaviour when the server closes with 1013 (busy) or
  refuses the handshake with 403 — both now reachable, neither exercised.

### D. Test-infrastructure debt

- **`fakeMongo` is ~340 lines and still not directly tested.** The
  conformance suite now pins its agreement with real Mongo on 19
  behaviours, which is the more valuable half — but it has grown four times
  this session (exclusion projections, `$unset`, inclusion projections, and
  the F1/F9 lessons) and every unit test in the repo trusts it.
- **Three of the last five findings were in the stand-in, not the code**
  (F16, F17, F21). Each was the same shape: the fake quietly more permissive
  than Mongo, so a correct assertion failed against correct code or a test
  passed while asserting nothing. The pattern is strong enough to be worth
  stating as a rule — **when a test fails against code that reads correctly,
  suspect the fake before the code** — and it argues for pinning each new
  `fakeMongo` behaviour with a conformance test at the moment it is added,
  which is now the practice.
- **The fake implements only the operators this codebase happens to use.**
  `$push`, `deleteOne` and friends are absent. Since F17 an unknown update
  operator throws rather than being ignored, so the *silent* half of that
  problem is closed — but a test needing one of them still has to work
  around it (the middleware suite splices the backing array to delete a
  document). Each addition should arrive with a conformance test, not on its
  own.
- **A test that waits on an event must time out.** The socket suite's first
  version used unbounded promises for "the server closes this" and "the
  server replies". Under mutation, a server that *fails* to close simply
  hung — two ten-minute timeouts before the pattern was obvious, and a
  hanging run gives no information at all about which mutation survived.
  Every wait there now rejects with a named timeout. Applies to any test
  awaiting a callback rather than a return value.
- **A malformed-input fixture must be malformed in exactly one way.** The
  `passwords.ts` suite first used short fake digests for every corrupt-hash
  case (`scrypt$0$c2FsdA$aGFzaA` and friends). Every test passed — but the
  new digest-length check rejected all of them before the branch under test
  was reached, so thirteen tests were exercising one guard thirteen times.
  Mutation testing exposed it: four separate guards could be deleted with
  the suite still green. Fixtures now carry a valid salt and a full 64-byte
  digest so the named field is the only thing wrong. Worth checking wherever
  a suite tests refusals by handing over obviously-junk input.
- **Item 3d** — `runRngTestSuite`'s aggregate cannot be tested without an
  injectable RNG algorithm. Recorded above with two concrete fixes.
- **Item 3c** — `e2e:backoffice` exhausts the per-IP login limit on a second
  consecutive run and misreports it as a broken deactivation check.

### E. Operational — unchanged, and the real blockers

Items 1, 2, 3b and 4 above. Ordered by what actually blocks going live:

1. **No deploy pipeline (item 1).** CI verifies and then stops. Still the
   largest gap between "green" and "shipped".
2. **Secrets in environment variables (item 4).** Fine locally, wrong for
   production; the startup guards already refuse weak values, so what is
   missing is storage and rotation.
3. **Per-instance rate limits (item 3b).** Correct for one instance, wrong
   the moment there are two.
4. **Branch protection (item 2).** Needs a paid plan; the pre-push hook
   covers the realistic case.

### I. The internal routes' rate limit is unreachable in practice

**Severity: low (defence-in-depth only) · Effort: low**

Found while testing the rate-limit key generator, by trying to observe the
per-caller bucket on an internal route and failing.

`service-auth` runs as a `preHandler` and rejects an unsigned internal call
with 401. The limiter runs earlier, at `onRequest`, and does consume its
counter — but the *response* is a 401 either way, so an unsigned flood never
sees a 429. Measured: eight requests against a configured limit of three
returned 401 every time.

That is the correct outcome for an unsigned flood, and cheap: the 401 costs
no database work. The consequence worth stating is narrower — **the
per-caller keying that the long comment in `app.ts` justifies is only ever
exercised by correctly signed traffic**, i.e. by game-socket itself. Its
protective value is against a legitimate caller looping, not against an
attacker, who is stopped one hook later regardless.

Nothing here is wrong, and the keying decision is still right (an IP-keyed
limit on internal routes would throttle the whole platform — see the comment
in `app.ts`). It is recorded because the comment reads as though the limiter
is the internal API's front-line defence, and it is not; service-auth is.

The tests reflect this: the keying test runs against `/public/*`, where the
difference between the two strategies is observable, with a note explaining
why the internal route cannot show it.

### H. The production balance guard covers the set case, not the unset one

**Severity: medium (production only) · Effort: low**

Found while writing the `startupGuards` tests, by asking what the guard does
*not* refuse.

`assertStartupConfig` refuses `INITIAL_PLAYER_BALANCE` in production when it
is set to a positive value — correctly, since that grants free money to every
new player. But `packages/ledger/src/players.ts` reads:

```ts
const INITIAL_BALANCE = Number(process.env.INITIAL_PLAYER_BALANCE ?? 100_000);
```

So **unsetting** the variable does not give a zero starting balance — it gives
100,000 minor units, the development default, and the guard is satisfied. The
one configuration the guard forces you toward in production is the one that
still hands out free money. Passing the guard requires setting it explicitly
to `0`, which nothing states and nothing checks.

The module comment above that line already says the right thing ("in a real
deployment … this default would be zero"), so this is a default that
contradicts its own documented intent rather than an unconsidered one.

Options:
- **Default to 0 and let development set it explicitly.** The safe direction:
  a missing value grants nothing, and `infra/docker-compose.yml` already
  passes `${INITIAL_PLAYER_BALANCE:-100000}`, so local behaviour is unchanged.
- **Guard the unset case too** — refuse to boot in production unless the
  variable is explicitly present, whatever its value.

Not done here because it is a behaviour change on the money path rather than
a test, and it deserves its own commit with a real-stack check. The tests
added for the guard pin the current behaviour, including the deliberate
acceptance of an explicit `0`.

### G. A real finding from writing this list

**The publish gate's measured RTP is part assumption.**
`simulateClient.ts` scores a triggered bonus at a flat
`ASSUMED_BONUS_RETURN_MULTIPLIER = 20` rather than playing the module, and
that figure flows into `bonusRtp` → `resultRtp` → the tolerance check that
decides whether a game may publish.

The file is admirably honest about it ("It is an assumption, and it is
stated here rather than buried"), and the reasoning is sound: playing the
module would conflate "is the base game's maths right" with "is the bonus
module's maths right", and a drift in either would look identical.

But the consequence is worth stating plainly, because it is not obvious
from the publish route. **Measured on `reference-5x3`, 60k spins, varying
only that constant:**

| Assumed bonus return | Measured RTP | vs. target 0.95, tolerance ±0.05 |
|---:|---:|---|
| 5x | 0.9098 | **refused** — drift 0.040 is inside tolerance, but only just |
| 10x | 0.9052 | borderline |
| 20x (today) | 0.9518 | passes comfortably |
| 50x | 1.0783 | **passes nothing** — drift 0.128, correctly refused |

So the constant moves the gate's own input by roughly **0.17 RTP**, against
a tolerance of 0.05. It is not a rounding detail: it is larger than the
band it is being compared against. A game tuned to 0.95 passes or fails
substantially on the strength of an assumption about a module the
simulation never played.

The reference game happens to land well at 20x, which is why nothing has
surfaced this in practice.

**A second measurement, from writing `simulateClient.test.ts`:** the
simulation is unseeded, so each run is an independent sample and two runs of
the *same* configuration differ. Measured on `reference-5x3`:

| Spins | Run-to-run spread, multiplier unchanged |
|---:|---:|
| 20,000 | **0.0512** |
| 60,000 | ~0.0148 |
| 100,000 | ~0.0196 |

At the 100k the publish gate actually uses, sampling noise is roughly 0.02
against a tolerance of ±0.05 — so noise alone consumes about **40% of the
tolerance budget** before the bonus assumption is considered at all. The two
sources compound: a game near the edge of tolerance can pass or fail on
which sample it drew, and re-running a refused publish may simply succeed.

That makes a third option worth listing alongside the ones above:

- **Seed the simulation** so a publish decision is reproducible. A designer
  who is refused should be able to re-run and get the same answer, and a
  stored report should be checkable later. This is independent of the bonus
  assumption and probably cheaper than either fix for it.

Ranked below the section-A items because it is a known, documented
approximation rather than a defect — but it is the most substantive thing
found while writing this list, and it was found by reading the file rather
than by any test.

Options, none free:
- **Derive the multiplier per module** from its own configured payouts,
  which is exact for `wheel` (it resolves at start from a fixed segment
  set) and estimable for `pick`.
- **Simulate the module for real** behind a flag, accepting the conflation
  in exchange for a true number.
- **Surface it in the publish response** so a designer sees "measured RTP
  0.95, of which 0.12 is an estimated bonus contribution" rather than one
  figure implying uniform confidence.

### F. What I would NOT do next, and why

Recorded so the reasoning is not rediscovered:

- **More `math-engine` tests.** `paylines`, `matrix`, `wild`, `scatter`,
  `bonusTrigger` and the independent cross-check are all done. `pick.ts` was
  skipped deliberately — it already has nine tests including the concurrency
  interleave and the prize-tile guard.
- **Testing the fixtures** (`reference-game.ts`, `pick-bonus-game.ts`).
  They are data. Their properties are asserted where they are used.
- **Barrel files** (`index.ts` re-exports, 2–12 lines each). Nothing to
  test.
- **A Redis-backed limiter.** Scaffolding for a scale this deployment is not
  at — see "Deliberately not doing".

---

## Deliberately not doing

- **Load-testing beyond one player.** The interesting races are all
  per-player; cross-player contention shares no state worth racing.
- **A second RNG algorithm.** Rounds record `rngAlgorithm` so a future one
  can be added without breaking replay. Adding one now would be
  scaffolding for a need that does not exist.
