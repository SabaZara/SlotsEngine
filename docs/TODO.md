# Known bugs, gaps and next steps

Numbered items keep their original numbers forever, so a commit message or a
comment referring to "item 3b" still resolves years later. That means the
numbering is **not** a priority order and has not been one for a while — read
section E for what actually blocks going live.

Status key: **Open** · **Open (accepted)** — a known limitation we have
decided to live with for now, recorded so it is a decision rather than an
oversight. A struck-through heading is closed, and the entry is kept rather
than deleted because in almost every case the *reasoning* outlived the fix.

## Where this stands

**Everything testable is tested. What remains is a provisioning decision, a
storage decision, and a short list of presentation work nobody is blocked
on.**

The frontend is no longer the thin part. As of 2026-08-17 it carries a Pixi
renderer, a phase model, artwork, per-game themes, audio, autoplay, a drawn
wheel bonus and a rotate prompt — and is **larger in source than the
reference client** (3,757 lines against 2,417) with roughly 38x the test
coverage (4,189 lines of tests against 110). The reference modules still unbuilt here are deliberate
non-decisions rather than gaps; section O names each and why.

- **28 bugs found and fixed** (F1–F28), each recorded below with *how it was
  found*. **Not one was found by a test that already passed** — the closest
  is F17, where a mutation of existing code exposed a stand-in that had been
  silently ignoring an operator. Counted:

  | How | Count | Which |
  |---|---:|---|
  | Writing the *first* test for a file | 9 | F13, F15, F16, F18–F23 |
  | Running the real stack | 9 | F1, F6–F12, F25 |
  | CI, on a clean checkout | 2 | F3, F4 |
  | Reading the reference repo | 2 | F5, F14 |
  | Mutation-testing existing code | 1 | F17 |
  | Found while fixing another | 2 | F2, F26 |
  | **Asking how a user reaches the feature** | **1** | **F24** |
  | **Reading configuration** | **1** | **F27** |
  | **Reading a shared component** | **1** | **F28** |

  **The last row is the first bug here no test could ever have caught**, and
  it is worth separating for that reason rather than for novelty. F27 is not
  a defect in code: the hardcoded value was *correct*, so the stack was
  healthy, every suite was green, and nothing was mis-serving anyone. What
  was broken was a **promise** — a variable that looked configurable and was
  not. That fails only on the next edit, by someone who changes a file, sees
  no error, and is quietly ignored. Tests assert what the code does; nothing
  here asserts what a config file *claims to offer*.

  **F25 sharpens what "running the real stack" means**, and it is worth
  separating from the other eight. The artwork editor was finished, green,
  and mutation-verified before F25 was found — and every one of those tests
  called `saveDraft` with an **object**, while the bug lived in what
  `JSON.stringify` does to `undefined`. No test that does not cross a network
  boundary could have seen it. The eight above are mostly "the stand-in
  models no validator"; this one is "the stand-in models no *wire*". Both
  point the same way: the suite establishes what the code computes, not what
  survives the trip between two processes.

  The last row is new and worth keeping separate rather than filed under one
  of the others. F24 was not a coverage gap: free spins was finished, tested
  by 30 cases, mutation-verified and confirmed against the live stack — and
  **none of that touched the path a designer would actually use**, because the
  fixture sets its parameters in code and every check therefore went around
  the editor. A feature can be complete on the money path and unreachable
  through the only interface that configures it, and no test asks that
  question unless someone does.

  The 9 and the 8 are the load-bearing rows, and they say different things.
  **Writing a file's first test found a bug 9 times across 57 test files** —
  roughly one in six, which is the argument for covering a module at all
  rather than covering an already-covered one more deeply. **Running the real
  stack found 8**, and no amount of test-writing substitutes for it: every
  one of those was invisible to a green suite, because the in-memory stand-in
  models no schema validator, no rollback, and no real index.

  The row that should be zero and is: **existing tests caught nothing**. That
  is not a criticism of them — a test that never fails is doing its job as a
  regression guard — but it does mean the suite's value here has been in the
  *writing*, and its value from here on is in the *guarding*.
- **1625 tests**, of which 53 are conformance cases run against real MongoDB
  and 86 are React component tests.
- **Sections A, B and C are closed** — no source module with meaningful
  logic is without a direct test. **The React components are no longer the
  exception**: section C's stopping point ("needs a DOM environment and a
  component testing library, neither of which this repo has") is closed, and
  the reason it moved is recorded there. F24 is the argument — a component
  was the one layer where a bug could survive every other check in this repo.
- **A third sweep has been run** (section A2), filtered differently: not
  "uncovered file" but **imported by many test files, asserted by none**.
  Two matched, both tiny and both load-bearing — the logger's redaction and
  the seed generator. It produced no F-row and one finding worth more than a
  bug: a predictable seed and a secure one produce **indistinguishable
  output**, so seven output tests passed against a clock-derived seed.
- **The deploy pipeline is built and green** (item 1). It builds five images
  per commit and stops, honestly, at the point where a server would be.

  It was **red for six consecutive runs on 2026-08-17**, and the fix is worth
  recording because the first attempt was wrong. Jobs died in "Set up job" —
  before checkout, before any build — because the runner could not download
  the `docker/*` action tarballs from codeload.github.com: 503, then 429,
  giving up after three internal attempts. The first theory was contention
  between five simultaneous matrix jobs, so `max-parallel: 3` was added; the
  next run disproved it, with **three separate** docker actions failing and
  the one job that succeeded simply being the one that ran last. The actions
  are now plain `docker` CLI calls — the runner already ships
  `/usr/bin/docker` with buildx — which removes the network dependency
  rather than shrinking it. Four consecutive green runs since.

  One consequence caught before it shipped: `type=gha` caching needs
  `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_CACHE_URL`, which `build-push-action`
  injected for free and a bare CLI call does not have — so it would have
  failed **silently** and every build would have been cold. Now a registry
  cache, which needs only the `docker login` the job already does.

The three things standing between this and a running service, in order:

| # | What | Blocked on |
|---|---|---|
| 1 | A host to deploy to (item 1) | A box and six secrets — a provisioning decision, not engineering. |
| 2 | Secrets in a managed store (item 4) | Choosing one. The deploy already injects them from GitHub rather than a committed file. |
| 3 | Shared rate limits (item 3b) | Redis, and it is also what blocks zero-downtime deploys. |

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
| F24 | **A designer could not select `freeSpins` at all.** The backoffice's game builder held its own hardcoded `KNOWN_MODULES = ["wheel", "pick"]`, so the moment a third module shipped the editor offered two and the engine played three — the new feature was unreachable through the only UI that configures it. The drift is silent in **both** directions and that is the point: a short list refuses a module that works, while a long one offers a module that does not exist, which publishes cleanly (the API cannot see a client array) and then fails at spin time, in front of a player, on the money path. The list is now served from `listBonusModules()` — the engine registry itself — via `GET /v1/bonus-modules`, so there is one copy rather than two. A draft naming a module this build lacks keeps its own id as an option labelled "not in this build", rather than being silently rewritten to whichever module happens to be first, which would change what a game pays without anyone choosing it. | Working down the free-spins follow-ups. The feature was finished, tested and verified live, and *none of that touched the path a designer would actually use* — the fixture sets its params in code, so every test and every live check went around the editor. Found by asking how a designer configures the thing that had just shipped. The same shape as the fixture/allowlist note in section D: a list maintained in a second place drifts, and nothing fails. |
| F28 | **Every hinted form field announced its explanation as its own name, and half of them named only their first control.** `Field` wrapped its children in a `<label>`, and everything inside a label becomes the accessible name — so a field with a hint announced as "BackgroundDrawn behind the reels. Empty means the built-in gradient.", the explanation read out as the field's identity on every focus. Worse and independent of the hint: a wrapping `<label>` binds to exactly **one** control, while half the rows here hold several ("Grid" is a reels box and a rows box, "Bet options" one per stake), so the label silently named the first and left the rest anonymous. No hint-level fix addresses the second. Now `role="group"` with `aria-labelledby` for the row and `aria-describedby` for the hint, plus an optional `label` on `TextInput` so an individual control carries its own name. | Reading the primitive while doing something else — the accessible-name problem was noticed in an `AssetsEditor` test that had to match `/^Background/` as a prefix to pass, and the prefix was the tell. **`Field` had no tests at all**, which is why it shipped: it is the component every backoffice screen is built from. It has four now, and all three mutations are caught, including reverting to the `<label>` wrapper. The `AssetsEditor` tests moved from `getByLabelText` to `getByRole("textbox", { name })`, which is the better assertion anyway — it pins the accessible name of the control a user focuses, which is exactly what regressed. |
| F27 | **`MONGO_URI` looked configurable and was ignored, and the value it advertised was wrong.** `docker-compose.yml` hardcoded the URI while every other variable beside it — `MONGO_DB` on the very next line, both secrets, `LOG_LEVEL`, `NODE_ENV`, `MONGO_HOST_PORT` — is interpolated from `.env`. Counted: **six wired, `MONGO_URI` the only one at zero**, so this was an oversight rather than a pattern. Editing it in `infra/.env` changed nothing, and nothing anywhere said so. Separately, the value `.env.example` advertised carried **`directConnection=true`**, which is a *host-side* flag: it suppresses replica-set topology discovery so the driver treats one node as a standalone. That is required when connecting from the host (the set advertises itself as `mongo:27017`, unresolvable outside the Docker network — which is why four test files default to `localhost:27018/?directConnection=true`) and **wrong in-network**, where it would quietly remove the topology awareness the money path's transactions rely on across a failover. Now `${MONGO_URI:-…}` with the correct in-network default, the flag documented on both sides of the boundary, and the variable added to `DEPLOY.md`'s table. | Reading config while chasing something else — a `.env` sourcing failure during the secret rotation showed `MONGO_URI` coming back empty, and `docker compose config` then showed the services holding a *different* value from the file. **Latent, not live:** the hardcoded URI was the correct one, so nothing was broken and no test could have failed. The danger was entirely in the next edit — someone pointing the stack at a managed cluster would have changed the file, seen no error, and watched it keep using the bundled Mongo. Verified by observing the behaviour change rather than by reading the diff: an override now reaches both services, and the staging overlay still resolves. |
| F26 | **A published game went on serving artwork that had been removed, and disagreed with its own audit snapshot.** `publishDraft` upserted the live `games` document with `$set`, which writes the keys it is given and leaves every other key in the existing document in place — so an optional field present in one publish and absent from the next survived on the live document indefinitely. Measured on the running stack: `reference-5x3` published as **v6 with no artwork**, `gameVersions` recorded v6 with no artwork, and `games` went on serving v5's URLs to players. The append-only snapshot and the document players actually read had **diverged**, which makes the audit trail wrong about the one thing it exists to establish — what maths and presentation a round was played under. Now a `replaceOne`: a published game *is* its `gameDef`, and no field on the live document legitimately outlives a publish. | Found by fixing F25 and then checking whether the clear had actually reached players. It had not. The test pins the invariant rather than the symptom — the live document must equal the snapshot of the version it claims to be — because asserting only on `assets` would pass again the moment a second optional field is added. Required teaching `fakeMongo` `replaceOne`, now pinned by **three conformance tests against real MongoDB** (fields dropped, `_id` preserved, upsert branch). |
| F25 | **Artwork could be added through the API and then never cleared.** Saving a draft is a patch — an absent key means "leave unchanged", which is what lets the editor save one field at a time — but `JSON.stringify` drops `undefined`, so "clear this field" and "do not mention this field" left the browser as **identical bytes**, and `saveDraft`'s `$set` cannot unset. The editor was correct throughout: its clear-the-last-symbol path returns `undefined` and is pinned by its own mutation-verified tests. The field emptied on screen, the save reported success, and the next reload brought the artwork back. Fixed at all three layers — the client converts a removal to an explicit `null` (the one value that survives JSON and cannot be confused with a legitimate one), the route turns that back into a deletion, and `saveDraft` emits a `$unset`. The removable-field list lives in `shared-types` because a field one end can null and the other will not unset fails silently in both directions. | Driving the live stack after the artwork editor was finished, green and mutation-verified — trying to *undo* the change I had just made. Every unit test passed throughout, because they all called `saveDraft` with an object rather than across a network, and `undefined` only disappears at the wire. The reference repo's `repair-corrupted-asset-urls.ts` is the same lesson from the other side: read shape and write shape diverging on an asset field, discovered after it had already corrupted production data. |
| F23 | `writeAuditLog` spread the caller's entry **after** the generated `entryId` and `timestamp` (`{ entryId: randomUUID(), ...entry }`), so a caller supplying either field overwrote the generated one — able to backdate an entry or collide an id in the one record whose entire value is that its writers cannot shape it. Latent rather than live: `Omit<…, "entryId" \| "timestamp">` forbids it at compile time and no call site passes them, so this only bites where the type has been cast around. The spread now comes first. F18's shape exactly — a safe-looking function one ordering away from being unsafe. | The same first tests, from a case written to pin the *promise* the docstring makes ("no update or delete anywhere in this module"). It failed, which was not the expected outcome; checking the call sites established it was unreachable today rather than a live hole. |
| F21 | `fakeMongo` honoured **exclusion** projections (`{ _id: 0 }`, the F16 fix) but ignored **inclusion** ones (`{ gameId: 1, name: 1 }`) entirely, so a projected list query returned whole documents in tests and three fields against real Mongo. The third time this same asymmetry has bitten — F16 fixed half of it and the other half went unnoticed because nothing tested it. Projection is now a shared `applyProjection` handling both shapes, including Mongo's quirk that `_id` rides along with an inclusion projection unless excluded, and it is applied **after** sort rather than before — Mongo sorts then projects, so a query may legally order by a field the caller never receives. | A `listDrafts` test asserting the summary shape failed against correct code. Pinned by three new conformance tests against real Mongo, one of them specifically for the sort-then-project ordering. |
| F19 | **`verifyPassword` derived a key of `expected.length` — the length taken from the stored record — so a truncated hash verified.** Shorten a stored digest to one byte and scrypt derives one byte, which matches roughly one guess in 256: measured, an arbitrary password verified against a 1-byte hash after **274 guesses**. Anyone able to write to a user record could downgrade an account to trivially guessable without knowing or changing the password. The required length is now fixed at `KEY_LENGTH` and a digest of any other length is refused. | Writing the first tests for `passwords.ts`. A shape test ("refuses a hash of the right length but wrong content") failed by returning `true`, which made no sense until the derive call was read closely. Verified on the live stack: a 1-byte hash planted in the real database now yields 401 for every guess. |
| F20 | `verifyPassword` **threw** on a stored cost that was not a power of two, or was large enough to exceed `maxmem` — Node's scrypt rejects both with `RangeError: Invalid scrypt params`. Its own docstring promised the opposite ("never throws on a malformed stored value — a corrupt hash must read as wrong password, not as a 500"). On the login path an uncaught throw is a 500 that confirms to an attacker that this particular account exists and is broken. Both are now refused before the scrypt call. | The same first tests. This is F13's shape exactly, one file over: a value parsed out of stored data and used without checking it is in the domain the callee accepts. Verified live — both cases return 401 through the running service. |
| F18 | `toPublicUser` returned the source `roles` **array by reference**, so `publicUser.roles.push("super_admin")` edited the underlying user record in place — a privilege escalation through the one function whose job is producing a safe copy. Latent rather than live (no caller mutates it today), and the fix is a one-line spread. | Writing the first tests for `rbac.ts`. The test was originally drafted to *pin the weakness*, which is backwards; checking whether it was exploitable took one script, and it was, so it was fixed instead. |
| F17 | `fakeMongo`'s `applyUpdate` handled `$set` and `$inc` and **silently dropped every other operator**. A `$unset` in a test did nothing, the document kept the field, and the test asserting on the missing-field fallback passed while asserting nothing. Same family as F16 — the stand-in more permissive than Mongo — but worse, because the test *looked* like it covered the branch. `$unset` is now implemented, and an unrecognised `$`-operator throws instead of being ignored. | Mutation testing the auth middleware. Changing `?? 0` to `?? -1` was the one mutation of twelve that survived; the test that should have caught it was the `$unset` one. Pinned now by two conformance tests, one of them against real Mongo. |
| F16 | `fakeMongo` ignored `projection` entirely, so `_id` survived in tests while the real routes correctly stripped it. **More permissive than Mongo**, which is the inverse of F1/F9 and just as misleading — a correct assertion ("no `_id` in the response") failed against correct code. The fake now honours `{ _id: 0 }` on `find` and `findOne`. | Writing route tests for `/v1/games/:gameId/versions`. The test failed, the route was right, and comparing the two engines directly showed real Mongo stripping `_id` and the fake keeping it. Now pinned by two conformance tests. |

