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
| F22 | **`?limit=abc` on `/v1/audit` returned the entire audit log**, through the one expression whose purpose is bounding it. `readAuditLog` clamped with `Math.min(Math.max(limit, 1), 500)`, and the route builds that value with `Number(limit)` straight off a query string — so a non-numeric one arrives as `NaN`. No comparison with `NaN` is ever true, so the clamp evaluates to `NaN` rather than to a bounded number, and the driver reads a `NaN` limit as **no limit at all**. Measured on the running service: 142 entries returned against a configured maximum of 500 and a default of 100, from an unauthenticated-by-shape query any operations user could type. Unbounded in the only sense that matters — the response grows with the collection forever. `clampLimit` now refuses any non-finite value and falls back to the default rather than the maximum. | Writing the first tests for `audit/log.ts`. The clamp was the first thing that looked worth a boundary test, and `Number("abc")` was the second case tried. `fakeMongo` returns `[]` for the same query — **more restrictive than Mongo**, so every existing test would have shown a bounded page while production served the whole collection; that disagreement is now pinned by three conformance tests. Verified live, before and after. |
| F23 | `writeAuditLog` spread the caller's entry **after** the generated `entryId` and `timestamp` (`{ entryId: randomUUID(), ...entry }`), so a caller supplying either field overwrote the generated one — able to backdate an entry or collide an id in the one record whose entire value is that its writers cannot shape it. Latent rather than live: `Omit<…, "entryId" \| "timestamp">` forbids it at compile time and no call site passes them, so this only bites where the type has been cast around. The spread now comes first. F18's shape exactly — a safe-looking function one ordering away from being unsafe. | The same first tests, from a case written to pin the *promise* the docstring makes ("no update or delete anywhere in this module"). It failed, which was not the expected outcome; checking the call sites established it was unreachable today rather than a live hole. |
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

### ~~3. Account lockout is a denial-of-service lever~~ — mitigated

**Exponential backoff shipped**, the option this item called "probably the
best next step".

The lever is not gone — nothing removes it short of not locking at all — but
the asymmetry has changed. Each *consecutive* lockout on one account doubles
the wait, and only a **successful login** resets the count:

| Lockout | Wait |
|---:|---:|
| 1st | 15 min (unchanged) |
| 2nd | 30 min |
| 3rd | 60 min |
| 4th+ | 120 min (capped) |

Measured with production defaults: 70 guesses against one account now cost
an attacker **9.8 hours** of wall clock, against 1.8 hours under the flat
window — a 5.4x collapse in sustainable guessing rate. A legitimate user who
mistypes their password still waits exactly the fifteen minutes they waited
before.

**The cap is the part that keeps this a mitigation rather than a trade for
something worse.** Uncapped doubling would let anyone who knows an
administrator's email push that account's wait to weeks, which is a *better*
denial-of-service lever than the one this item is about. Two hours is long
enough that grinding is pointless and short enough that a targeted
administrator recovers the same day with nobody's intervention.
`LOGIN_MAX_LOCKOUT_MINUTES` tunes it.

The history is deliberately **not** aged out by `attemptWindowMs` the way the
attempt count is: a patient attacker who waits out each lock and starts again
is precisely the case backoff exists to slow, and forgetting between windows
would reset them to a fifteen-minute penalty forever. The TTL on `expiresAt`
still reaps a document nobody returns to.

**A bug found while building it**, worth recording because it made the
feature nearly useless while looking correct: the attempt count was never
reset when a lock was applied, so it kept climbing past the threshold and
*every* subsequent failure satisfied `attempts >= maxAttempts`. One
uninterrupted burst therefore escalated the backoff once per attempt rather
than once per lockout, reaching the cap without the attacker ever waiting out
a single lock. Found by tracing the stored document across four failures and
seeing `consecutiveLockouts` reach 3 when the account had genuinely locked
twice. Now covered by a regression test.

Verified against the live stack, since a stored-field change is the F9 blind
spot: 15 → 30 → 60 → 120 minutes observed through the running service, the
new field persisting through Mongo's real validator, and a successful login
resetting the count to zero.

