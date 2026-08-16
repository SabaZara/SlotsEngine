# Slots Engine

A config-driven, multi-game slot platform. **A game is data, not code**: one
generic evaluator plays any game described by a `GameDefinition` document, so
shipping a new game means publishing a document, not deploying a service.

A designer authors and publishes a game in the backoffice; a player launches
it, spins, wins, triggers a bonus and reconnects — end to end, with every
movement of money audited and replayable.

---

## Quick start

```bash
cp .env.example infra/.env
```

```bash
docker compose -f infra/docker-compose.yml up --build
```

Then, with the stack running:

```bash
npm test
```

```bash
GAME_BACKEND_URL=http://localhost:9102 GAME_SOCKET_URL=ws://localhost:9103 LAUNCH_TOKEN_SECRET=dev-only-launch-secret-change-me-in-production-xyz789 npm run e2e:spin
```

| Where | URL |
|---|---|
| **Backoffice UI** | `http://localhost:9106` — sign in as `admin@example.com` / `admin` |
| Play a game | `http://localhost:9104/?gameId=reference-5x3&token=…` |
| Backoffice API | `http://localhost:9105` |
| Game backend | `http://localhost:9102` |

A player needs a signed launch token, which a real casino would mint. To
generate one locally:

```bash
node -e 'const{createHmac,randomUUID}=require("crypto");const S=process.env.LAUNCH_TOKEN_SECRET;const n=Date.now();const p={kind:"launch",operatorId:"demo",playerId:"demo-"+randomUUID().slice(0,6),gameId:"reference-5x3",jti:randomUUID(),iat:n,exp:n+900000};const b=Buffer.from(JSON.stringify(p)).toString("base64url");console.log(`http://localhost:9104/?gameId=reference-5x3&token=${b}.${createHmac("sha256",S).update(b).digest("base64url")}`)'
```

The services refuse to start without secrets configured — that is deliberate,
not an obstacle. See [Startup guards](#startup-guards).

---

## Architecture

```
  Designer ──► backoffice-api ──► MongoDB          Operator (casino)
               :9005  draft → simulate → publish         │ signs a launch token
                                    │                    ▼
                                    ▼         game-frontend ──JOIN{token}──┐
                            games (published)      :80                     │
                                    │                                      ▼
                                    └──────────────► game-backend ◄── game-socket
                                                       :9002    signed  :9003
                                                   money + outcomes  HMAC
```

| Service | Port | Its actual job |
|---|---|---|
| `game-backend` | 9002 | **Money and outcomes.** The system of record |
| `game-socket` | 9003 | Realtime relay; establishes player identity |
| `backoffice-api` | 9005 | Authoring, validation, the publish gate, audit |
| `game-frontend` | 9104 | The player's browser client (Canvas 2D, no deps) |
| `backoffice-frontend` | 9106 | The designer's admin UI (React) |

| Package | Why it exists |
|---|---|
| `math-engine` | **Fairness core** — evaluation, bonus modules, RTP simulation |
| `rng` | CSPRNG seeding, xoshiro256\*\*, statistical test suite |
| `ledger` | **Money.** Debit, credit, idempotency |
| `launch-token` | Player token signing and verification |
| `service-auth` | **Internal service-to-service HMAC** |
| `mongo-schemas` | Collections and — importantly — every index |
| `shared-types` | The cross-service contract |
| `logging` | One logger shape, with token redaction |

The two most correctness-critical packages, `ledger` and `launch-token`, are
also the smallest. That inversion is intentional: security-critical code is
kept small enough to audit in one sitting, while the bulk of the complexity
sits where bugs are cheap.

---

## The money path

`spinRound()` is the heart of the system, and its order is load-bearing:

```
1. validate  totalBet ∈ gameDef.betOptions      ← before any money moves
2. ensurePlayer
3. idempotency  clientRequestId seen? → replay the stored round
4. ┌── one transaction ──────────────────────────────────┐
   │  debit(totalBet)        txId = `${roundId}:debit`   │
   │  seed = randomBytes(32)                             │
   │  evaluateSpin(gameDef, seed, totalBet)   ← pure     │
   │  if totalWin > 0: credit  txId = `${roundId}:credit`│
   │  insert round {seed, rngAlgorithm, matrix, result}  │
   └─────────────────────────────────────────────────────┘
              ↑ all-or-nothing: a crash rolls back cleanly