---

## Open

### ~~1. No deploy pipeline — CI verifies, nothing ships~~ — built, and waiting on a host

**The pipeline exists and has run green.** `deploy.yml` builds five images
and pushes them tagged by commit SHA; `rollback.yml` puts production back on
a named earlier release. Full setup in `docs/DEPLOY.md`.

**Confirmed on a real run** (`fe7f406`), not just locally: all five images
are in GHCR at `ghcr.io/sabazara/<service>:fe7f406…`, the SHA matches the
commit CI passed, and the deploy job reported success **with a warning
annotation reading "No deploy target configured — images were built and
pushed, but nothing shipped."** Every step that would touch a server shows as
`skipped`. That is the intended state: green, but not claiming to have
deployed.

**The gate was exercised in both directions before it worked**, which is
better evidence than a first-try success would have been:

| Run | CI | Deploy | What it proved |
|---|---|---|---|
| `6102a5b` | **failed** | **skipped** | A red CI run ships nothing. |
| `4cd752d` | passed | **failed** | The gate lets a green run through — and surfaced the lowercase bug. |
| `fe7f406` | passed | **succeeded** | Five images pushed, deploy honestly skipped. |

**The design decision that mattered.** `deploy.yml` triggers on
`workflow_run` — waiting for CI to *finish* and reading its conclusion —
rather than on `push` alongside CI. The `push` form is the obvious shape, and
it is what the reference repo uses; it is also subtly wrong, because it makes
CI and deploy two independent reactions to the same event. They start
together, so a commit whose tests are still running, or have already failed,
gets built and shipped anyway. **The gate exists and gates nothing** — which
is this item's own complaint, reintroduced one layer down. The `build` job
additionally checks the parent run's conclusion, since `workflow_run` fires
on failure too.

**What is deliberately still missing: the host.** No deploy secrets are
configured, so the deploy job builds, pushes, and then stops with a warning
annotation and a summary naming exactly which secrets are absent. It does
**not** fail — a workflow red on every run trains everyone to ignore a red X,
and the first genuine failure then goes unnoticed. It does **not** pass
silently either, which would be this item's complaint a third time.

Building on every commit earns its place regardless: it proves the production
Dockerfiles still build from a clean checkout, which CI does not check. CI
builds with `npm run build` on the runner, never through the multi-stage
image.

**The first run failed, and the reason is worth keeping.** GHCR requires a
lowercase repository name; `github.repository_owner` is `SabaZara`, so all
five build legs died on `invalid tag ... repository name must be lowercase`.
The local-registry rehearsal below could not have caught it — it used
`localhost:5555` as the namespace and never exercised the owner name at all.
**A rehearsal that substitutes the value under test proves nothing about that
value.** The owner is now lowercased once per job (twice, since a step output
does not cross a job boundary) rather than at each of the four use sites, so
the tag pushed and the tag deployed cannot drift; the failure was then
reproduced locally with the raw owner and confirmed fixed with the lowercased
one.

That failure was also the pipeline's first real proof in the other direction:
the CI run before it went red, and **Deploy skipped rather than shipping** —
the `workflow_run` gate doing exactly what it exists for, on a failure nobody
planned.

**Verified against a real registry rather than by reading the YAML.** A local
`registry:2` was stood up, all five images built with the exact build args
and context the workflow uses, and pushed. Then the local stack was torn down
and **every local image deleted**, so anything that started had to have been
pulled. `docker compose pull` + `up -d` brought the stack up from the
registry alone, both services answered their readiness checks, and
`e2e:spin` passed end to end against it. `docker inspect` confirmed the
containers were running the SHA-tagged images, not local builds.

Rollback was tested the same way: a second release was pushed under a
different tag, deployed, and rolled back — the container moved from the new
tag to the old and came up healthy. The pre-flight guard was tested in both
directions, finding all five real images and refusing a tag that was never
built, which is what stops a rollback taking production down and leaving it
there.

**Compose changed to make any of this possible.** Every buildable service now
carries `image:` alongside `build:`. `build:` is unchanged for local work;
`image:` is what a deploy runs. The default `slots-engine/<service>:local` is
a name no registry serves, so a `pull` without `REGISTRY` set fails loudly
instead of quietly fetching someone else's image, and a local build cannot be
mistaken for a released one in `docker images`. Confirmed that
`up -d --build` still behaves exactly as before.

**Three deliberate departures from the reference repo's `deploy.yml`**, which
was read first per the routine at the top of this file:

| Theirs | Here | Why |
|---|---|---|
| `sshpass` with a password secret | SSH key | Revocable without changing a human's login; never in a process list on the runner. |
| `ssh-keyscan` at deploy time | Pinned `DEPLOY_SSH_KNOWN_HOSTS`, with a warning when absent | `keyscan` trusts whatever answers on the day, which is how a deploy lands on the wrong box. |
| No rollback | Automatic on failed health check, plus a manual workflow | This item named "no rollback path" explicitly. |

What the pipeline still does **not** do is listed at the end of
`docs/DEPLOY.md` rather than implied away: no second tier, no TLS or reverse
proxy (so the app ports are firewalled rather than unpublished), no
zero-downtime deploy (blocked on item 3b — the limiters count per process),
no database migrations, and secrets are still environment variables rather
than a managed store (item 4).

**The box-side configuration is now written**, which was the one part of item
1 that did not actually need a box: `infra/docker-compose.staging.yml`
unpublishes Mongo's port and sets `restart: always`, wired in through
`COMPOSE_FILE` in the deployed `.env`. Details and the verification in
section E.

### 2. Branch protection is not enforced
**Severity: medium · Effort: trivial (needs a paid plan)**

GitHub requires Pro for branch protection on a private repo, so CI reports
but cannot block a merge. A `pre-push` hook covers the realistic case
locally (build, typecheck, the full unit suite, ~40s), and is skippable with
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
rotation.

**"The startup guards already refuse weak values" — corrected 2026-08-17,
because they do not.** They check that a secret is present, at least 32
characters, and different from its sibling. They do **not** check whether
the value is publicly known, and the placeholders in `.env.example` are 53
characters and differ from each other, so they **pass every check**.
Measured, not assumed: a stack copied from the committed template boots
successfully on a secret published in this repository, and every guard
reports itself satisfied.

That is arguably correct behaviour — a guard cannot enumerate every leaked
string, and the template says "change-me-in-production" — but the previous
wording here implied validation was a solved half of the problem, which
would let someone deprioritise the storage work believing they were
covered. **Rotation is now the whole of it, not the remainder.** A cheap
partial mitigation, if this is picked up before a secret manager: refuse
the exact placeholder literals in production mode, which turns the one
known-bad value the repo actually ships into a boot failure rather than a
silent acceptance.

The local dev secrets were rotated to `openssl rand -hex 32` values on
2026-08-17, and the old launch token was verified refused (`invalid_token`)
afterwards — a rotation that does not invalidate the old credential is a
file edit, not a rotation.

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

### ~~A. Untested and genuinely uncovered~~ — both sweeps closed

These have no direct test AND no meaningful indirect coverage.

**Both sweeps are now closed.** The lower rows are the first sweep; the upper
five are a *second*, run the same way (every source file checked for a sibling
test, then for indirect coverage through a route suite) after the first was
complete, and ordered by what a failure would cost.

The second sweep was worth running: five modules, **four bugs** (F22, F23, and
items J and K), and the two most valuable finds were in the files that looked
least interesting — a 51-line audit helper and an 81-line numerics file.