Still open, and still the honest alternatives if this proves insufficient: a
CAPTCHA or proof-of-work after N failures, or requiring a second factor once
the count is high.

### ~~3d. `runRngTestSuite`'s aggregate cannot be tested~~ — closed

**Fixed.** Both routes listed here were taken, because each closes a
different half.

**`createRng` now honours its `algorithm` parameter.** It previously
accepted the parameter, named it in an error message, and returned
xoshiro256** regardless — decorative, exactly as this item said. It now
dispatches through a registry and *refuses* an unknown algorithm rather than
silently defaulting. That last part matters beyond testing: a round recorded
under an algorithm this build cannot construct must fail loudly at replay,
because quietly substituting the default would produce a different outcome
and present it as the original. `registerTestAlgorithm` makes a
deliberately-broken generator injectable, so the suite reporting a failure at
all is now testable.

**`aggregatePassed` is extracted as a pure function**, and this is what
actually killed the `every` → `some` mutation. Injecting a broken generator
proves the suite *can* fail, but it cannot distinguish the two operators:
the three sub-tests share a seed and a draw stream, so any distortion large
enough to fail one fails all three. That was measured, not assumed — six
deliberately-broken generators were tried (a constant, an even-only integer
source, a sawtooth, a repeat-every-second-draw, and two range-squeezed
variants) and every one failed all three sub-tests. A conjunction over
constructed results has no such problem.

All six mutations on this path are now caught, including the two this item
existed for. Verified against the live stack: round replay still produces
the identical seed and outcome, which was the real risk in touching
`createRng`.

### ~~3c. `e2e:backoffice` can exhaust the login rate limit~~ — closed

**Fixed, both halves, and the investigation found a third mechanism this
item did not know about.**

The suite signs in many times — the bootstrap admin, then every user it
creates. The failure used to surface as `a deactivated user cannot sign back
in — got 429`, which reads like a broken deactivation check; the suite then
passes on retry, so it looked flaky rather than explained.

- **The e2e client now names a 429 at the source.** Caught in `api()` rather
  than at one call site, so every login is covered, and it exits non-zero
  with an explanation instead of letting a check report the wrong thing.
- **CI raises `LOGIN_RATE_LIMIT` for its stack**, the way it already raises
  `GAME_RATE_LIMIT` for the load check. The default is unchanged everywhere
  the limiter is the thing being trusted.

**The third mechanism.** Verifying the fix by deliberately exhausting the
limit revealed that **two different defences return 429 here**, and the first
version of this message blamed the wrong one:

| | Where it lives | Survives a restart? | Raising `LOGIN_RATE_LIMIT` helps? |
|---|---|---|---|
| Per-IP login limiter | process memory | no | yes |
| Per-account lockout (F10) | `loginAttempts` in Mongo | **yes** | **no** |

F10's lockout counts consecutive failures against one *email* and is
deliberately not the same defence — its whole purpose was that an attacker
spreading attempts across many addresses should still be stopped. So it
ignores the per-IP limit entirely. The message now reads the response body
(`account_locked` names it) and tells the two apart, because sending someone
to raise a limit that cannot help is worse than the original confusion.

Verified: with the lockout cleared, the suite runs **twice back to back and
passes both times** — the exact case this item described as failing.

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

### ~~5. Bonus session rows are never reaped~~ — archival policy shipped

The correctness half was already fixed (F12): `stepBonus` checks the deadline
on every read, so expiry is a property of the data rather than of a process
being alive. What remained was housekeeping — resolved and abandoned sessions
accumulating forever.

**Archival is now separate from expiry, and the separation is the whole
point.** A TTL keyed on the session's own fifteen-minute deadline would have
been the wrong fix, for the reason this item already recorded: `abandoned` is
a meaningful state, not garbage. A player returning to a timed-out bonus gets
a precise 410 `bonus_session_abandoned`; delete the row and they get "no such
session", which is strictly worse information on a money path.

So the row carries its own `archiveAfter`, set **two years out**, with a
`expireAfterSeconds: 0` TTL index on that field alone:

| | When | What it does |
|---|---|---|
| Abandonment | 15 min | Status change. Row stays, 410 stays precise. |
| Archival | 730 days | Row is finally removed. |

Two years is a *retention* decision, not a technical one — chosen to sit
beyond the periods gambling regulators typically require for player-dispute
records, and overridable per deployment via `BONUS_SESSION_RETENTION_DAYS`
rather than by patching code. A misconfigured value falls back to the default
rather than shortening the window: too long merely costs storage, while too
short destroys the evidence for a dispute about money that was or was not
paid.

**One thing worth knowing, measured rather than assumed:** Mongo's TTL
monitor only reaps a field that is a genuine BSON `Date`. An ISO *string*
there is silently ignored — the row would live forever and nobody would
notice for two years. Confirmed against real MongoDB (the Date row was
reaped, the string and absent rows survived) and now pinned by a conformance
test.

Rows predating this change have no `archiveAfter` and are therefore never
reaped, which is the safe direction: the deploy that adds the index does not
delete history.

Verified against the live stack: the index exists on the real database, a
newly created session is stamped `Date +730 days`, and `applySchemas` applies
cleanly to the existing database (the F2 check).

### ~~6. The load check's bonus race depends on a seeded fixture~~ — surfaced

The dependency itself is unchanged and still correct: section 4 needs
`pick-bonus-5x3`, which is a **test instrument** with a deliberately broken
RTP (100% bonus trigger rate), so seeding it into every environment would be
worse than skipping. CI sets `SEED_TEST_FIXTURES=true`.

What was actually wrong was the *reporting*. A skip printed mid-run scrolls
away, and the summary then said "All load checks passed" whether four
sections ran or two — a true sentence giving a false impression, in the one
script whose entire purpose is evidence about the money path.

Skips are now collected and restated in the summary, each with its reason and
its remedy, and a partial run says plainly that it **establishes less than a
complete one**. A full run now makes the positive claim explicitly: "every
section ran".

Both paths were verified against the live stack — a complete run, and a run
pointed at an unpublished bonus game.

The same treatment covers section 3's skip (item 8, the overdraw random
walk), which had the identical problem.

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

**The first sweep of this section is closed** — every row below it is struck
through. The rows at the top are a *second* sweep, run the same way (every
source file checked for a sibling test, then for indirect coverage through a
route suite) after the first was complete. They are what that sweep found, and
they are ordered by what a failure would cost.