```

Three properties worth internalising:

- **The debit precedes evaluation.** There is no state in which a spin
  happened but wasn't paid for.
- **The RNG is inside the transaction but pure.** `evaluateSpin` does no I/O,
  which is what makes the transaction safe to retry and the round replayable.
- **The outcome exists before the reels move.** Animation is presentation, not
  decision — which is exactly why a client is free to make the reveal as
  dramatic as it likes without touching fairness.

### Exactly-once, the house idiom

Every guarantee in this system is **"insert and let a unique index arbitrate
the race"**, never a read-then-write:

| Guarantee | Enforced by |
|---|---|
| A retried spin doesn't charge twice | `operator_player_clientRequest_idempotency` |
| A ledger op applies once | `operator_transaction_idempotency` |
| A launch token is single-use | `jti_unique` |
| One bonus session per triggering round | `bonusSessions.roundId` unique |

An application-level check alone cannot survive two concurrent callers. The
in-flight check handles the common case; the index makes a lost race
impossible.

---

## Fairness and audit

Every round stores its **seed** and the **algorithm** that consumed it, so any
historical round can be re-derived exactly — including under a past algorithm
after the platform default changes.

- Seeds come from `crypto.randomBytes(32)`. The full 256 bits reach the
  generator's state; nothing is folded down.
- `packages/rng` ships a real chi-squared suite with a proper
  incomplete-gamma implementation, plus a serial-correlation test and a
  `rollInt` test that would catch modulo bias in range reduction.
- The suite retries once with an independent seed. That is statistical
  honesty, not leniency: at α=0.005 a perfect generator fails ~1% of runs by
  definition, while a genuinely broken one fails at every seed.

### What a browser never learns

`/public/games/:gameId` is the only browser-facing route, and its projection
is an **allowlist, never a blocklist** — so a field added to `GameDefinition`
tomorrow is withheld by default rather than leaking silently.

- **Withheld:** `reelStrips`, `symbolWeights` — how *often* a symbol appears.
  The actual edge.
- **Exposed:** `allowedReels` — *where* a symbol may land. A coarse fact a
  player infers by watching anyway, and the client needs it to avoid drawing
  symbols on reels they can never stop on.

---

## Two fixes vs. the reference architecture

This engine follows a reference architecture closely, with two deliberate
departures where that reference had real defects.

### 1. The internal API is authenticated

The reference left every `/internal/*` route completely unauthenticated,
relying on network isolation alone: `/internal/rounds/spin` accepted
`operatorId` and `playerId` as plain body fields with no ownership check, so
**anything able to reach the money port could spin as any player**.

Here every internal call is HMAC-signed over `timestamp.METHOD.path.body`.
Signing the path matters as much as the body — otherwise a captured signature
for one route replays against another. The service refuses to boot without a
secret rather than defaulting to open.

### 2. The bonus credit is atomic

The reference read a session's status, ran the module, then wrote back. Two
concurrent steps could both observe `active`, both evaluate, and both credit.
Ledger idempotency kept the *amount* right, but the two runs used independent
randomness and could compute **different wins** — so the recorded win could
disagree with what was actually paid, reconciling to nothing.

Two changes close it:

- **The step is claimed atomically** — a `findOneAndUpdate` matching on the
  current `stepIndex` and advancing it in the same operation, so exactly one
  caller can win. The loser is told, not silently allowed to double-evaluate.
- **Module randomness is derived from `(sessionSeed, stepIndex)`**, so a step
  is deterministic and a retry computes the identical result.

The pick module also decides its **entire tile layout at `start`**, never per
reveal. Rolling a prize at reveal time makes the outcome depend on the timing
of client actions; deciding up front makes every later step a pure lookup.

---

## Startup guards

The pattern used throughout: turn a configuration promise into a code
guarantee. "We'll set the secret in production" is a promise; a process that
will not start without one is a guarantee. The failure mode of the promise is
a service that looks perfectly healthy while being wide open.

`game-backend` refuses to start if `MONGO_URI`, `SERVICE_AUTH_SECRET` or
`LAUNCH_TOKEN_SECRET` are missing or too short — and in production, if the two
secrets match or `INITIAL_PLAYER_BALANCE` would hand out free money.

---

## Testing

```bash
npm test
```

287 unit tests covering payout correctness, money invariants, the concurrency
fixes, token verification, the identity boundary, the disclosure boundary,
draft validation, the RTP gate, role guards, user management, the spin-timing
maths and payline-grid editing. `npm test` runs a full typecheck first —
`tsx` strips types without checking them, so the suite alone once gave a clean
pass on a real type error. They use an in-memory database
stand-in that models the two behaviours correctness depends on — unique
indexes that throw `11000`, and atomic `findOneAndUpdate`.

### The identity boundary

`game-socket` decides *who a player is*, so its 29 tests are worth calling
out separately. The decision logic lives in `session.ts`, deliberately split
from the server in `index.ts` and written against a two-line `Connection`
interface rather than a `WebSocket` — the code protecting every service
behind it should be testable without standing up the thing it protects.

They stub game-backend at the `fetch` boundary rather than mocking the client
module, so request signing and the mapping of a backend error onto a typed
one still execute. Mocking the module would skip precisely the layer most
likely to be wrong.

The property they exist to defend: **a client can name a bet, never a
player.** One test sends a hostile `SPIN_REQUEST` carrying its own
`operatorId` and `playerId` alongside the bet, and asserts the values that
reach the money path come from the verified token instead.

Each test was checked by breaking the code on purpose and confirming it
failed: trusting a client-supplied `playerId` fails 1, skipping the
single-use token consume fails 2, and serving messages without a prior
`JOIN` fails 3. A test that has never been seen to fail is a guess about
coverage.

```bash
npm run e2e:spin
```

```bash
npm run e2e:backoffice
```

```bash
npm run e2e:load
```

The honest tests. Unit tests cannot prove transactions roll back, that indexes
are really declared, or that two services agree about what a published game
is. These drive real services end to end.

Both run in CI on every push and pull request, along with the build and
typecheck — a suite that is never consulted before code ships is
documentation, not a safety net.

A `pre-push` hook in `.githooks/` runs the fast half of that gate — build,
typecheck and the 244 unit tests, about 23 seconds — before anything leaves
the machine. It deliberately does **not** run the Docker end-to-end suites:
those take around three minutes, and a hook slow enough to be resented is a
hook that gets bypassed. CI owns the slow checks, and CI is not in a hurry.

`npm install` points git at the directory, so a fresh clone is covered
without anyone remembering. `git push --no-verify` skips it, which is
intentional: a guard you cannot skip when you genuinely need to is one
people disable permanently instead.

The gate earned its place immediately by failing three times, on defects
that every local run had reported as green:

- **The workspace build ran alphabetically**, so `apps/` compiled before the
  `packages/` they import through `dist/*.d.ts` — 87 type errors on a clean
  checkout. Stale `dist/` output hid it locally: the build failed once and
  passed on a retry. Build order is now explicit.
- **`frontend.Dockerfile` built its app without its packages**, which only
  shows in an image with no `dist/` already present.
- **Test discovery was a glob**, and this is the one worth remembering. It
  took three attempts to fix because the variable kept moving:
  `packages/*/src/**/*.test.ts` matched all 15 test files under zsh and 2
  under dash — npm runs scripts under `sh`, so coverage depended on the
  machine. `packages/**/*.test.ts` silently ran 78 of 244. And no pattern at
  all works on the Node 20 this project pins, because Node's runner only
  learned to expand globs in 22 — which is why the first two "verified"
  fixes still failed: they were tested on Node 24.

  Discovery now happens in `scripts/run-tests.mjs`, which walks the tree and
  hands tsx an explicit file list, removing both the shell and the Node
  version from the question. Verified on Node 20 and 24, under sh, bash,
  dash and zsh.

The pattern across all three: none was a logic error, and none was
detectable from a machine where the previous build's output was still lying
around and a newer Node was installed. The last is the sharpest — a
shell-dependent glob doesn't fail, it reports success for a fraction of the
suite.

### The load check, and the index bug it found

`npm run e2e:load` drives genuinely parallel spins at one player and then
reconciles the ledger against the balance independently. It exists because
the unit tests model these races against an in-memory stand-in — a model of
Mongo, not Mongo, which cannot show whether an index is actually declared
the way it was meant to be.

On its first run, **119 of 120 concurrent spins failed with a 500.** The
idempotency index was declared `sparse`, and on a *compound* index sparse
only skips a document when every indexed field is missing. `operatorId` and
`playerId` are always present, so the index covered every round and treated
an absent `clientRequestId` as null — making a player's second ordinary
spin a duplicate-key collision with their first.

It needed real Mongo to see. The stand-in implemented the index that was
intended rather than the one the database builds, so all 244 unit tests
passed against the bug. The fix is `partialFilterExpression`, which
actually expresses "index only the rounds that carry a clientRequestId",
plus index-conflict handling in `applySchemas` so a corrected index
rebuilds instead of refusing to boot on an existing database.

Removing the index afterwards, to confirm the check would catch it,
produced the underlying failure directly: **twelve concurrent retries of
one `clientRequestId` wrote twelve separate rounds and twelve separate
charges.** The application-level check does not survive a real race; the
unique index is the guarantee.

What the check does not do is prove the absence of a race. It is written to
make a real bug likely to surface under contention, and it says so when it
passes.

Its bonus section races the **multi-step `pick` module**, which needs a game
the reference cannot provide — `reference-5x3` carries `wheel`, which
resolves entirely at `start`, so there is no second step to race.
`pick-bonus-5x3` exists for this: a fixture with a 100% trigger rate and a
nine-tile, one-blank round, seeded only when `SEED_TEST_FIXTURES=true` and
refused outright in production, because a permanently-triggering bonus is
exactly the sort of thing that escapes into a real environment.

That section also corrected an assumption worth recording. The obvious
assertion — *exactly one concurrent step returns 200* — is wrong. Several
callers can read the same `stepIndex` before any of them writes, so more
than one claim can legitimately succeed against different indexes; the
extras are then refused by the module, because the tile is already
revealed. The claim and the module's own state check are two layers of one
guard. What must never happen is the tile being **evaluated twice**, so
that is what the check asserts. Removing the atomic claim takes accepted
steps from 2 to 10 and the check fails — while the recorded win stays
correct, because the pick module decides its layout at `start`. Belt and
braces, both observed doing their job.

A running list of what is still open is in [docs/TODO.md](docs/TODO.md).

---

## Rate limiting

Three surfaces, three policies, because a single uniform limit would be
worse than none.

| Surface | Key | Default |
|---|---|---|
| `game-backend` `/internal/*` | the **calling service** | 600/min |
| `game-backend` `/public/*` | client IP | 600/min |
| `game-backend` `/health*` | — | exempt |
| `backoffice-api` (global) | client IP | 300/min |
| `backoffice-api` `/v1/auth/login` | client IP | **10 / 5 min** |
| `backoffice-api` `/v1/auth/login` | **the account** | **10 failures → 15 min lock** |
| `game-socket` spins | per connection | 5/s, burst 10 |
| `game-socket` all messages | per connection | 25/s, burst 50 |

**The internal API is keyed by caller, not IP.** Every internal request
arrives from `game-socket`, so an IP-keyed limit there would not throttle
an abuser — it would throttle the entire platform the moment traffic was
healthy, converting a defence into an outage.

**Login is separate from the global limit**, because 300 password guesses a
minute is a working credential-stuffing rate rather than a defence.

**Login is limited twice, by IP and by account, because neither alone is
enough.** The per-IP ceiling stops one address guessing quickly and does
nothing about an attacker spreading attempts across many addresses — ten
guesses from each of a thousand hosts is ten thousand guesses at one
password, and every one of them looks like a first attempt to a limiter
keyed by IP. The per-account counter is keyed to the thing being attacked
instead, so distributing the source buys nothing.

It has to live *after* body parsing, in the handler, for the reason the
next section describes: at the limiter layer the email is not available
yet. Three details are load-bearing:

- **The counter is keyed by the attempted email, not by a user id**, so a
  failed attempt against an address that does not exist is counted too.
  Tracking only real accounts would make the two observably different and
  reopen the enumeration oracle that the identical error body and the
  dummy-hash timing exist to close.
- **The lock is checked before the password is verified**, so a locked
  account costs one indexed lookup instead of a scrypt hash — a flood
  against a locked account must not become a way to burn CPU.
- **A lockout is a timestamp, not a flag.** A latching "locked" boolean
  needs something to unlatch it, and that becomes a second failure mode;
  an expiry recovers with nothing running.

Only a successful login clears the counter. The obvious cost is that anyone
who knows an administrator's address can hold it locked on purpose — a real
trade, taken deliberately and recorded in `docs/TODO.md`.

**Health is exempt**, because a limiter able to fail a readiness probe will
eventually take a service out of rotation for being busy.

**The socket uses token buckets, not fixed windows.** A fixed window lets a
client spend a full allowance at the end of one window and again at the
start of the next — a burst of double the intended rate at exactly the
moment the limiter claims to be holding the line.

## Which origins may connect

Every browser-reachable surface names its origins explicitly, and none of
them accepts `*`.

| Surface | Setting | Applies to |
|---|---|---|
| `game-backend` `/public/*` | `GAME_CORS_ORIGINS` | CORS, that one route only |
| `backoffice-api` | `BACKOFFICE_CORS_ORIGINS` | CORS, global |
| `game-socket` handshake | `SOCKET_ALLOWED_ORIGINS` | WebSocket `verifyClient` |

The socket was the odd one out: a `WebSocketServer` with no `verifyClient`
accepts a handshake from a page on any domain, so the service that owns the
identity boundary was the one taking the most permissive position. It now
refuses a disallowed origin with a `403` at the handshake — before a
connection object, a rate limiter or a session-map entry exists.

**This is defence in depth, not authentication.** Connecting has never
proved anything; identity comes from a signed launch token at `JOIN`. What
the check buys is that a page on another domain cannot open a socket inside
a logged-in player's browser and sit there attempting messages.

**A missing `Origin` header is allowed, deliberately.** Only browsers send
one, and a page cannot forge it — which is precisely what makes the check
worth anything. Server-side clients (the e2e scripts, the load check, any
`ws` caller) send none at all. Refusing them would break every legitimate
non-browser client while stopping no attacker, since anything that can omit
the header can equally set it to an allowed value. An origin check
constrains browsers, the only clients that cannot lie about it; treating a
blank `Origin` as hostile would be the appearance of a stricter rule with
none of the effect.

**Comparison is exact, on scheme, host and port.** Suffix matching is the
usual shortcut and the usual hole — `endsWith("example.com")` also accepts
`notexample.com`, which an attacker can register in an afternoon. The host
is lowercased because RFC 6454 says it is case-insensitive, but the value
is parsed and rebuilt rather than string-mangled, so `null` (what a
sandboxed or `file://` document sends) and anything unparseable are refused
rather than compared.

**Production refuses to boot without an allowlist**, in the same spirit as
the other startup guards, and `*` is rejected outright rather than honoured
— a socket has no preflight, so `*` is not a relaxed policy but the absence
of one, and it should be spelled that way by leaving the variable unset
outside production.

Verified against a running server rather than only in unit tests: an
allowed origin connects, `https://evil.example` and the lookalike
`http://localhost:9104.evil.test` are both refused `403`, a wrong port on
an allowed host is refused, an uppercase host is accepted, and a client
sending no `Origin` connects.

### Three things measurement corrected

Each of these looked right and was wrong, and none would have failed
loudly:

- **Keying login by IP *and* the attempted email.** Strictly better on
  paper — it would stop one address walking a list of accounts. But the
  limiter runs at `onRequest`, before the body is parsed, so
  `request.body` is undefined inside `keyGenerator` and every attempt
  lands in one shared bucket. A *different* email was refused too, turning
  the protection into a way for one attacker to lock out every
  administrator.
- **Keying internal traffic by `request.serviceCaller`.** Same cause: that
  field is set by a `preHandler`, so it is always unset when the limiter
  runs, and every internal call would have silently fallen back to the
  IP key. The signed `x-service-caller` header is read directly instead.
- **`void app.register(rateLimit, …)` in a synchronous `buildApp`.** The
  limiter installs an `onRoute` hook, so routes registered before it
  finishes are left unlimited. Neither the global nor the per-route limit
  applied at all, while every request still returned 200 — nothing failed,
  the protection simply was not there. `buildApp` is now async.

A fourth was found by looking at the running app rather than the code: the
limiter's 429 was being flattened to `internal_error` by a global error
handler that forced every error to 500, so a limited client was told
nothing and had no reason to back off.

**Making the overdraw section deterministic took three attempts**, and the
dead ends are instructive because each looks reasonable. Firing a large
batch and expecting refusals depends on the RNG: one run drained in 38
spins, another finished 105 spins richer than it started. Grinding the
balance down first fails the same way, just later — the drain is a random
walk at ~95% return, and while it usually reaches zero in 24–192 spins, CI
hit its cap at a balance of 525000. Betting more than the balance does not
work either, because bet validation runs before the funds check, so the
request is refused as `invalid_bet_amount` without ever reaching the money
path.

So the drain is bounded and its outcome is *reported*. If the player went
broke, the race is asserted in full; if the walk went the other way, the
section prints that it skipped. A check that could not run is not a check
that passed — and the distinction is the whole reason to trust the ones
that did.

**A note on the gap between them.** Every bug found late in this project was
found by the end-to-end runs, never the unit tests:

- A first-time player was told their balance was `0`, then watched their first
  spin debit from a funded balance. Every unit test seeded a player first, so
  the fixture that set up the happy state hid the bug that only existed before
  that state was reached.
- `POST /v1/auth/logout` returned `200` while silently doing nothing: Fastify
  rejects an empty body with a JSON content-type *before* the handler runs, so
  the token stayed valid. The unit tests passed a body every time.
- The browser could not load a game at all — `/public/games/:id` is
  browser-facing by design but had no CORS, because the earlier slice had no
  browser in it.
- The `loginAttempts` validator specified `bsonType: ["long", "int"]` — the
  types a counter and a millisecond timestamp conceptually *are*. Every
  JavaScript number serialises to BSON `double`, so Mongo rejected every
  write and each failed login returned 500. All 333 unit tests passed while
  the running service was broken, because the in-memory stand-in has no
  validator: it models the schema we intended rather than the one Mongo
  enforces. The same blind spot as the index bug above, found the same way.

Each now has a regression test. The pattern is worth internalising: a unit
test verifies the thing you thought to check, and an integration test finds
the thing you didn't.

---

## Authoring a game

No code, no release. The backoffice UI at `http://localhost:9106` is where a
designer works: six tabs — **Settings, Symbols, Reels, Paylines, Maths &
publish, History** — with autosave, live validation and the publish gate.

Three deliberate choices in that UI:

**Paylines are drawn, not typed.** A designer thinks about a payline as a
*shape* across the reels, so each line is a miniature of the real grid that
you click cells on. `[1,2,1,0,1]` is the same data and far harder to read — a
zigzag is obvious as a picture and invisible as an array.

**The reels tab shows live symbol frequency.** Reel strips *are* the game's
maths — a symbol's frequency on the strip is its real probability — but that
relationship is invisible in a flat list. Seeing `wild 2.5%` on reels 2–4 and
absent from the outer two is seeing the main RTP lever directly.

**"Publish anyway" only appears after a refusal.** An override that is always
visible is one people reach for by habit. It is offered only once the gate has
actually blocked something, with a note that it is recorded as a deliberate
override.

The **Users** tab (administrators only) creates accounts, changes roles,
deactivates and resets passwords. Every one of those signs the affected user
out everywhere immediately — see the architecture notes on why that is part of
the update rather than a separate step — and the two changes that would lock
everyone out are refused: removing the last administrator, and deactivating
yourself.

The same operations are available over HTTP:

```
POST /v1/auth/login                    → session token (8h, revocable)
GET  /v1/users                         → manage who can sign in (admin only)
POST /v1/games                         → a valid starter draft
PUT  /v1/games/:id                     → edit; saves even when invalid, reports why
POST /v1/games/:id/simulate            → fast RTP preview while tuning
POST /v1/games/:id/publish             → validate → simulate → gate → version → live
GET  /v1/games/:id/versions            → every published version, append-only
GET  /v1/audit?entityId=:id            → who changed what, when
```

Three properties are worth stating plainly.

**Editing a draft never changes what players see.** A draft has no `version`
and no `status`, because those are facts about a *publish*, not an edit — so
it is structurally impossible to edit a version number. Half-finished work can
sit for a week without anyone playing it.

**An invalid draft still saves.** Validity is a publish-time gate, not a
save-time one; a designer must be able to leave something half-done. The
errors come back on every save so the UI can show them live.

**A mistuned game cannot be published.** `rtpTarget` is an intention and the
simulation is a measurement; the two disagreeing by more than 5% means the
paytable does not do what its author believes, and the publish is **refused
with a 422** rather than warned about. A warning is something people click
past at 6pm on a Friday. An override exists, and it is recorded in the audit
log as having been forced.

The bundled `reference-5x3` measures **0.95–0.96** against a 0.95 target.

## Playing a game

The client is deliberately dependency-free: a Canvas 2D renderer in ~350
lines, a 13.6 kB bundle (5.4 kB gzipped). A slot client's rendering needs are
narrow and well understood — a scrolling strip, a settle, a highlight — and
expressing them directly keeps the entire visual layer inspectable in one
file. Nothing outside the renderer knows a canvas exists, so swapping it for
PixiJS later touches one module.

A player arrives with a signed launch token in the URL, exactly as a real
casino would send them:

```
http://localhost:9104/?gameId=reference-5x3&token=<signed-launch-token>
```

The spin timing lives in `render/reelStrip.ts`, apart from anything that
draws, because it is the one part that can be wrong in a way a screenshot
won't reveal: an easing curve that never quite reaches its target, a reel that
settles before the one to its left, motion blur left on a stopped reel. All
pure functions of elapsed time, so a dropped frame recomputes rather than
drifts — and all directly testable.

What *isn't* config: a genuinely new mechanic (cascades, respins,
hold-and-spin) or a new kind of bonus round. Those are real engineering. The
line between "recipe change" and "new mechanic" is the most useful thing to
know before planning a feature.

---

## Money is always integer minor units

`100` means 1.00, never 1. Floats compound rounding error across millions of
transactions, and a fractional `$inc` corrupts a balance silently with no
error raised anywhere. `InvalidAmountError` rejects a non-integer before any
write happens.