A note for whoever runs the third sweep. The rule "no direct test AND no
meaningful indirect coverage" is necessary but not sufficient — it is a
*location* heuristic, not a severity one. It correctly flagged `audit/log.ts`,
but the reason recorded for flagging it ("the clamp has all the usual
off-by-one edges") was wrong about the mechanism; the actual hole was `NaN`
defeating every comparison in the clamp at once. Expect the sweep to point at
the right file for the wrong reason, and do not let the stated reason narrow
what gets tested once you are in there.

| Module | Lines | Why it matters |
|---|---:|---|
| ~~`packages/rng/src/gamma.ts`~~ | 81 | **Done, and it found item J.** Hand-implemented numerics — a Lanczos `logGamma`, a series expansion and a Lentz continued fraction — with no direct test at all, producing the p-value a regulator is handed as evidence the generator is sound. 15 tests, 7 of 8 mutations caught, checked against an exact closed form rather than against the implementation's own output. The single survivor is a documented equivalent mutant. `stats.test.ts` had been reaching this file through one caller at points where published tables stop, which is why the tail went unchecked for so long. |
| ~~`backoffice-api/src/audit/log.ts`~~ | 51 | **Done, and it found two bugs — F22 and F23.** 22 tests, 12 of 13 mutations caught; the survivor (removing `Math.floor`) is a documented equivalent, since both the driver and the fake already truncate a fractional limit. The suspicion that put this row second — "the clamp has all the usual off-by-one edges" — was right about the location and wrong about the mechanism: the hole was not an off-by-one but `NaN` defeating every comparison in the clamp at once. Both contracts are now pinned — the swallow-and-report promise in four states, the bound in seven — plus three conformance tests for the fake/Mongo `limit` disagreement that hid F22. |
| ~~`packages/math-engine/src/registry.ts`~~ | 42 | **Done.** 11 tests, all eight mutations caught — including the two that matter: `getMathEngine` falling back to the default instead of throwing, and `registerMathEngine` keying every engine under the default id. Both would pay a round out under mathematics the game did not ask for while looking entirely successful. Also pins that `rngAlgorithm` reaches the engine, since silently dropping it is the failure item 3d found one module over. |
| ~~`game-backend/src/rounds/games.ts`~~ | 62 | **Done.** 14 tests, all nine mutations caught. Two claims that were only ever implied are now pinned: that `loadGameDefinition` reads **Mongo and not the compiled-in fixture** (tested with a stored document deliberately differing from the constant — if the loader ever fell back, every other test would still pass), and that `$setOnInsert` never reverts a published game to its shipped defaults on restart. The `pick-bonus-5x3` guard is covered as **two independent conditions**, since either alone is a single point of failure, plus the strictness of `=== "true"` — loosening it to a truthiness check would fire on the string `"false"`. |
| ~~`game-backend/src/launch/consume.ts`~~ | 26 | **Done, and it closed the gap `misc.test.ts` names in its own header.** 9 tests, all seven mutations caught. The sequential replay was already covered at the HTTP boundary; what was missing is **F14's distinction** — two callers at the same instant is a different guarantee, resting on the unique index rather than on application code. Three tests now drive real concurrent consumption against real MongoDB. Verified by dropping the index: **12 of 12 callers win**, which is the F1 shape exactly. The reference's own `consume.test.ts` covers only the sequential case, so reading it would not have closed this. |
| ~~`game-backend/src/startupGuards.ts`~~ | 45 | **Done.** 15 tests, all six mutations caught (length floor, `=== "production"` loosened to a prefix, each production guard removed, first-problem-only reporting, and the guard made a no-op). Both directions are covered — a guard that throws on everything fails the "accepts a valid environment" test. What they still cannot establish: that `main()` calls it before binding a port, which is `index.ts`'s job and untested below. |
| ~~`backoffice-api/src/auth/middleware.ts`~~ | 69 | **Done.** 23 tests on a bare Fastify instance with probe routes, so a failure names the rule rather than a route. All 12 mutations caught — including the revocation lookup in all four of its states (version behind, version ahead, deactivated, user gone). The twelfth mutation is what surfaced F17. Still cannot establish that `buildApp` mounts the hook at all; that is `app.test.ts`'s territory. |
| ~~`backoffice-api/src/games/simulateClient.ts`~~ | 66 | **Done.** 10 tests, all seven mutations caught — including the one that matters most, the adapter silently ceasing to pass `ASSUMED_BONUS_RETURN_MULTIPLIER` (`runSimulation` defaults it to 0, so every bonus would score nothing and a tuned game would be refused for a reason no report explains). The constant's leverage is now measured by a test rather than asserted from memory, and writing it turned up the sampling-noise figures added to item G. |
| ~~`game-socket/src/index.ts`~~ | 118 | **Done**, by splitting it. The assembly moved to `server.ts` as `createSocketServer`, following `backoffice-api`'s existing `app.ts`/`index.ts` convention, leaving `index.ts` as config-plus-listen. 17 tests drive a real server on an ephemeral port with a real `ws` client. Two gaps are stated in the file header rather than left silent: the `maxPayload` ceiling and the `readyState` guard both survive mutation, and both were judged not worth a fragile test. Verified end to end — `e2e:spin` passes in full against the rebuilt container. |
| ~~`game-backend/src/index.ts`~~ | 175 | **Done**, split the same way: composition moved to `app.ts` as `buildApp`, leaving `index.ts` with connections, the sweep interval and shutdown. 14 tests, 10 of 11 mutations caught — **including regression tests for F6 and F7 themselves**, the two bugs that actually happened in this file. Verified live: rebuilt, `e2e:spin` and all four sections of `e2e:load` pass under real concurrency. |

### ~~B. Covered indirectly, worth direct tests~~ — closed

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

### ~~C. Frontend — the request layers~~ — closed, and the stopping point reopened and closed too

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

**~~Still untested: the React components.~~ — the stopping point is now
closed, and the reason it moved is worth recording.**

This section used to end here, with the components (`screens/*.tsx`,
`gameBuilder/*.tsx`), `renderer.ts` and `main.ts` untested because the repo
had no DOM environment and no component testing library — "a deliberate
stopping point rather than an oversight". That was an honest trade while the
frontend was a reference client whose only untested part was presentation.

**F24 is what invalidated it.** A feature was complete on the money path,
covered by 30 cases, mutation-verified and confirmed against the live stack,
and was *still* unreachable — because of a hardcoded array in a component
nothing tested. The components are not merely presentation; they are the
surface a designer configures money through, and they were the one layer
where a bug could survive every check in this repo.

The environment now exists: `jsdom` + `global-jsdom` + `@testing-library/react`,
wired through `apps/backoffice-frontend/src/testing/`. `primitives.test.tsx`
is the first consumer — 11 tests, **4 of 5 mutations caught**, the survivor
documented in the file header as an equivalent mutant established by probe
(the DOM coerces a non-finite `value` to `""` on its own, so the guard is
unobservable through the rendered value).

**Two pieces of infrastructure had to be right first**, both recorded because
each fails in a way that names the symptom rather than the cause:

- **The DOM must be installed at module-evaluation time, not in a `before`
  hook.** React and Testing Library both capture `document` when their module
  bodies run, and ESM hoists every `import` above every statement — so a test
  calling `installDom()` as its first *statement* has already imported
  Testing Library against an undefined `document`. Importing the environment
  module is what installs it, and `renderComponent.tsx` imports it first.
- **`tsx` needs an explicit `--tsconfig` for JSX.** There is no root
  `tsconfig.json`, so esbuild falls back to the *classic* runtime and emits
  `React.createElement` into files that never import React — every component
  test failing with `ReferenceError: React is not defined`. `run-tests.mjs`
  now runs `.test.tsx` as a second invocation pointed at the frontend's own
  test config. A root tsconfig would have fixed it globally and was rejected:
  it would become the resolution base for every other workspace too.

`IS_REACT_ACT_ENVIRONMENT` is set in the harness for the same class of
reason — without it React warns instead of failing, and an effect-driven
assertion silently reads the state from *before* the effect ran.

The logic previously extracted into `paylineGrid.ts`, `reelStrip.ts` and the
two `api.ts` files remains covered, and extraction is still the first choice
where it applies — a pure function tests faster and more precisely than a
mounted tree. What has changed is that "it needs a DOM" is no longer a reason
for something to go untested.

**The spin animation is on the covered side of that line**, which is worth
saying explicitly because "renderer.ts is untested" reads as though it were
not. Every timing decision lives in `reelStrip.ts` — `reelStateAt`, the two
easing curves, `blurAmount`, `totalSpinDurationMs` — under 19 tests, leaving
`renderer.ts` with canvas calls and no arithmetic worth asserting.

The property that matters is pinned: **reel state is a pure function of
elapsed time**, so a dropped frame cannot desync the reels, and the
left-to-right settle order holds regardless of when frames land. Also
covered: the spin-to-settle handoff is continuous, reels land on an exact
symbol boundary, and nothing scrolls backwards except the deliberate settle
overshoot.

The reference repo's animation subsystem is much larger — designer-authored
spin and symbol animation *templates*, edited in the backoffice and stored
per game (`spinAnimationTemplates`, `symbolAnimationTemplates`, and a
`game-renderer` package with sprite-sheet handling).

**This paragraph used to end "none of that exists here and none of it is
planned".** That decision has been reversed deliberately, and the reversal is
recorded rather than quietly edited away, because the old reasoning was sound
for the scope it assumed. The frontend was scoped as a **reference client**
proving the protocol and the money path; presentation work now has its own
budget, so `pixi.js` and `gsap` are dependencies of `game-frontend` and the
renderer is being built out rather than held at "enough to show a settled
result convincingly".

**What the reversal does not touch is the boundary that matters.** The client
still never computes a win: it renders `round.evaluation.totalWin` and
server-sent balances, and `api.test.ts` pins that a spin message carries
exactly `betAmount`, `clientRequestId` and `type`. A richer renderer changes
how a settled fact is revealed, never what the fact is. The property in
`reelStrip.ts` — reel state as a pure function of elapsed time, so a dropped
frame cannot desync the reels — is the one to preserve through the rewrite,
and it is what makes skipping an animation safe at any point.

The timing maths stays on the covered side of the line either way: every
timing decision lives in `reelStrip.ts` under 19 tests, and pure geometry and
state helpers are the pieces worth adapting from the reference's
`game-shell` (its `gameStateMachine.ts` and `deriveEnablement` are pure
functions, testable with no renderer at all).

### ~~A2. The third sweep~~ — run, and it found the limit of output testing

Section A left a note for whoever ran the third sweep: the rule "no direct
test AND no meaningful indirect coverage" is a **location** heuristic, not a
severity one, and it points at the right file for the wrong reason. That held
again, in a new way — see the survivor below.

The sweep was run the same way as the first two, then filtered differently.
The filename rule alone flagged 37 files, nearly all of them either covered
through a route suite or genuinely data. The useful filter turned out to be
**imported by many test files, asserted by none** — a shape the first two
sweeps did not look for, because it does not show up as an uncovered file.

Two modules matched, both tiny, both load-bearing:

| Module | Lines | Imported by | Asserted by |
|---|---:|---:|---:|
| `packages/logging/src/index.ts` | 55 | 24 test files | 0 |
| `packages/rng/src/seed.ts` | 14 | 25 test files | 0 |

**`logging` — 17 tests, all 6 mutations caught.** `redact` is a security
control wearing the costume of a formatting option: launch tokens, session
tokens and round **seeds** pass through these services constantly, and this
codebase stores a seed precisely because a round is a deterministic function
of it. A seed in a log file is enough to replay or predict outcomes, held
indefinitely by whatever aggregator scrapes the logs.

One structural change was needed to make the test meaningful. The redact
paths are now exported as `REDACT` and the factory spreads them, because a
test that **restates** the list passes even if `createLogger` stops applying
it — which is the one failure the list exists to prevent. That mutation
(deleting `redact:` entirely) is caught by exactly one test: the one that
runs the real factory in a child process and reads its stdout. Worth
recording why that shape was needed — pino resolves its destination at
construction and writes to fd 1 directly, so monkey-patching
`process.stdout.write` captures nothing (the first attempt did exactly that
and read back an empty string), and Node exposes no `dup2` to redirect the
descriptor in-process.

Also pinned: a real limit rather than a hoped-for behaviour. `*.token` is a
**single** wildcard level, so a token nested two deep is **not** redacted.
The test asserts the leak, so the file states the limit instead of implying
safety it does not provide.

The reference repo has **no redaction at all** in its equivalent file, so
there was no counterpart suite to read and nothing upstream validating this
list. This is one of the few places this codebase is ahead of it.

Verified live, since a change to `logging` touches every service: the
production containers were rebuilt and a seed, token and sessionToken logged
from **inside** the running `game-backend` all came back `[redacted]` with
`gameId` intact — which also exercises the `NODE_ENV=production` transport
branch that a unit test deliberately does not.

**`seed` — 8 tests, and the eighth exists because of a mutation that
survived.** This is the sweep's real finding, and it is a lesson about
testing rather than a bug:

> **A predictable seed and a secure one produce indistinguishable output.**

Replacing the body with `sha256(Date.now() + Math.random())` — a seed anyone
can recompute from the approximate time — **passed all seven output tests.**
Measured, not reasoned: the maximum shared prefix over 200 consecutive pairs
was 1 character, identical to a real CSPRNG, because the hash destroys the
sequential structure of its input. Length, charset, uniqueness, byte
coverage and per-bit balance all pass, because they are checks on *shape*.

Predictability is a property of the **source**, so the source is the only
thing that can be pinned. The eighth test asserts the module draws from
`crypto.randomBytes(32)` and contains no `Math.random`, `Date.now` or
`hrtime`. Both mutations are caught now.

This generalises past this file: any test that samples output can only ever
establish that a generator *looks* right. For anything whose security rests
on unpredictability, the assertion has to reach the source. The statistical
suite in `packages/rng` tests the generator a seed drives; it could not have
caught this either.

### ~~A3. The bonus registry's write side~~ — closed

The same filter that found A2's two modules — **exported and named by no
test** — had two more hits once it was run over `math-engine` specifically:
`registerBonusModule` and `listBonusModules`. `bonus.test.ts` covers the two
shipped modules and `deriveStepRng`, and reaches the registry only through
`getBonusModule`, so the write side had nothing on it.

9 tests, all 5 mutations caught. The one this exists for is keying every
module under a fixed id: it is `registerMathEngine`'s failure exactly, one
directory over, and it means a bonus **pays out under the mathematics of a
different module** while looking entirely successful — the wheel's payouts
credited to a pick round is a wrong number, not a crash.

Two other properties are now pinned that were only ever implied: the shipped
pair is registered as an **import side effect** of `registry.ts` (nothing
else does it), and `listBonusModules` returns a fresh array rather than the
live keys — F18's shape, where handing back internal state by reference made
a privilege escalation reachable through the function meant to produce a safe
copy.

Also recorded deliberately: re-registering the same id **replaces** rather
than refusing. That is what keeps the bottom-of-file registration idempotent
if the module is imported twice, and it is now a decision someone has to see
a test fail to change.

### ~~N. Free spins~~ — shipped

The engine's first feature built as a feature rather than as a fix. Three
bonus modules now: `wheel` (single-step), `pick` (multi-step, self-contained)
and `freeSpins` (multi-step, **played on the game's own reels**).

**A flaky test in this fixture turned out to be a wrong constant** (fixed
2026-08-17). `free-spins-game.test.ts` failed roughly one run in fifteen,
which read as sampling noise on an unseeded simulation and was not:
`FREE_SPINS_BASE_RTP` declared **0.81** against a true base return of
**0.8024**, re-measured over five independent 2,000,000-spin runs. The
0.0076 bias spent 38% of that test's own 0.02 tolerance before a single spin
was sampled, so the assertion had roughly half the margin its numbers
implied. Both were fixed — the constant corrected, and the two assertions
seeded, at sizes chosen by measuring rather than by raising a number until
red went green.

**The two tests needed different fixes, and measuring is what separated
them.** For the base-return check there is no bonus contributing, so it is
ordinary per-spin sampling and sd falls as sqrt(n) (0.0093 at 200k, 0.0026
at 1M) — more spins genuinely helps, and 500k is the knee at 2.2x headroom
across ten arbitrary seeds. For the gate check the bonus pays **40.5x the
bet** on a rare trigger, so the run is dominated by how many triggers landed
rather than by an average over 200k spins: sd is ~0.0066 at 200k and ~0.0077
at 500k, **flat where real sampling noise would have fallen**. Raising the
count there buys nothing, which is worth recording because it is the first
thing anyone would try. Every seed tried passes both, so the pinned seeds
are reproducibility rather than cherry-picking — checked, not assumed.

Both tests were mutation-verified after the fix: a constant wrong by 0.03
fails the base check, and a doubled `winMultiplier` fails the gate. A stable
test that can no longer detect the thing it exists for would be a worse
outcome than the flake.

**Republished, and the two-step is the point.** A published game is a
snapshot and does not track source edits — which is exactly the property
that makes a round auditable years later, and equally the reason correcting
the constant in `free-spins-game.ts` did *nothing* for players on its own.
The live document stored its own `0.81`, so the fix had to be made twice: in
source, and as a real draft edit through `PUT /v1/games/:gameId` followed by
a publish. Worth recording because the first fix looks complete and is not,
and nothing anywhere reports the gap.

Done 2026-08-17, through the real API rather than by writing to Mongo:
`free-spins-5x3` is now **v2** carrying `assumedBaseRtp: 0.8024`. The gate
ran a genuine 100k-spin simulation and passed at **0.9540 against a 0.95
target**, `bonusReturnSource: derived` with the multiplier moving 40.5 →
40.12 as the corrected base return feeds through. The audit entry records
v1 → v2 with its run seed and `forcedPastRtpTolerance: false` — it passed on
merit rather than being forced. Live document and v2 snapshot are
byte-identical.

Verified in a browser against the running stack, not only through scripts:
the client loaded the game, the public projection served version 2 with the
corrected parameter, a real spin debited **$1000.00 → $999.00** with a
matching `debit` of 100 minor units and `balanceAfter: 99900` in the ledger,
and the stored round records `gameVersion: 2`. Console clean, and
`e2e:spin` passes in full against the republished game.

**The interface change is the interesting part.** Free spins is the first
module whose outcome is not a function of `params` alone — a free spin is a
real spin, drawn from the same strips, paylines, wilds and scatters the base
game uses. `BonusStepInput` therefore gained two *optional* fields,
`gameDef` and `sessionSeed`, and optional is the decision:

- A self-contained module **must not** be able to reach the game definition.
  That is what keeps its expected value computable by reading params rather
  than by reading module source — the property the publish gate depends on.
- A module that needs them **refuses when they are absent** rather than
  falling back. A free spin evaluated against anything else pays out under
  mathematics nobody configured, and a silent default would make that
  indistinguishable from a correct round. Same reasoning as `getMathEngine`
  refusing an unknown id.

`sessionSeed` is deliberately not `rng`. The per-step generator's stream
depends on how many times `step` was called, so a round seeded from it would
replay only if the call sequence were reproduced too. Each spin's seed is
`sha256(sessionSeed:freespin:index)`, so the whole round replays from one
stored value.

**Retriggering is capped, and the cap is load-bearing.** A free spin can
trigger the feature again because it is a real spin. With per-spin trigger
probability p, a round terminates only because N·p < 1 — raise either enough
and the session never ends and pays without bound. `maxRetriggers` makes the
worst case finite and computable, which is what lets the gate reason about
the module at all.

**A mutation survived, and the reason is the useful part.** Removing the
retrigger cap entirely failed *nothing*. `reference-5x3` triggers on
**0.415% of spins** (measured over 20,000), so a ten-spin round retriggers
about once every 24 rounds and no test ever reached a second one. **A fixture
that cannot reach a branch cannot test it**, and the suite was green either
way — section D's lesson, arriving in the engine this time. Fixed with an
always-triggering fixture (`probabilityTrigger: 1`) which exercises the cap
on the first spin; the runaway case now terminates at exactly 155 spins
instead of never. 6 of 6 mutations caught after that.

**`expectedReturnMultiplier` is an estimate, and says so.** `wheel`'s is
exact and `pick`'s is a closed form; this one cannot be either, because a
free spin's return is the base game's RTP and `params` cannot see the game.
It reads `params.assumedBaseRtp` and falls back to 0.95. Two things make
that honest rather than a guess dressed up: the fixture passes its own
measured base return (0.81) explicitly, and the retrigger term uses an
**upper bound** rather than the true expectation — overstating the bonus
makes the gate *stricter*, so the failure mode is a false refusal a designer
investigates rather than a false acceptance that ships.

**The fixture is shippable, not an instrument.** `free-spins-5x3` seeds
unconditionally alongside `reference-5x3`, unlike `pick-bonus-5x3` which is
flag-gated and refused in production. Its paytable sits ~8% below the
reference game's because the base game funds the feature; the figure was
found by simulation, not arithmetic — 12% measured 0.927, 10% overshot to
1.03, and 8% landed at **0.954, a drift of 0.004 against a 0.05 tolerance**.
The curve is steep because the feature's return scales with the paytable it
is drawn from, so both halves move together. `free-spins-game.test.ts` is
the publish gate run against the fixture itself.

**Verified against the live stack, end to end.** A real round: triggered on
spin 394, ten free spins on the real reels, the ×2 multiplier applied
correctly (850→1700, 130→260), resolved to **1960**, credited through the
ledger, `archiveAfter` a genuine BSON Date. Then the audit property, which
is the one that matters: **replaying the round from the stored session seed
alone reproduced 1960 exactly.**

**The claim that first stood here was wrong, and F24 is the correction.** It
read: "the backoffice has no editor for these params (they are set in the
fixture, and a designer would edit them as raw JSON)" — filed as a deliberate
omission. The editor *does* exist and does take raw JSON, so that half was
true. What was not true is that a designer could reach the feature at all:
the module dropdown held a hardcoded two-item list and `freeSpins` was not
in it. A deliberate omission and an unreachable feature look identical from
the outside, which is why the follow-up was worth doing rather than assuming.

Still open, and genuinely deliberate: bonus parameters are free-form JSON
rather than a per-module form, and `runSimulation` still scores the feature
with one multiplier rather than playing rounds out — item G's standing
assumption, unchanged by this work.

### O. Frontend and presentation
**Severity: n/a (product surface) · Effort: high · In progress**

A deliberate scope change rather than a defect. The frontend was built as a
**reference client** — enough presentation to prove the protocol and the
money path — and is now being built out as a real one. Section C carries the
reversal and what it does not touch; this item tracks the work.

**Done:**

- **A DOM test environment**, which was the blocker under everything else.
  `jsdom` + `global-jsdom` + `@testing-library/react`, wired through
  `apps/backoffice-frontend/src/testing/`. Two ordering hazards are solved
  and documented in section C, because each fails in a way that names the
  symptom rather than the cause: the DOM must be installed at
  module-evaluation time (ESM hoists imports above statements, so React and
  Testing Library capture `document` before any `installDom()` call in the
  test body), and `tsx` needs an explicit `--tsconfig` or esbuild emits
  classic-runtime `React.createElement` into files that never import React.
- **`primitives.test.tsx`** — 11 tests on the shared components every screen
  is built from, 4 of 5 mutations caught, the survivor documented as an
  equivalent mutant established by probe rather than by argument.
- **`pixi.js` and `gsap`** are dependencies of `game-frontend`.
- **The player client's phase model** (`state/gameState.ts`) — 20 tests,
  **all 8 mutations caught**, and it needs no DOM, which is why it was done
  before any rendering work. It replaces `main.ts`'s scattered booleans
  (`spinInFlight`, renderer nullability, direct `disabled` assignment) with
  one typed state plus a pure `deriveEnablement`, so two controls cannot
  disagree about whether a round is in flight.

  **Adapted from the reference's `gameStateMachine.ts`, not transplanted**,
  and the three departures are each forced by this engine's protocol rather
  than chosen: no `bonusTriggered` phase (here `SPIN_RESULT` and the first
  `BONUS_STATE` arrive too close together for anything to observe one, and a
  state nothing can observe is a state nothing can test); no `stopRequested`
  on `spinning` (a spin cannot be skipped before its result exists — there is
  nothing settled to skip *to*); and `revealing` rather than `evaluating`,
  because nothing is evaluated client-side and "evaluating" is precisely
  where a reader would look for the win computation this client must never
  contain.

  **One mutation survived the first pass, and the reason generalises.**
  Iterating the live listener `Set` instead of a copy left every test
  passing, including the one written for it. Measured rather than argued: a
  `Set` deleting the **current** element mid-iteration still visits every
  remaining one, so a self-unsubscribing listener cannot tell the two apart
  — only a listener removing a **different, not-yet-reached** one can. That
  case is now its own test. The general form is section D's fixture lesson
  again: a test can name the right hazard and still construct an input that
  cannot reach it.
- **`main.ts` is wired to the phase model**, with the enablement write
  extracted to `ui/controls.ts` — 9 tests, **all 5 mutations caught**.

  The extraction is the point rather than tidiness. Left inside `GameApp`,
  that write would be reachable only by standing up a socket and a canvas —
  so the phase model would have tests and the code acting on it would not,
  which is **F24's shape exactly** and this item's own closing caution.
  Being right about what *should* be enabled and actually writing it to the
  button are different claims.

  Three real behaviour changes fell out of the rewiring, each one a bug the
  scattered booleans allowed:

  | Was | Now |
  |---|---|
  | Bet buttons stayed live during a round — only the spin button was disabled | Bets lock for the whole round, so a stake cannot change after the server priced it |
  | Space and click read `renderer.isSpinning`, which is **false** between sending a spin and the result arriving — a second press started a **second round** | The phase decides, and `spinning` offers neither a spin nor a skip |
  | A spent token and a dropped socket both merely disabled a button | `unrecoverable` vs `offline`, only one of which a reconnect can fix |

  The spin button now relabels to "Skip" mid-reveal, treated as part of
  enablement rather than as decoration: a live button reading "Spin" that
  actually skips is worse than a disabled one, because the player presses it
  believing they placed a bet. The label is asserted in both directions,
  since a one-way change leaves an idle client reading "Skip" forever.
- **The renderer is Pixi now.** `PixiReelRenderer` replaces the canvas-2D
  `renderer.ts`, which is deleted rather than left beside it — two renderers
  where one is dead is the duplicate-source drift F24 is about.

  **The architecture was decided by measurement, not preference.** `jsdom`
  returns `null` for **both** the `webgl2` and `2d` contexts, so a live
  `Application` cannot be constructed in a test at all. Anything that can be
  numerically wrong therefore lives outside the renderer, in `spinMotion.ts`
  (36 tests) and `symbolStyle.ts` (12 tests), leaving `PixiReelRenderer`
  holding sprite creation, positioning and teardown — which a screenshot
  checks better than an assertion would. **All 14 mutations on that maths
  are caught.**

  **Two bugs were inherited from the reference as guards rather than
  rediscovered**, both recorded in its own source because it shipped them:

  | Bug | Symptom | Guard |
  |---|---|---|
  | Blur factor applied to a **pixel** delta calibrated in **row** units | Strength ~15x the filter default — reels did not look fast, they looked *gone* | `computeBlurStrength` normalises against cell size, and `MAX_BLUR_STRENGTH` caps it whatever the tuning |
  | Settle distance "wrap-normalised" to always travel forward | Lands a full cycle from the target while looking arithmetically sensible | `settleDistance` is `target - current` and nothing else; a backward nudge is the accepted trade |

  **Two more were found by running the client**, which is the part worth
  keeping — neither was reachable from any test, and both are recorded in
  the source where a later reader will meet them:

  - **The grid rendered in the top-left corner at a fixed size.** Pixi's
    `autoDensity` writes an **inline** `style.width`/`style.height` onto the
    canvas, and an inline style beats the stylesheet's `width: 100%`.
    Measuring the canvas then reads back the number Pixi just wrote — a
    feedback loop pinning the grid at Pixi's default 800x600 however large
    the window is. Measured live: an 800x600 canvas inside a 1280x596
    `<main>`, with the grid **correctly centred inside the wrong box**,
    which is why it reads as a centring bug and is not one. `layout()` now
    measures the *parent*, via `measurementSource`.
  - **Switching tabs mid-spin stranded the round permanently.** The settle
    is detected inside the draw loop, and browsers throttle
    `requestAnimationFrame` to **zero** in a hidden tab. Measured: 0 frames
    in 500ms, and a reveal stuck for as long as it was observed — spin
    disabled, button reading "Skip", status "Spinning…". The money was never
    at risk, the server having settled the round before any of this ran,
    which is exactly why the client must not be what strands it.
    `shouldForceSettle` completes the reveal on becoming visible, and only
    when the animation *would already have finished* — a tab hidden for a
    moment still sees the rest of its reveal rather than having it snatched.

  Verified against the live stack, not just the suite: a real spin through
  the rebuilt container debited $1000→$999, a later round paid a $1 line win
  with the winning cells outlined, and `e2e:spin` passes in full — including
  idempotent retry, single-use launch tokens, and round recovery replaying
  to the identical seed and outcome.
- **The player is told what happened** (`ui/statusPresentation.ts`, 12
  tests). A pure map from phase to wording, so the status line and the
  buttons cannot disagree — a client reading "Ready" beside a disabled spin
  button teaches the player the button is broken.

  The wording is deliberately **not** asserted verbatim; pinning sentences
  makes copy edits fail the suite, which trains people to ignore failures.
  What is asserted is the contract: every terminal state is non-actionable,
  every one of them names the single thing that helps, and an unrecognised
  code still yields a usable sentence with the raw code appended for
  support. The first version of the Pixi work made this concrete — a failed
  graphics init showed a blank canvas with a working Spin button, which is a
  player betting into nothing.
- **Bonus parameters have a real form** — **F24's follow-up, now closed.**
  F24 made every module selectable and stopped there, leaving their
  parameters a free-form JSON blob. So a designer could reach `freeSpins`
  and still had no way to learn it reads `spinCount`, `winMultiplier`,
  `retriggerSpins`, `maxRetriggers` and `assumedBaseRtp` — that contract
  lived only in the module's source, in the shape of
  `typeof params.x === "number" ? params.x : DEFAULT`.

  **Why that is worse than inconvenience, and the reason this is worth the
  work:** every module *silently substitutes its own default* for anything
  malformed. A typo'd key, a value below a module's minimum, a number typed
  as text — none of them fails validation and none blocks a publish. The
  game plays under numbers nobody chose and looks entirely successful doing
  it. The form is the only place in the system where that is catchable.

  `BonusModule` gained an optional `paramSchema`, declared **next to each
  module** and served through the existing `/v1/bonus-modules` route via
  `listBonusModuleSchemas()`. Declared there rather than in the backoffice
  for exactly the reason F24 records: a list kept in a second place drifts,
  and nothing fails when it does. A parameter list kept in a second place
  would be the identical bug one level down, and quieter.

  Tests: 16 on the registry (both mutations caught — returning specs by
  reference, and dropping schema-less modules), 24 on the form and its two
  pure helpers, 4 more on the route. Two decisions are pinned because they
  are easy to get backwards:

  - **An emptied field removes the key** rather than storing `0` or `[]`.
    The module's fallback triggers on *absence*, so absence is the honest
    representation of "use the default".
  - **A module with no schema keeps the JSON editor.** An empty form would
    read as "this module takes no parameters", which is a different and
    false statement.

  **Verified the way F24 says to verify** — by asking how a designer reaches
  it, not just whether it is correct. Signed into the running backoffice,
  opened `free-spins-5x3`, and confirmed all five parameters render as
  labelled fields carrying the fixture's real stored values (including
  `assumedBaseRtp: 0.81`, the measured base return). Setting "Free spins
  awarded" to 0 produced **"below the minimum of 1 — the module will use
  10"** live, which names both the violation and what the module will
  silently do instead. The draft was left byte-identical to the published
  document afterwards.