| Module | Lines | Why it matters |
|---|---:|---|
| ~~`packages/rng/src/gamma.ts`~~ | 81 | **Done, and it found item J.** Hand-implemented numerics — a Lanczos `logGamma`, a series expansion and a Lentz continued fraction — with no direct test at all, producing the p-value a regulator is handed as evidence the generator is sound. 15 tests, 7 of 8 mutations caught, checked against an exact closed form rather than against the implementation's own output. The single survivor is a documented equivalent mutant. `stats.test.ts` had been reaching this file through one caller at points where published tables stop, which is why the tail went unchecked for so long. |
| ~~`backoffice-api/src/audit/log.ts`~~ | 51 | **Done, and it found two bugs — F22 and F23.** 22 tests, 12 of 13 mutations caught; the survivor (removing `Math.floor`) is a documented equivalent, since both the driver and the fake already truncate a fractional limit. The suspicion that put this row second — "the clamp has all the usual off-by-one edges" — was right about the location and wrong about the mechanism: the hole was not an off-by-one but `NaN` defeating every comparison in the clamp at once. Both contracts are now pinned — the swallow-and-report promise in four states, the bound in seven — plus three conformance tests for the fake/Mongo `limit` disagreement that hid F22. |
| `packages/math-engine/src/registry.ts` | 42 | The swap point for "how a spin is evaluated". `getMathEngine` throws rather than falling back to the default, and the comment says why: quietly paying a round out under different maths than the game asked for is worse than refusing the spin. That refusal is the whole safety property and nothing tests it. Small, cheap, and on the money path. |
| `game-backend/src/rounds/games.ts` | 62 | Resolves the game definition a round is evaluated against. Reached only through the route suites today, so a failure names a route rather than the lookup. |
| `game-backend/src/launch/consume.ts` | 26 | Single-use launch-token consumption. `routes/misc.test.ts` covers 409-vs-401 at the HTTP boundary, so the *behaviour* is pinned; what is missing is a direct test of the claim at the level it is made. Lower priority than the rows above for exactly that reason. |
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
| ~~`backoffice-api/src/games/publish.ts`~~ | 131 | **Done.** 27 tests, all 14 mutations caught. Runs the real 100k simulation (~1s per publish) rather than a stub — a stubbed one would let the gate pass against numbers no game produces, and the gate is the subject. Two mutations survived the first pass and both were real gaps: a one-sided RTP gate (dropping `Math.abs` waves through the direction that *loses* money), and a hardcoded `gameVersion: 1` that only a second publish exposes. |
| ~~`backoffice-api/src/auth/passwords.ts`~~ | 73 | **Done, and it was not subtle.** 29 tests; found F19 (a truncated hash verified — 274 guesses to log in as anyone) and F20 (a malformed cost threw a 500 instead of returning false). 7 of 10 mutations caught; the three survivors are documented equivalents in the file header, not silence. Verified against the live stack, including all 12 pre-existing hashes in the real database and planted corrupt records. |
| ~~`game-backend/src/routes/*.ts`~~ | ~250 | **Done, all six.** `rounds` (27 tests), `bonus` (22), and `public`/`launchTokens`/`simulate`/`health` plus the service-auth hook (29). Every typed error mapping on the money path is now pinned: 404/400/402 on spin, 404/410/400 on bonus (410-vs-404 is F12's distinction), 409-vs-401 on a spent launch token. All mutations caught. |
| ~~`shared-types/src/money.ts`~~ | 84 | **Done.** 26 tests, all eight mutations caught. The "no minor unit created or lost" property is pinned exhaustively over totals 0–60 × parts 1–12, plus a spread check — summing correctly is not enough on its own, since `[total, 0, 0, …]` also sums correctly. Adapted from the reference's `money.test.ts` (near-identical module), extended with the cases it lacked: negative totals, `-0`, and the `70.07 * 100 = 7006.999…` float error that is the reason this module exists. |
| ~~`shared-types/src/rbac.ts`~~ | 65 | **Done.** 14 tests, all six mutations caught. Note the file is types plus `ROLE_IDS` and `toPublicUser` — there are no "permission sets" here, so this row overstated it; authorisation lives in `requireRole`. Writing the tests found F18. |

### C. Frontend — the request layers are now covered

`game-frontend/src/api.ts` (20 tests) and `backoffice-frontend/src/api.ts`
(15 tests) are done. Between them they close all three of the specific
concerns this section originally raised, and the review's frontend
assessment — made against a *different* codebase — was checked here rather
than assumed:

- **The client never computes a win amount.** Confirmed: it assigns
  server-sent balances and renders `round.evaluation.totalWin`. Pinned by a
  test asserting a spin message carries exactly `betAmount`,
  `clientRequestId` and `type` — no identity, no balance.
- **A stored session token must never substitute for a missing launch
  token.** Confirmed in both directions: a reconnect sends the *session*
  token (a launch token is single-use, so resending it would bounce the
  player to the lobby), and when the server issued no session token the
  launch token is used rather than a token being invented.
- **1013 (busy) and a refused handshake.** Both now exercised: a 1013 close
  raises `onDisconnected`, a refused handshake raises
  `onError("connection_failed")`, and a send on a closed socket reports
  `not_connected` instead of throwing.

**Better than the review credited:** neither frontend touches `localStorage`
*or* `sessionStorage`. Both keep the token in memory only. Both suites pin
the absence of any storage write, since a future "keep me signed in" is
exactly how that regresses.

The backoffice's 401 handling is the client half of `tokenVersion`
revocation: the backend makes a demotion take effect on the next request,
and this is what turns that 401 into a return to the login screen. Tested
alongside the two cases that must NOT log a user out — a failed login (401
with no session) and a 403 (signed in, not permitted).

One real fix fell out: `import.meta.env` is injected by Vite and undefined
anywhere else, so reading a property off it threw and made these modules
unimportable from a test. Both now use `import.meta.env?.` — guarded in the
source rather than worked around in the test, because a module only one
toolchain can load is why these had no tests at all.

**Still untested:** the React components (`screens/*.tsx`,
`gameBuilder/*.tsx`), `renderer.ts` and `main.ts`. These need a DOM
environment and a component testing library, neither of which this repo has
— a deliberate stopping point rather than an oversight. The logic worth
testing was extracted into `paylineGrid.ts`, `reelStrip.ts` and the two
`api.ts` files, all of which are now covered.

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
- **A fixture that is already minimal cannot test an allowlist.**
  `toPublicView` maps each bonus module down to `moduleId` and `params`.
  Both shipped fixtures happen to have exactly those two fields, so
  replacing the map with a straight pass-through changed nothing observable
  and the mutation survived. The allowlist exists for the day a module
  gains a field — so the test now seeds a module carrying `segmentWeights`
  (the odds) and an internal note, and asserts neither ships. Applies to any
  allowlist tested against data that is already inside it.
- **`docker compose up -d --build` can report success without rebuilding.**
  Adding `@slots-engine/rng` to `apps/backoffice-api/package.json` without
  regenerating `package-lock.json` left the two out of sync, and the image
  build's `npm ci` could not install it — yet compose still printed
  "Container ... Started" and the service came up healthy on the OLD code.
  The change looked deployed and was not; the live audit records were the
  only thing that showed it, and only because they were checked. Two
  habits follow: run `npm install --package-lock-only` in the same commit as
  any workspace-dependency change, and verify a deploy by asserting on
  behaviour (or `docker exec ... grep` the built output) rather than by
  reading compose's output.
- **A cross-package mutation needs a rebuild to mean anything.** Packages
  are imported through their built `dist/` (`"main": "./dist/index.js"`), so
  editing `packages/math-engine/src/...` and re-running a test in
  `apps/backoffice-api` tests the OLD code — the mutation "survives" while
  never having been applied. Caught when the two most important mutations on
  the simulation seeding both survived; with `npm run build:packages` between
  the edit and the run, both were caught immediately. Audited the rest of
  this session's mutation work: every other run used a same-package relative
  import, which resolves to source, so only this one was affected. Worth
  knowing because a false "survived" and a false "caught" look identical in
  a pass/fail count.
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
- **A stand-in can hide a bug by being *stricter*, not just looser.** F16,
  F17 and F21 were all the fake being more permissive than Mongo. F22 is the
  mirror image: `limit(NaN)` returns `[]` from the fake and the **entire
  collection** from Mongo, so a test would have shown a safely-empty page
  while production served an unbounded scan. The rule in section D was
  written as "suspect the fake before the code" and still holds — but the
  tell is any *disagreement*, in either direction, not permissiveness
  specifically. Where the two genuinely differ and the fake should not be
  changed to match, pin the difference with a conformance test that asserts
  both behaviours, so the divergence is written down rather than latent.
- **Malformed input reaches a clamp as `NaN`, and `NaN` defeats a clamp
  silently.** `Math.min(Math.max(x, 1), 500)` looks total — it names both
  bounds — but every comparison against `NaN` is false, so it returns `NaN`
  rather than either bound. Anywhere a query-string value becomes a number
  and then meets a range check, the range check is not the guard it appears
  to be. `Number.isFinite` before the clamp, and fall back to the *default*
  rather than the maximum: a caller who asked for something unintelligible
  has given no reason to hand them the largest possible result.
- **Two arrangements of the same mathematics are a free oracle.** Item J was
  found by diffing `gamma.ts` against the reference's copy — same methods,
  different composition — and noticing that ours reaches the upper tail
  through two subtractions from 1 where theirs reaches it directly. Neither
  file has a test, so no suite could have caught it; but running both on the
  same inputs gives a differential check that needs no table of expected
  values and no independent implementation. Cheap wherever the reference has
  a counterpart of a *pure* function, and it costs one `diff`.
- **A test suite can be honest about its inputs and still leave a gap.**
  `stats.test.ts` says plainly that it compares against standard chi-squared
  table values rather than its own output, which is the right discipline and
  is why it is trustworthy. Published tables stop around p ≈ 0.001, so the
  discipline itself confined the file to the range where `gamma.ts` is
  correct. The gap was not sloppiness — it was the boundary of a good method,
  and finding it needed a different method rather than more care.
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

### ~~J. The RNG report cannot express a p-value below ~1e-16~~ — fixed

**Severity: low (reporting fidelity — no verdict was affected) · Effort: low**

Found by reading `gamma.ts` against its counterpart in the reference repo,
which is the routine at the top of this file working as intended. The two
implementations are the same mathematics arranged differently, and the
arrangement here loses precision in the tail.

`upperRegularizedGamma(s, x)` returns `1 - lowerRegularizedGamma(s, x)`, and
in the far tail `lowerRegularizedGamma` is itself `1 - upperContinuedFraction`.
So a small p-value is subtracted from 1 **twice**. The continued fraction
computes it accurately, and then both subtractions throw the accuracy away:
once `p` is below the spacing of doubles near 1 (~1.1e-16), `1 - (1 - p)`
collapses to `0`. The reference's `chiSquarePValue` returns the continued
fraction directly and has no such floor.

Measured, comparing the two arrangements on identical inputs:

| df | χ² | Ours | Correct |
|---:|---:|---|---|
| 10 | 50 | 2.669083e-7 | 2.669083e-7 |
| 10 | 100 | **0** | 5.449702e-17 |
| 10 | 400 | **0** | 9.413292e-80 |
| 255 | 1000 | **0** | 9.378477e-89 |
| 255 | 2000 | **0** | 6.879590e-268 |

Everything above ~1e-16 agrees to ten significant figures, so this is purely
a tail effect. Resolution degrades before the floor is reached, too: between
1e-10 and zero at df=10, this arrangement can represent **2,070 distinct
p-values** where the direct one represents 13,184.

**No verdict is wrong, and that is the reason this is ranked low rather than
as an `F` row.** `passed` is `pValue > 0.005 && pValue < 0.995`, and `0` fails
that band exactly as `1e-17` does. Checked exhaustively rather than argued:
**54,374 (df, χ²) pairs across df ∈ {9, 10, 99, 255} produced zero pass/fail
disagreements** between the two arrangements. The upper end is unaffected —
near `p = 1` the subtraction is harmless, and both agree to full precision.

What is actually lost is the *evidence*. A report is meant to let a reviewer
see how badly a generator failed, and `pValue: 0` cannot distinguish "failed
by a hair beyond the floor" from "failed by 250 orders of magnitude". It also
reads as a computed zero, which no continuous distribution ever genuinely
produces — an alert reviewer would rightly ask whether the number means
anything at all. For an artefact whose whole purpose is being checked by
someone external, that is the wrong failure mode even when the verdict is
right.

**Fixed as described.** `upperRegularizedGamma` is now the primitive —
continued fraction when `x >= s + 1`, `1 - series` otherwise — and
`lowerRegularizedGamma` is defined in terms of it rather than the reverse.
Neither numerical method changed; only which one is reached without a
subtraction. The series branch still subtracts, but there Q is near 1 where
the spacing of doubles is ~1e-16 *relative*, which is harmless.

The precision loss has not been eliminated so much as **moved to the
direction where it does not matter**: `lowerRegularizedGamma` now carries it,
and for a very small Q the value of P genuinely is 1 to within double
precision. Nothing reports a p-value through P, and this is recorded in the
source so a later reader does not "fix" it back.

`gamma.test.ts` is new — 15 tests, 7 of 8 mutations caught. The expected tail
values come from an **exact closed form** for integer `s`
(Q(s,x) = e^-x · Σ x^k/k!, summed in log space), which shares no code path
with the implementation and never forms `1 - p`, so it stays accurate exactly
where the implementation was suspected. Reverting the fix is caught. The one
survivor — deleting `logGamma`'s reflection branch — is an equivalent mutant
and is explained in the file header rather than left silent: this Lanczos
coefficient set is accurate below 0.5 unaided (worst disagreement 1.7e-15),
and `s = df/2 ≥ 0.5` means chi-squared cannot reach that branch at all.

**A false "survived" along the way**, worth recording because section D warns
about exactly this and it still happened: the first mutation run reported the
reflection branch as surviving, but the `perl` regex had not matched and the
file was unmodified. A mutation that was never applied and a mutation that
was applied and survived are indistinguishable in a pass/fail count. Every
survivor now gets a `grep` confirming the edit landed before it is believed.

Verified through the real public API, not just the unit under test: a healthy
200k-draw report is unchanged (p = 0.28–0.90, all passing), and a failing
generator now reports 5.449702e-17 and 9.413292e-80 where both previously
printed `0`. The full suite is green at 986 tests, and `stats.test.ts` and
`prng.test.ts` are unaffected — checked after `npm run build:packages`, since
`stats.ts` reaches this file through the built `dist/`.

### ~~H. The production balance guard covers the set case, not the unset one~~ — fixed

**Both options taken**, because each closes a different half and neither is
sufficient alone.

**The ledger now defaults to 0.** `packages/ledger/src/players.ts` used to
read `Number(process.env.INITIAL_PLAYER_BALANCE ?? 100_000)`, which
contradicted the comment directly above it and defeated the guard next door:
`assertStartupConfig` refused a *positive* value in production, so the one
configuration it pushed an operator toward — leaving the variable unset —
was the one that still handed 100,000 minor units to every new player. The
safe direction for a money default is the one where forgetting to configure
it costs nothing.

**The guard now also refuses the unset case in production.** With the ledger
defaulting to 0 that is no longer load-bearing for safety, but it makes the
starting balance a decision someone wrote down rather than a default nobody
examined. `INITIAL_PLAYER_BALANCE=0` is the correct production setting and
passes; absent or empty refuses with a message saying so.

Local development is unchanged: `infra/docker-compose.yml` already passes
`${INITIAL_PLAYER_BALANCE:-100000}` explicitly, and `e2e:spin` passes against
the rebuilt stack.

The value is also now read **per call** rather than captured at module load
(so behaviour cannot depend on import order), floored to an integer, and
clamped to 0 for a negative or non-numeric setting — a `NaN` balance written
by `$setOnInsert` would make every later comparison false, leaving a player
unable to bet and unable to be seen as having nothing.

Verified against real production containers, both directions: `NODE_ENV=production`
with the variable absent refuses to boot with the intended message, and with
`INITIAL_PLAYER_BALANCE=0` it passes the guard and proceeds to connect.

Three test suites now set `INITIAL_PLAYER_BALANCE` explicitly at the top of
the file, because a player must be funded to spin at all — which is a better
statement of the precondition than inheriting it from a global default.

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

**Two of the four options are now done.**

- ~~**Seed the simulation**~~ — shipped. `runSimulation` takes a `runSeed`,
  and the publish gate always passes one, recording it on the report and in
  the audit entry. The same seed reproduces a verdict exactly; a different
  seed still samples independently, so this removes the coin-flip without
  pretending the noise is gone. Per-spin seeds are *derived* from the run
  seed rather than the run sharing one stream, preserving the property that
  each spin takes its own 32-byte seed on the same path a real round uses.
  Verified against the live stack: a publish decision made by the running
  service replays from its audit record to the same RTP to twelve decimal
  places.
- ~~**Surface it in the publish response**~~ — shipped. The report carries a
  `confidence` block naming what was measured (`baseRtp`), what was estimated
  (`bonusRtp`), the multiplier that produced it, and the estimated share of
  the whole verdict. Measured on `reference-5x3`: **about 8% of the number
  the gate compares against is assumed rather than played.** The audit entry
  records that share, so a later reader can tell how much of a decision
  rested on a module the simulation never ran.

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