- **A win counts up, and its tier scales the announcement**
  (`render/winPresentation.ts` — 27 tests; `ui/winCountUp.ts` — 11 tests).
  Thresholds are 15x and 50x of the **bet**, not absolute amounts: 500 minor
  units is a large win on a 1-unit stake and a loss on a 50-unit one.

  **This module handles money, so it is held to the money standard rather
  than the presentation one — and the reference shipped exactly the bug that
  standard exists to prevent.** Its own source records it: a mid-tween
  counter was rendered with `toFixed(2)`, which formats decimal *places*
  without converting minor units to major ones, so a 2000-unit win (20.00)
  displayed as **"WIN 2000.00"** in front of a player. `countUpValueAt`
  therefore returns an **integer count of minor units at every instant**, and
  the suite asserts that across the whole animation rather than at its
  endpoints — an implementation integral only at 0 and 1 is precisely the one
  that fails in the middle, which is where every rendered frame lives.

  Three decisions are pinned because each is a way to be quietly wrong:

  | Decision | The failure it prevents |
  |---|---|
  | Tier is `none` when the stake is **zero** | A free spin costs nothing, so a bonus genuinely reports a win against a zero stake. Every threshold would be 0 and the loudest celebration would fire on the smallest possible amount. |
  | Tier is derived from the value **on screen**, not the final win | Otherwise the celebration fires before the player has watched the number get there. |
  | `tierCrossing` is **edge**-triggered | A level-triggered check fires on every frame above the threshold rather than once as it is crossed. |

  **Mutation: 6 of 8 caught, and the two survivors are documented
  equivalents.** Both `Math.floor` and the `elapsedMs >= durationMs` early
  return are unreachable under a cubic ease-out, which never exceeds 1.

  **Corrected 2026-08-17, and the correction is the more useful fact.** This
  entry previously claimed that swapping in the overshooting `easeOutBack`
  makes both mutants live immediately, and cited a 499-minor-unit
  overstatement on a 5000-unit win. Re-probed: **it does not.** Applying
  `floor → round` *and* `easeOutBack` together leaves all 27 tests passing.
  The 500-at-peak figure is right about the raw curve and wrong about the
  consequence, because `Math.min(Math.round(winMinor), …)` clamps the result
  before it is returned — so the protection against overstating a win comes
  from **the clamp, not from the choice of curve**.

  Worth keeping rather than quietly rewriting, because the original reasoning
  was the kind that sounds rigorous and cites a measurement: a number was
  computed from the curve in isolation and then attributed to the shipped
  function, which has a clamp the curve never reaches past. The load-bearing
  line is `return Math.min(...)` in `countUpValueAt` — that is what a future
  editor must not remove. Changing the ease is safe; removing the clamp is
  not.

  **A caution recorded in `index.html` for whoever verifies the tiers next.**
  They cannot be read with `getComputedStyle` in a background or throttled
  tab: transitions run on the same frame clock as `requestAnimationFrame`,
  which such a tab stops, so a probe reads a *frozen* transition and reports
  `matrix(1,0,0,1,0,0)` for a rule plainly declaring `scale(1.28)`. The tell
  is that `text-shadow` — which has no transition — applies while `color` and
  `transform` from the very same rule do not. Set `style.transition = "none"`
  first. Measured that way all four tiers are correct: none/win flat, big
  1.12x, mega 1.28x white with a glow.

  Verified end to end by driving the shipped module frame by frame:
  `$14.92 → $27.13 → … → $59.95 → $60.00`, decelerating, never overshooting,
  landing exactly, with `win → big → mega` each firing once. `e2e:spin`
  passes in full against the rebuilt container.
- **Symbols can carry real artwork** (`render/symbolAssets.ts` — 19 tests,
  **all 6 mutations caught**; `publicView.ts` — 5 new tests). `GameAssets`
  is a new optional field on `GameDefinition`: symbol image URLs plus a
  background.

  **The separation is the design, not the plumbing.** Nothing in `assets`
  reaches the evaluator, the RTP simulation or the publish gate — a game's
  mathematics is its strips, weights, paytable and bonus params, and none of
  those can be changed by uploading a picture. That is what makes artwork
  safe to edit on a published game without re-running the gate, and it is
  pinned by a test that diffs the whole public projection with and without
  artwork and asserts **only** the `assets` key differs. It is also why this
  is a separate field rather than a property on `SymbolRule`: a symbol's
  *rule* is maths, and mixing the two invites a change to one being reviewed
  as though it were the other.

  **A missing picture must never hide a symbol.** Artwork is optional at
  every level — no assets at all (every fixture here), a symbol absent from
  the map, a URL that 404s, a whole asset host down — and each falls back to
  the derived glyph. A blank cell on a reel a player is being paid on is a
  far worse failure than an ugly one, because the player cannot tell what
  they won. The fallback is **per symbol**, so one game legitimately mixes
  art and glyphs; verified on screen, with `cherry`/`plum` drawn as sprites
  beside `10/J/Q/K/A` as letters.

  **URLs are filtered before they reach the loader.** A game definition is
  data a designer edits, so its URLs reach `Assets.load` directly: `http`,
  `https` and relative paths are allowed, `javascript:`, `data:` and `blob:`
  refused. Refusing is safe precisely *because* of the fallback above — a
  refused URL is a placeholder, not a broken game.

  **The load report distinguishes "no artwork" from "artwork missing",** and
  that distinction is the only thing that makes the warning worth printing.
  Every game here ships none, so warning on absence would be noise by the
  second day; a dead asset host renders placeholders everywhere and
  otherwise looks like a styling choice nobody questions for a week. Proven
  in the most direct way available: the first live attempt logged
  **"6 of 6 symbol images failed to load … cherry, plum, bell, seven, wild,
  scatter"**, which is what turned an invisible problem into a diagnosable
  one. The cause was a hand-rolled PNG encoder in the *test fixture* writing
  a bad CRC — `file` accepted the images and browsers refused to decode
  them — not a defect in the renderer.

  Verified against the live stack end to end: artwork set on the published
  document, served through the real `/public/games/:id` allowlist, rendered
  as sprites in the browser, then removed again so the shipped game is
  byte-identical to before. `e2e:spin` passes in full.

  Worth recording one unusual mutation result. Forcing the `assets` key to
  be emitted unconditionally does not *survive* — it **crashes**, because
  `gameDef.assets` is undefined for every shipped game and reading
  `.symbolImageUrls` off it throws before a single test runs. The guard is
  load-bearing at runtime rather than merely observed by an assertion, which
  is a stronger position than a caught mutation.
- **The bonus panel keeps its elements between steps** (`ui/bonusView.ts` —
  22 tests, **all 7 mutations caught**; `ui/bonusPanel.ts` — 24 tests).
  Replaces an `innerHTML` rebuild that ran on every `BONUS_STATE`.

  **The rebuild was not merely untidy.** It destroyed and recreated every
  tile each time a player picked one, so the element showing a result was a
  different object from the one clicked — no reveal could animate, keyboard
  focus was thrown away on every step, and a module's free-form `view`
  values were interpolated straight into markup. Values are now set with
  `textContent`, and elements are created once per round.

  **Dispatch is on the shape of the view, never on a module id.** A view
  carrying `remaining` is a free-spins round whatever it is called. Keying
  off the id would put a second copy of the module list in the client, which
  is F24's failure one layer over. A module this build cannot draw says so
  rather than rendering an empty overlay — a bonus blocks the base game
  until it resolves, so a blank panel reads as a frozen client.

  **Two bugs found by running it, neither reachable from a test:**

  - **A mutation survived that should not have.** Removing
    `stepInFlight = true` from the click handler changed nothing, because
    `syncTileEnablement` was called without a model and disabled everything
    unconditionally — the flag was decorative on the click path. The panel
    now remembers the last pick model so one rule decides enablement in both
    directions, and the mutation is caught.
  - **Focus was still lost on every pick**, despite the tiles surviving.
    A browser blurs a focused element the moment it is disabled; **`jsdom`
    does not**, so the test written for exactly this passed against a
    stand-in more permissive than the real thing — the `fakeMongo` trap in
    section D, in a new place. Focus is now tracked on `focusin` (which
    bubbles, unlike `focus`) and restored only onto a tile still usable.

  A caution for whoever re-checks that fix: **a programmatic `.focus()` does
  not emit `focusin` in a headless pane**, so a probe that calls `.focus()`
  and then picks a tile will see focus land on `<body>` and conclude the fix
  is broken. It is not — a real Tab keypress fires the event. Dispatching
  `focusin` alongside the call reproduces the keyboard path.

  Two mutations survive as documented equivalents, both defence in depth
  established by probe: the `if (button.disabled) return` guard (already
  disabled by `syncTileEnablement`) and the `clearTimeout` before a resolved
  dismissal (`hide()` clears every pending timer, and the first callback
  calls `hide()`). Both are kept so each path is correct on its own terms
  rather than only while another method keeps its promise.

  Verified live on both module types: a pick round rendered 9 tiles, revealed
  `×3` on the clicked one while the other eight stayed live, kept the **same
  element objects** across the step, ran through to `Bonus complete`, hid
  itself and returned the client to idle with the balance credited to
  $1011.00. A free-spins round rendered "Free spins ×3 · 5 left · $0.00" with
  a single enabled Spin button. `e2e:spin` passes in full.

**The rule these tests follow**, stated because it is the difference between
a component suite that earns its runtime and one that makes every visual
change expensive: **assert behaviour a user depends on, never a token.** A
test restating `t.accent` passes whatever the value is — it pins nothing and
makes the palette harder to change. A test that a disabled publish button
does not fire pins something real.

- **Artwork can be set by a designer** (`gameBuilder/AssetsEditor.tsx` — 24
  tests, **all 7 mutations caught**), which closes the last row on this
  list. A per-symbol URL field plus a background field, on its own Artwork
  tab, with the symbol list taken from `draft.symbols` rather than from the
  artwork map — deriving it from the map would show only symbols that
  *already* had artwork, leaving no way to add the first one, which is F24
  in miniature on a screen that looked complete.

  **A URL field rather than object storage, and the reference is the
  argument for it.** Its `asset-storage` signs 24-hour URLs, and its own
  `repair-corrupted-asset-urls.ts` records what that cost: `GET` returned
  signed URLs, `updateDraft` blindly `$set` the client's `assets` object
  back, and every "Save draft" overwrote the raw storage key with a signed
  URL — **compounding on each save**, since the next GET re-signed the
  already-corrupted value. This repo has the same blind spread in its
  `PUT /v1/games/:gameId`. It is safe here for one reason, stated in the
  source because a future upload feature would remove it: **what is read is
  exactly what is written.** No signing step sits between them, so a round
  trip cannot corrupt a value.

  **Three silent drops were found on the way, none reachable from a test
  that existed.** Two were allowlists omitting by default — `publishDraft`
  built its `gameDef` field by field and never carried `assets`, so artwork
  was accepted, saved, echoed back by every GET and **discarded at the one
  step that makes it playable**; `draftFromPublished` dropped it in the
  other direction, so reopening a live game to change a payout would have
  erased its artwork without either step mentioning artwork. The third is
  F25, and it took the live stack to see. All three are invisible from both
  ends: the draft still holds the URLs, so the editor keeps showing them.

  The URL rule now lives in `shared-types` beside `GameAssets` rather than
  in the player client, so the screen that *writes* the field and the loader
  that *reads* it share one definition. A second copy would not have stayed
  equal, and nothing would have failed when it stopped being: the loader
  refuses a bad URL silently and by design, so the editor could have stored
  a value that renders as nothing, with a saved field and a clean publish
  either side of it. The client's 19 existing tests pass unchanged against
  the moved rule, which is what establishes the move was a refactor.

  Verified against the live stack end to end, and against real MongoDB
  rather than `fakeMongo`: artwork set on a draft of `reference-5x3`,
  reloaded, **published as v5**, and served through the real
  `/public/games/:id` allowlist. Then cleared — which is what surfaced F25
  and F26 — and republished as v7 with the projection clean again, the live
  document byte-identical to its own v7 snapshot, and `e2e:spin` passing in
  full including idempotent retry and round recovery.

**Open, in the order it is worth doing:**

| # | What | Why it is next |
|---|---|---|
| ~~1~~ | ~~**A wheel is never drawn**~~ — **shipped 2026-08-17.** `readBonusPanel` now checks the wheel's shape *before* `resolved`, which is the whole fix: `wheel` resolves in `start()`, so its state always arrived already-resolved and matched that branch first. The exception is safe because the rule `resolved`-first exists for — not leaving a settled round clickable — cannot be violated by a module that offers no control. Drawn as a CSS `conic-gradient` rather than a canvas: this panel is already an HTML overlay, and `jsdom` returns null for `getContext`, so a canvas would make every wedge untestable. The reveal is a CSS transition rather than a rAF loop, which sidesteps the hidden-tab throttling that `shouldForceSettle` exists to recover from — a transition is compositor-driven, so a hidden tab simply arrives at the finished state. 19 tests on the geometry (including a **round trip** proving the settled rotation points at the segment the server chose, across seven wheel sizes), 7 on the view, 11 on the panel; **all 4 mutations caught**, including reverting to the shipped bug and inverting the rotation direction. |
| ~~2~~ | ~~**Autoplay**~~ — **shipped 2026-08-17.** A bounded run of spins, built as pure state rather than a widget: the reference puts the loop inside a Pixi component, which makes it reachable only by standing up a renderer, while every decision here is a function of the phase and a counter. Deliberately **no unlimited option** — this engine has no loss limit and no responsible-gambling backing, so "spin until the money runs out" is a different product; that is the one row here a non-engineer should revisit. Waits out a bonus by resuming on `idle`, so it needs to know nothing about bonuses. 28 tests, **6 of 6 mutations caught** — see the note below on the one that survived first. |
| ~~3~~ | ~~**Per-game themes**~~ — **shipped 2026-08-17.** Seven colours on the game definition, edited in a Theme tab, carried through publish and served by the projection — the same path `assets` takes, including being removable, so F25 and F26 cannot recur in a new field. Much smaller than the reference's `VisualTheme` (radii, spacing, glow alphas, type roles) because this client draws chrome with CSS, where those already live; duplicating them into game data would create two sources for one fact and the database copy would win silently. **The colour rule is a security boundary, not a formatting preference** — these values are interpolated into a stylesheet, and CSS accepts `url(...)` and `;`-escapes, so it is a hex shape-match rather than anything that reasons about CSS. Guarded twice on purpose: the projection sanitizes, and the client re-checks, because the client is reachable from a cached payload that never passed through the projection. 39 tests, **6 of 6 mutations caught**. |
| ~~4~~ | ~~**Music and a spin bed**~~ — **shipped 2026-08-17.** Two optional URLs on `GameAssets`, driven off the phase model. The playing is four lines of `HTMLAudioElement`; what is split out and tested is **when** each track should run, because a bed still looping after the reels stop is as wrong as one that never starts and neither raises an error — a tester with the volume down notices neither. `revealing` counts as spinning, which is the subtlety: the result is known but the reels are moving, so cutting there stops the sound partway through the motion it accompanies. Muting pauses rather than only setting `.muted`, and unmuting restores *what the phase asks for* rather than everything. 29 tests, **7 of 7 mutations caught**. |
| ~~5~~ | ~~**Rotate-device prompt**~~ — **shipped 2026-08-17.** Portrait **and** narrow, because a portrait tablet has plenty of room and a tall desktop window is still a desktop — prompting either covers a game the player can already see, which is the worse of the two failures. `matchMedia("(orientation: portrait)")` rather than comparing width to height: the comparison only re-evaluates when something else triggers a resize, while the media query fires on the rotation itself, which is the moment the overlay must clear. Does **not** gate play — `computeGridMetrics` already fits the grid to the tighter axis, so nothing a player is paid on can be cropped. 12 tests, **6 of 6 mutations caught**. |
| ~~6~~ | ~~**Object storage and an upload button**~~ — **shipped 2026-08-17.** MinIO in compose, an `asset-storage` package, upload/clear routes, and an Upload button beside every URL field. Assets are stored as **keys** and served as short-lived **signed URLs**, which is the reference's design *and* the source of its worst bug: what a client reads is not what the server stores, and their `updateDraft` merged the client's `assets` object straight back in — so every "Save draft" overwrote the key with the signed URL it had just displayed, compounding one nesting level per save until a repair script with a recursive unwinder was needed. Two defences here: **the draft PUT refuses `assets` outright** (the upload and clear routes are the only writers, and they write keys they generated), and `isStorageKey` rejects anything URL-shaped if that is ever undone. Proven rather than argued — a signed URL echoed back through PUT three times left the stored key unchanged at 73 characters. **Mutation testing changed the code**: `isStorageKey` began with five guards and three were equivalent mutants, because the character allowlist already refuses every scheme, query and fragment. Two guards do the whole job, and the file now records which case each covers. |
| 8 | A sweep for orphaned objects | Clearing an asset deliberately leaves the object in storage: a published game may still reference the key, and a draft edit must never break a live game. That is correct and it accumulates — worth a sweep that reads every published `gameVersions` document before deleting anything, not a delete-on-clear. | Only worth doing when someone needs to host art *here* rather than at a URL they already have. Read F25, F26 and the reference's `repair-corrupted-asset-urls.ts` before starting: signing introduces a read shape that differs from the write shape, which is exactly the asymmetry this design currently does not have, and the reference shipped a compounding data-corruption bug on it. |
| ~~7~~ | ~~**Per-input names on multi-control rows**~~ — **done 2026-08-17, and it was four times bigger than this row predicted.** The row said "SettingsEditor's multi-control rows"; a sweep found **18 unlabelled controls across seven files**, including a password reset whose only description was a placeholder that vanishes the moment the user types, and two fields in `GameListScreen` whose "labels" were bare `<div>`s associated with nothing at all. `NumberInput` and `Select` gained the `label` prop `TextInput` already had, and every caller now passes one. Guarded by a **source-level check** rather than six new component suites: it asserts on text and so cannot see wiring, but it covers every screen at once — including the six with no tests of their own, which is exactly why this shipped. It carries its own guard-the-guard test, because a regex that silently stopped matching would make the whole file pass while checking nothing. Both mutations caught. | `Field` now names the *row* (`role="group"`), and `TextInput` accepts a `label`, but `SettingsEditor`'s multi-control rows do not pass one — so "Grid"'s reels and rows boxes are still anonymous to a screen reader. The primitive work is done; this is the caller-by-caller half, on screens with no tests of their own. |

**The accessible-name defect in `Field` is recorded as F28**, since it was a
real shipped bug rather than a gap in this section's plan. Row 7 above is
its second half, now also closed — and it turned out to be four times the
size this section predicted.

**Surveyed against the reference on 2026-08-17**, since "what is missing"
was worth answering from its source rather than from memory. What it has and
this client does not, with an honest read on whether each is worth copying:

**All four worth-doing rows are now closed** (2026-08-17). Autoplay,
themes, audio and the rotate prompt shipped in that order — independence
first, so nothing waited on a decision it did not need. Two of the four had
a **surviving mutation that turned out to be a real gap rather than an
equivalent mutant**, and both were the same shape: a guard that looked
untested and was merely *under*-tested. Autoplay's decrement order changed
only the counter after a refused send (7 remaining versus 8, measured), and
the rotate prompt's non-finite guard is reachable only by `-Infinity`, since
`NaN` and `Infinity` are already refused by the comparison itself. Worth
remembering as a method: when a mutation survives, probe for the input that
distinguishes the two versions before concluding they are equivalent.

| Reference module | Lines | Verdict |
|---|---:|---|
| `ui/bonus/modules/WheelBonusView` + `wheelAngleMath` | ~17 (math) | **Worth doing** — row 1 above. The only gap affecting a module this repo actually ships. |
| `audio/MusicManager` | 76 | Real gap, and honestly recorded in its own source as one the reference shipped late: uploading music did nothing for a while, and "the in-game mute icon flipped its own emoji with no actual sound to mute". Needs a `musicUrl` asset field first, so it is gated behind the artwork upload row rather than independent. |
| `ui/overlay/RotateDeviceOverlay` | 47 | Belongs to the responsive work below, which is a stated priority call rather than an oversight. Its technique is the part to keep: `matchMedia("(orientation: portrait)")` rather than comparing width to height, so it reacts when no breakpoint changes. |
| `ui/overlay/{OverlayManager,CenteredModal,AnchoredPopover,LoadingOverlay}` | 74/…/124 | **Deliberately not adapting.** This client has one overlay (the bonus panel) and one fatal state; a manager, a modal primitive and a popover primitive are infrastructure for a UI that does not exist here yet. Adapting them now would be transplanting, which `CLAUDE.md` names as the failure mode. |
| `ui/customEffects/*` (registry, eventBus, plugin effects) | ~19 + | Same verdict, more strongly: a plugin system for per-game visual effects presumes games with bespoke art direction. Nothing here has that yet. |
| `ui/celebration/WinCelebrationOverlay` | 93 | **Already covered** by `winPresentation.ts` + `winCountUp.ts` (38 tests), which additionally hold the money-formatting bug the reference shipped here — a mid-tween `toFixed(2)` printing "WIN 2000.00" for a 20.00 win. |

**Responsive / mobile layout is explicitly deprioritised** (decided
2026-08-17). Not an oversight and not blocked — a stated priority call, so
that nobody reads its absence from the list above as something forgotten and
"fixes" it ahead of the rows that matter.

What already holds without any further work: `computeGridMetrics` fits the
grid to **whichever axis is tighter** (7 tests, including a 2000x400 and a
320x900 viewport), so the reels never crop on a narrow or short window —
which is the half that would be a *correctness* problem, since a cropped reel
hides symbols a player is being paid on. What is missing is the half that is
purely presentational: the surrounding chrome does not adapt, and there is no
rotate-device handling. When it is picked up, the reference drives that off
`matchMedia("(orientation: portrait)")` rather than comparing width to
height, so it reacts even when no breakpoint changes.

**A caution for whoever picks this up**, and it is the section-D lesson in a
new costume: a component test can mount a tree, assert on it, and still
establish nothing about whether a *screen* uses that component. A primitive
can be perfect and unmounted — which is F24 exactly, one layer down. Test the
screen's own wiring, not just the parts it is assembled from.

### D. Test-infrastructure debt

- **A fourth probing round found seven more divergences in fifteen probes.**
  Same method as the first three — run a behaviour against both engines in a
  throwaway script and diff — and the same result: **none was reachable from
  an existing caller**, so the suite could not have shown them. Five were
  fixed, two are now loud refusals, and all seven are pinned. Every fix was
  mutation-verified: reverting it fails exactly its own conformance case,
  5 of 5.

  | Divergence | Direction | Reachable? |
  |---|---|---|
  | A document **missing the sort key** sorted as though it held the largest value | **Inverted** | **Yes** — see below |
  | A **number sorted after a string** on a mixed-type field | Inverted | No |
  | **`$inc` on a string field concatenated** (`"abc"` + 1 = `"abc1"`) and reported success | **More destructive** | No |
  | A **dotted query through an array** of subdocuments matched nothing | More restrictive | No |
  | **`$gt`/`$lt` on an array field** matched nothing | More restrictive | No |
  | A **caller-supplied `_id` was overwritten**, so a duplicate insert succeeded | More permissive | No |
  | **`$set` through an array index** replaced the array with an object, losing every other element | **More destructive** | No |

  **The sort one is reachable, and it is the find that matters.** Mongo's
  BSON type ordering puts a missing field *below* every number; the fake
  compared with `>`, and in JavaScript `undefined > anything` is false — as
  is `undefined < anything` — so a document missing the key sorted as the
  **largest**. Not arbitrary, inverted. `recoverRound` sorts
  `{ createdAt: -1, _id: -1 }` to choose the round to replay, and `createdAt`
  is **not** in the rounds validator's `required` list, so a document without
  it is legal. The `_id` tie-break happens to mask it today — measured, both
  engines pick the same round — which is precisely why nothing failed.

  **Two are left as refusals rather than implementations**, following F17's
  precedent. Writing through an array index and `$inc` on a non-numeric field
  both now throw with a message naming the work. A half-modelled array path
  is how the next silent divergence gets in, and no caller needs either.

  The running total is **sixteen divergences across four probing rounds**,
  and the split has not moved: permissive, restrictive, and silent, with only
  the last unique to a stand-in. What has changed is the count of *directions*
  — "more destructive than the database" now has three members, and it is the
  worst of them, because a test can show a field correctly written while
  production keeps or loses something else.
- **`fakeMongo` is 562 lines and still has no test of its own.** It is
  covered instead by **53 conformance cases run against real MongoDB**, which
  is the more valuable half: a stand-in's only meaningful property is
  agreement with the thing it stands in for, and a unit test of the fake
  would pin its behaviour to itself. The file has roughly doubled in size
  under that suite, and every unit test in the repo trusts it — so the
  conformance count is the number to watch, not the line count.

  **Sixteen divergences have been found across four probing rounds** — nine
  in the first three (the bullets below) and seven in the fourth (the table
  above). They split four ways, and the split is the useful part: *more
  permissive* than Mongo, *more restrictive*, *silent* (accepting an option
  or operator and ignoring it), and *more destructive* — changing or losing
  data Mongo would have left alone. Only the silent group is unique to a
  stand-in; the rest are ordinary bugs that happen to live in test
  infrastructure.

  **A fifth category showed up with F26, and it is not a divergence at
  all:** the fake was missing `replaceOne` outright, so the *correct* fix
  for a production bug threw `is not a function` in every publish test. That
  fails loudly and is therefore the harmless kind — but it shapes the code
  written against the fake, which is the quiet cost. `$set` is what the
  publish path used, and `$set` was what the fake supported. A stand-in's
  gaps do not only hide bugs; they also make the wrong call the path of
  least resistance. `replaceOne` is now implemented and pinned by three
  conformance cases against real Mongo.

  The fourth round added the destructive column its third member and is the
  one to watch: a test can show a field correctly written while production
  keeps or loses something else entirely.

  **None was reachable from any existing caller**, so no amount of running
  the suite would have surfaced them. All nine came from probing: running the
  same operations against both engines in a throwaway script and diffing the
  results. That took minutes and found what reading the file had not.
- **Three of the F-rows were in the stand-in, not the code** (F16, F17,
  F21) — the ones that surfaced through a failing test rather than a probe.
  Each was the same shape: the fake quietly more permissive than Mongo, so a
  correct assertion failed against correct code, or a test passed while
  asserting nothing.

  The rule that came out of them still holds and is worth keeping at the top
  of this section: **when a test fails against code that reads correctly,
  suspect the fake before the code.** Its limit is now known, though — thirteen
  of the sixteen divergences never failed a test at all, so the rule catches the
  ones that announce themselves and nothing else. Pinning each new
  `fakeMongo` behaviour with a conformance test at the moment it is added is
  the practice; **probing for divergences the callers do not exercise** is
  what actually finds them.
- **The fake implements only the operators this codebase happens to use.**
  `$push` and friends are still absent. Since F17 an unknown update operator
  throws rather than being ignored, so the *silent* half of that problem is
  closed. Each addition should arrive with a conformance test, not on its
  own.
- ~~**A test had to splice the backing array to delete a document.**~~
  **Fixed** — `deleteOne` and `deleteMany` are implemented, pinned by three
  conformance tests including the distinction that makes them separate
  (`deleteOne` on a filter matching three rows removes one, not three) and
  the empty-filter wipe that a typo produces. `middleware.test.ts` now
  deletes through the collection API.

  Worth stating why the workaround mattered rather than treating it as
  cosmetic: reaching past the API into `raw.collection(…).all()` bypasses
  every guarantee the API provides — the unique-index check, the document
  copy — so the test was exercising a path **no production caller can
  take**. The replacement was mutation-verified rather than assumed: removing
  the `!user` term from the auth middleware's revocation check fails exactly
  the rewritten test, so the deletion is genuinely observed and the
  assertion still has teeth.

  Nothing in production deletes anything. These exist so a test can express
  a case honestly, which is the only reason the stand-in models anything.
- ~~**The same silence survived on the QUERY side.**~~ **Fixed.** F17 closed
  this for update operators and the matching hole in `matches()` went
  unnoticed for the same reason it always does — nothing used it. An
  unrecognised query operator fell through to `actual === expected`,
  comparing a document's value against the operator *object*, which is never
  equal. Measured against real Mongo: `{ n: { $gte: 5 } }` matched **0** in
  the fake and **2** in Mongo, and `$lte`, `$in` and `$exists` the same.
  Worse than the update-side silence, because zero results reads as *data*
  rather than as an error — a test asserting "no matches" would have passed
  for entirely the wrong reason. Unsupported operators now throw, naming
  themselves.
- ~~**And the fake could not match a subdocument at all.**~~ **Fixed**, found
  by the test written to prove the refusal above did not overshoot.
  `{ grid: { reels: 5, rows: 3 } }` matched nothing, because `===` on two
  structurally identical objects compares references. Mongo compares
  structurally, so this was F16's family once more. Now compared via
  `JSON.stringify`, which is deliberately **order-sensitive on keys** —
  Mongo's actual rule for subdocument equality. Deep equality would have been
  *more* permissive than the database, which is the direction that hides
  bugs.
- ~~**`findOneAndUpdate` defaulted to the wrong document.**~~ **Fixed.**
  Mongo returns the document as it was *before* the update unless told
  otherwise; the fake returned the updated one. Latent, because both real
  callers (the ledger's debit and the bonus-step claim) pass
  `returnDocument: "after"` explicitly — they need the post-update state to
  know what happened. A future caller omitting it would have read the new
  document in tests and the **old one in production**, which on the money
  path is a balance read from the wrong side of a write.
- ~~**Dotted paths in update operators did nothing.**~~ **Fixed.**
  `$set: { "grid.rows": 3 }` created a literal `"grid.rows"` property
  instead of nesting, so the update reported success and changed nothing a
  reader would find. Asymmetric, which made it worse: `matches()` already
  resolved dotted paths on the *query* side, so a test could filter on a
  nested field and then silently fail to update it. `$set`, `$inc` and
  `$unset` now share one path-writing helper that copies each level on the
  way down — writing in place would edit the document `findOneAndUpdate`
  returns as "before", which would then show the update it is meant to
  predate.
- ~~**`modifiedCount` counted matches, not modifications.**~~ **Fixed.**
  Mongo counts a document as modified only when the update actually changed
  it; re-setting a field to the value it already holds matches but does not
  modify. `updateMany` also returned no `matchedCount` at all. Both matter
  to real callers: `sweepAbandonedBonusSessions` returns `modifiedCount` as
  "how many sessions I just expired", so an over-reporting fake lets a sweep
  claim work it did not do, and `setPassword` decides 404-versus-success
  from `matchedCount`.
- **A flaky test, fixed properly rather than widened.** The full suite
  failed once in five runs on "moves only the bonus half of the split" —
  pre-existing, unrelated to the stand-in. It compared two **independent
  unseeded** simulations and asserted their `baseRtp` drift stayed under a
  threshold. Its own comment records having already been rewritten once for
  flakiness: a ratio form failed when the drift was near zero, then an
  absolute bound of 0.05 failed when it spiked (observed 0.0554). **Noise
  has no bound you can assert against.** Both runs now share a `runSeed`, so
  the same spins are drawn in the same order and only the bonus scoring
  differs — `baseRtp` is now asserted **exactly equal** rather than merely
  close, which is a stronger claim as well as a stable one. `runSeed` only
  became available when item G's reproducibility work landed, so this was
  not an option when the test was written. Five consecutive clean runs.
- ~~**`findOne` ignored its `sort` option.**~~ **Fixed.** Accepted by the
  signature and silently dropped, so `findOne({}, { sort: { n: 1 } })`
  returned whatever was inserted first. Returning a *different document*
  than the caller asked for is the worst failure a read can produce — the
  value is plausible and nothing about it looks wrong. `find().sort()` and
  `findOne` now share one comparator so they cannot drift again.
- ~~**`$ne` against an array field matched everything.**~~ **Fixed.** Mongo's
  `$ne` on an array is the negation of *membership*; the fake compared the
  array object against a scalar, which is never equal, so every document
  matched. The permissive direction, and `countActiveSuperAdmins` queries
  `roles` exactly this way — an over-matching fake would report
  administrators who do not hold the role.
- ~~**A `null` query did not match a missing field.**~~ **Fixed.** Mongo
  treats `{ field: null }` as matching both an explicit null and an absent
  field; `undefined === null` is false in JavaScript, so the fake matched
  only the explicit case. The restrictive direction, reading as "no such
  documents" rather than as an error. `loginThrottle` stores
  `lockedUntil: null`, so a query for un-locked accounts is this shape.
- ~~**The fake modelled none of `ignoreUndefined`.**~~ **Fixed**, and this
  was the largest single divergence found. The real client is constructed
  with `ignoreUndefined: true` — `connectMongo`'s comment explains why:
  without it an optional field left undefined is stored as an explicit null,
  and a round read back would no longer match the round that was written.
  That option changes three behaviours and the fake disagreed on all three:
  an inserted document kept a field Mongo drops, a query on an undefined
  value matched nothing where Mongo ignores the condition, and — the one
  that mattered — **`$set: { x: undefined }` ERASED a value Mongo leaves
  untouched.** That last is the fake being *more destructive* than the
  database, a direction none of the earlier divergences had: a test could
  show a field correctly cleared while production quietly kept the old one.
- **The publish gate's sampling was the root cause of both flakes, and is
  now optional.** `publishDraft` takes a `runSeed` that **production never
  passes** — a real publish must draw a fresh sample, or the gate would check
  the same 100k spins forever and a paytable change could pass on a seed that
  happened to flatter it. Verified: three consecutive production-shape
  publishes still produce three distinct seeds. Tests pass one for the
  opposite reason, and `publish.test.ts` had **twenty-one** unseeded
  success-path publishes in a single file. They now share a seed measuring
  0.9457 — a drift of 0.0043, an order of magnitude inside tolerance — so
  they fail when the code breaks rather than when the sample is unlucky. The
  refusal tests stay unseeded deliberately: their targets are far outside any
  plausible measurement, so their verdict never depended on the draw.

  **CI caught this before the fix landed, and its evidence is worse than
  the local measurement.** Run 31965736011 failed with `measured RTP 0.8851
  differs from target 0.95 by 0.0649` — a drift well past the 0.05 tolerance,
  where 25 local runs of the same draft produced a minimum of 0.9062 (drift
  0.0438) and never actually refused. So the distribution's tail is fatter
  than a couple of dozen samples suggests, and "I ran it several times and it
  passed" was never evidence that it would keep passing. The seeded run
  measures 0.945715 on every execution — a drift of 0.0043, a **12x** margin
  inside tolerance — verified byte-identical across three runs against the
  exact draft the tests build.

  **The first fix missed five call sites, and CI found them.** The
  conversion matched only `publishDraft(db, goodDraft(), "designer-1")`
  literally, so three calls using a different actor id (`"designer-2"`,
  `"designer-7"`) and two passing a locally-modified `draft` variable stayed
  unseeded. CI failed on one of them the next run — `measured RTP 0.8940
  differs from target 0.95 by 0.0560`. The lesson is narrow and worth
  keeping: **a mechanical find-and-replace over test call sites needs an
  audit of what it did NOT match**, not just a check that the suite passes,
  because an unconverted flaky call passes almost every time by definition.
  The audit is now a grep that lists every remaining `publishDraft(db,` and
  requires each one to be a refusal test.

  Worth recording that the seed passthrough is an **equivalent mutation**:
  deleting it leaves every test passing, because the seed changes only
  whether a decision repeats, not what it is. A mutation that reintroduces
  flakiness cannot be caught by a suite that runs once — the protection is
  the comment, not an assertion.
- **A second unseeded-simulation flake, in `app.test.ts` this time.** The
  version-bump test published twice and asserted the version reached 2;
  `publishDraft` runs an **unseeded** 100k simulation, so each publish is an
  independent sample. Measured drift on the tuned draft ranges 0.007–0.037
  against a 0.05 tolerance — comfortable, but roughly 1.4 sd of headroom
  against ~0.02 noise, so a refusal is rare rather than impossible. When it
  happened the test failed several assertions later with `1 !== 2`, naming
  neither the gate nor the cause. A `publishOrFail` helper now asserts the
  200 at the point of publishing, so the failure says what happened. **This
  does not remove the flake** — only seeding the publish route would, which
  is a production change item G already tracks — it converts a confusing
  failure into an obvious one. Applied to all seven call sites whose subject
  is post-publish state rather than the gate.
- **Both of the above were latent, and that is the point.** Neither operator
  nor subdocument query appears anywhere in this codebase today, so no test
  could have failed. They were found by *asking what the fake does with input
  it has never seen*, which is now the third distinct way this stand-in has
  disagreed with Mongo (F16/F21 permissive, F22 restrictive, these silent).
  The lesson is that auditing a stand-in against its own callers finds
  nothing — it has to be audited against the thing it stands in for.

  **The audit that found them is worth repeating rather than describing.**
  Behaviours were run against both engines in a throwaway script and the
  results diffed. Four rounds of this found **sixteen** divergences in about
  as many minutes each, where reading the file had found none. The conformance
  suite is now 50 cases, and the cheapest way to extend it is to write the
  probe first and keep only the rows that differ.

  Worth noting how they split: *more permissive* than Mongo (F16/F21's
  direction), *more restrictive* (F22's), *silent* — accepting an option or
  operator and ignoring it — and, from the fourth round, *more destructive*,
  changing or losing data Mongo would have left alone. Only the silent group
  is unique to a stand-in; the rest are ordinary bugs that happen to live in
  test infrastructure.

  **Fifteen of the sixteen were unreachable from any existing caller**, so no
  amount of running the suite would have surfaced them. The sixteenth is the
  exception worth knowing about: the missing-field sort order **is** reachable
  through `recoverRound`, and stayed hidden anyway because a second sort key
  masked it. Unreachability is what the probe is for; a divergence that is
  reachable and still silent is the stronger argument for probing.
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
- **A fallback inside the unit under test can absorb your malformed
  fixture.** The `Number.isFinite` guard on the derived bonus multiplier
  survived mutation at first, because the test fed it `rewardMultipliers:
  []` — and the wheel module's *own* `rewards()` helper falls back to its
  defaults for an empty array, so the value never reached the guard. The
  test asserted nothing while reading as though it asserted the important
  thing. `rewardMultipliers: [Infinity]` does reach it, because `Infinity`
  passes the module's `typeof v === "number" && v >= 0` filter. This is the
  "fixture already inside the allowlist" trap one layer deeper: not a
  fixture that is already valid, but one the callee *repairs* before your
  guard sees it. When a guard survives mutation, check whether the input
  ever arrives.
- **Asserting on a verdict cannot pin arithmetic.** The runs test's first
  suite caught 6 of 11 mutations, and every survivor was an off-by-one that
  a pass/fail assertion is structurally blind to: in a 1000-draw stream a
  run count wrong by one moves z by 0.06 standard deviations, so the verdict
  is unchanged at *any* sample size. Raising the sample size makes this
  worse, not better — the statistic concentrates. The fix was a fixture
  small enough to work out **by hand** (n=8: 4 runs, expected 5, z² = 7/12
  exactly), asserted to full double precision, where every mutation lands on
  a visibly different number. Applies to anything computing a statistic and
  then thresholding it: test the number, not the side of the line it fell on.
- **An export diff is a scope diff until proven otherwise.** Comparing the
  two repos' exported functions gave 231 names present there and absent
  here, which reads alarming and is almost entirely product surface this
  project deliberately does not have. Exactly one — `runsTest` — was a real
  gap, and even that closed a *completeness* concern rather than a
  detection one, which took three constructed counter-examples to establish
  rather than assert. The useful form of the question is not "what is
  missing" but "what is missing that I cannot already do".
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

### E. Operational — what actually blocks going live

Ordered by what stands between the current state and a running service.

1. **A host to deploy to (item 1).** The pipeline is built, tested against a
   real registry, and gated on CI. What is missing is a box and the six
   secrets naming it — every one listed in `docs/DEPLOY.md`. This is now a
   provisioning decision rather than an engineering one, and it is the only
   thing between a green CI run and a running service.
2. **Secrets in environment variables (item 4).** The deploy injects them
   from GitHub Actions rather than a committed file, which is better but is
   still not a managed store with rotation. The startup guards already refuse
   weak values, so what is missing is storage and rotation, not validation.
3. **Per-instance rate limits (item 3b).** Correct for one instance, wrong
   the moment there are two — and it is what blocks zero-downtime deploys,
   since those need two instances of a service running at once.
4. **Branch protection (item 2).** Needs a paid plan; the pre-push hook
   covers the realistic case.

The dependency worth noticing: **3b blocks zero-downtime**, so the deploy's
brief gap during `up -d` is not independently fixable. Both are recorded in
`docs/DEPLOY.md`'s closing section rather than implied away.

#### ~~Two decisions waiting on the first box~~ — both taken, overlay written

**`infra/docker-compose.staging.yml` exists.** It was written before the box
rather than after, because both decisions below turned out to be answerable
without one — and the second is a security posture that must not be decided
under time pressure on the day a box appears.

What it does, and what it deliberately does not:

| | Decision | Why |
|---|---|---|
| Mongo's port | **Unpublished** (`!reset []`) | No authentication anywhere in this stack. A public address would expose every collection. |
| App ports 9102–9106 | **Still published**, firewall instead | `deploy.yml`'s health check curls `localhost:9102` *from the box*. Unpublishing them makes a healthy deploy fail its own verification and auto-roll-back — a worse failure, and a silent one about its cause. |
| Restart policy | `restart: always` on all six | — |
| Name | `staging` | See below. |

**`!reset []` is load-bearing and was verified, not assumed.** Compose merges
sequences by *appending*, so a plain `ports: []` in an overlay leaves the base
mapping fully intact while reading exactly like a removal. Measured against
both forms: `ports: []` still resolved to `27018:27017`, `!reset []` resolved
to none. That is the failure this whole overlay exists to prevent, one layer
down — a file that looks like it closed the port and did not.

**The overlay is wired in through `COMPOSE_FILE`, not `-f` flags.** The deploy
writes `COMPOSE_FILE=docker-compose.yml:docker-compose.staging.yml` into
`infra/.env`; compose reads it as though the flags were passed, so all six
`docker compose` invocations across `deploy.yml` and `rollback.yml` stay bare.
A `-f` pair at six call sites is five chances to forget one, and the one that
would get forgotten is the rollback — which runs when production is already
broken. The one hardcoded `-f docker-compose.yml` (the failure-path log dump)
was changed to `cd` for the same reason: it would otherwise print logs from a
different resolved config than the one that failed.

**Verified against the running stack**, since a compose change is exactly the
kind that reads correctly and behaves otherwise:

- Mongo's port refused from the host; `docker exec … mongosh` still answers,
  which is the operational access the mapping was there for.
- Both health checks the deploy actually runs still pass.
- Sibling DNS intact — the reference repo's `getaddrinfo EAI_AGAIN` bug came
  from binding `127.0.0.1` instead of omitting `ports:`, and omitting it is
  what this does.
- `e2e:spin` passes in full under the overlay.
- Local dev unchanged: without `COMPOSE_FILE` the overlay is inert, and
  27018 is open again after restoring `.env`.

Still deliberately absent: **TLS and a reverse proxy.** Unpublishing the app
ports properly (rather than firewalling them) needs a gateway terminating TLS
and a health check that goes through it. That needs a hostname and a
certificate, which genuinely do follow the box.

**The environment should probably be called `staging`, not `production`.**
Both workflows name a GitHub environment `production`. For a project at this
stage that is likely untrue, and a deployment history page that claims
otherwise is worse than one that does not exist. The reference repo landed in
exactly this ambiguity and left it visible: its overlay is headed
`# Remote/staging deploy overlay` while its workflow calls the same box
production. Renaming is a one-line change in each file, and the honest
sequence is staging first, a second environment later if there is ever
something to separate.

**Mongo's port must not be published on a public box.** `infra/docker-compose.yml`
maps `27018:27017`, which is right locally and dangerous anywhere reachable:
this stack runs Mongo with **no authentication at all** (`mongodb://mongo:27017`,
no credentials anywhere), so any public reachability means anyone can read,
write or delete every collection. The reference hit this and recorded
something worth inheriting — binding to `127.0.0.1` instead of removing the
mapping triggered a Docker networking bug on their host where the container's
own network attachment silently failed, breaking sibling DNS resolution,
reproduced three times. Omitting `ports:` entirely both sidesteps that and is
the correct posture: `docker exec … mongosh` covers real operational access.

Both now live in `docker-compose.staging.yml`, described above. The workflows
still name a GitHub environment `production`; renaming that is a one-line
change in each file and is the half that genuinely waits, since the
environment has to be created in repository settings anyway.

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

### ~~K. The certification report has no runs test~~ — added

**Severity: low (certification completeness) · Effort: low**

Found by diffing the reference repo's exported surface against this one:
331 exports there, 183 here, and after discarding everything that is scope
rather than gap (`game-renderer`, `game-shell`, operator/currency/reporting
surfaces, `asset-storage`, `secrets`) exactly one statistical test remained
that this suite did not have.

`runsAboveBelowMedian` is now the fourth test in the report. It counts
median crossings and compares them to the null distribution — an **ordering**
test, where the other three are all distributional.

**Stated honestly, because the measurement did not support the obvious
claim.** Three streams were built specifically to evade the existing suite —
a sorted sweep, a block-ordered stream, and strict alternation — and
`serialCorrelation` caught all three. Its 16×16 contingency grid detects any
structure in consecutive pairs, not merely linear correlation, which makes it
strictly stronger than the scalar lag-1 coefficient the reference pairs its
runs test with. **No detection hole was demonstrated.** This was added
because a certification reviewer expects a runs test by name and its absence
invites a question the other three cannot answer, not because the suite was
missing coverage.

What it does add is a *diagnosis*. The blocked stream fails
`chiSquaredUniformity` too — but on `p = 1`, the too-even direction, which
says "these counts are suspiciously perfect" rather than "these draws are in
sorted order". Two tests failing for unrelated reasons is not redundancy; the
runs row is the one that names the fault. Pinned by a test asserting both
directions.

Adapted rather than transplanted, in three ways that matter:

- **Reports z² instead of z**, which is exactly chi-squared with one degree
  of freedom. That reuses the existing `evaluate` path, so there is no second
  numerical method to keep correct and the tail precision won by item J comes
  along free. Verified against published two-sided normal values: z=1.96 →
  0.0499958, z=3.29 → 0.0010019.
- **Two-sided band**, where the reference's `pass` is one-sided. Too *many*
  runs is alternation and too *few* is blocking; a one-sided test waves one
  of them through.
- **Splits at 0.5, not at the sample median.** The theoretical median of a
  uniform generator *is* 0.5, and splitting at the sample median would make
  the test partly self-referential — a generator emitting only values in
  [0.90, 0.91) would split its own output evenly and score a healthy run
  count on a stream with no spread at all.

The degenerate case (every draw on one side) has zero variance and is
returned as an explicit failure rather than a division by zero, since a `NaN`
p-value compared against the band yields `false` for the wrong reason and
prints as `null`.

**A weak first suite, worth recording.** The initial tests caught only 6 of
11 mutations. Every failure case was so extreme that any arithmetic error
still failed it — a run count off by one in a 1000-draw stream moves z by
0.06 standard deviations, so *no* pass/fail assertion at any sample size can
detect an off-by-one. The fix was a fixture worked out **by hand** (n=8,
alternating in blocks of two: 4 runs, expected 5, variance 512/448, z² = 7/12
exactly) where each mutation lands on a different number — 7/12 correct,
2.3̄ for a dropped initial run, exactly 0 for a dropped `+1`, 0.35 for a
flipped variance sign. All 11 mutations caught after that. **Asserting on a
verdict cannot pin arithmetic; only asserting on the statistic can.**

### ~~L. `connectMongo` does not wait for PRIMARY~~ — not needed here, and why

The reference's `client.ts` self-heals replica-set initiation and polls
`replSetGetStatus` until `myState === 1`. Its docstring records a real bug:
on container restart with a pre-existing replica-set data directory, mongod
completes its startup election *after* `replSetGetStatus` starts succeeding,
and three services racing to connect all hit "node is not in primary or
recovering state".

**This architecture solves it one layer down instead.** `infra/docker-compose.yml`
initiates the set in mongo's own healthcheck and gates every dependent
service on `condition: service_healthy`, so nothing connects until the node
answers. Porting `waitUntilPrimary` would be scaffolding against a race that
cannot occur here.

Tested rather than assumed, since the claim is about startup ordering and
that is exactly the kind of thing reasoning gets wrong: the stack was fully
stopped and cold-started with a pre-existing volume — the precise scenario
the reference's comment names — and both `game-backend` and `backoffice-api`
came up clean, zero election errors in either log, both health endpoints 200.

Recorded as a **deliberate non-decision** rather than left silent, because
the next person to diff the two repos will find the same missing function and
should not have to re-derive why it is absent. The one thing worth watching:
if the healthcheck's `rs.initiate` gate is ever weakened, or a service is
added without `depends_on: service_healthy`, this reasoning expires with it.

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

### ~~G. A real finding from writing this list~~ — largely closed

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

**Three of the four options are now done.**

- ~~**Derive the multiplier per module**~~ — shipped, and this was the
  substantive one. `BonusModule` gained an optional
  `expectedReturnMultiplier(params)`, so each module owns its own expected
  value rather than a central switch guessing on its behalf.

  **`wheel` is exact.** Every segment is equally likely — the property its
  own docstring promises — so the answer is the arithmetic mean of the
  reward table. For `reference-5x3` that is **16.875**, not the 20 that was
  assumed: a 16% error on the figure feeding the gate. Measured at 100k
  spins on one seed, the change moves the game's RTP from 0.9387 to 0.9267
  and **doubles its drift** from 0.011 to 0.023 against a ±0.05 tolerance.
  Still passes, but now on a number tied to the actual paytable.

  **`pick` is analytic but assumes a stopping rule:**
  `E[total] = P/(B+1) × mean(rewards)`, where the first factor is the
  standard result for how many of P items precede the first of B markers in
  a random arrangement. Verified against a 400k-round simulation across five
  configurations; worst disagreement 0.07 on a value of 26.5. The assumption
  is that a player keeps picking until a blank — which is the only behaviour
  the module permits today, since `step` accepts no cash-out. Recorded in
  the source so that if one is ever added, this becomes an upper bound
  rather than a silently wrong number.

  Deriving is **not** playing the module, and the original reasoning for not
  playing it still stands: folding in a module's own randomness would
  conflate "is the base game's maths right" with "is the bonus module's
  maths right". Computing the expected value analytically keeps the two
  questions separate while removing the guess.

- ~~**Surface it in the publish response**~~ — shipped earlier, and now
  extended: the report carries `bonusReturnSource` (`"derived"` or
  `"assumed"`) and `bonusModuleId` alongside the figure, and **the audit
  entry records both**. The share alone could not distinguish them, and they
  are very different evidence — 7% resting on arithmetic over the real
  reward table versus 7% resting on a flat guess are the same number. An
  auditor reading a stored record years later cannot be expected to know
  which modules supported derivation on the day it was written.

- **Simulate the module for real** behind a flag — still open, and now
  considerably less valuable. Deriving closed most of the gap for the two
  shipped modules at none of the conflation cost.

**Where it still falls back, honestly.** A game declaring **no** module, or
**more than one**, and any module not implementing the hook. The
multi-module case is deliberate: weighting each module by its trigger share
is something nothing in this codebase currently expresses, and deriving from
the first while ignoring the rest would be *worse* than the flat constant,
because the result would look derived. Both shipped fixtures declare exactly
one module.

### F. What I would NOT do next, and why

Recorded so the reasoning is not rediscovered:

- **More `math-engine` tests.** `paylines`, `matrix`, `wild`, `scatter`,
  `bonusTrigger` and the independent cross-check are all done. `pick.ts` was
  skipped deliberately — it already has nine tests including the concurrency
  interleave and the prize-tile guard.
- **Testing the fixtures** (`reference-game.ts`, `pick-bonus-game.ts`).
  They are data. Their properties are asserted where they are used.

  **`free-spins-game.ts` is the exception, and the distinction is worth
  keeping.** It has its own suite because its RTP is a *fitted* number whose
  fit couples two things that move together — the free spins are drawn from
  the same paytable as the base game, so lowering the base lowers the
  feature too. That made the fit non-obvious (12% measured 0.927, 10%
  overshot to 1.03, 8% landed at 0.954) and easy to break with an edit that
  looks locally harmless. The other two fixtures have no such coupling: the
  reference game's bonus is a self-contained wheel, and the pick fixture is
  a deliberately-broken instrument with no RTP worth asserting.

  The rule, then, is not "fixtures are data" but **"data whose values were
  fitted needs a test that re-runs the fit"**.
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
