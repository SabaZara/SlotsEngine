# Slots Engine

A config-driven, multi-game slot platform. **A game is data, not code**: one
generic evaluator plays any game described by a `GameDefinition` document, so
shipping a new game means publishing a document, not deploying a service.

A designer authors and publishes a game in the backoffice; a player launches
it, spins, wins, triggers a bonus and reconnects — end to end, with every
movement of money audited and replayable.

---

## Contents

- [Quick start](#quick-start) — get it running
- [Architecture](#architecture) — services, packages, and why the split is here
  (in depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md))
- [Module decisions](#module-decisions) — the one call that shapes each module
- [The money path](#the-money-path) — spin ordering and exactly-once
- [Fairness and audit](#fairness-and-audit) — replayability, and what a browser never learns
- [Security boundaries](#security-boundaries) — auth, origins, rate limits, startup guards
- [Authoring a game](#authoring-a-game) — the designer's workflow and the publish gate
- [Playing a game](#playing-a-game) — the player client
- [Testing](#testing) — the verification standard this repo holds to
- [Configuration](#configuration) — environment variables
- [Deployment](#deployment) — CI, images, rollback

---

## Quick start

Requires Docker and Node 20 (`.nvmrc`).

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

| Where | URL |
|---|---|
| **Backoffice UI** | `http://localhost:9106` — sign in as `admin@example.com` / `admin` |
| Play a game | `http://localhost:9104/?gameId=reference-5x3&token=…` |
| Backoffice API | `http://localhost:9105` |
| Game backend | `http://localhost:9102` |

**Two games are seeded on first boot.** `reference-5x3` carries a
single-step `wheel` bonus; `free-spins-5x3` awards **ten free spins at ×2**,
played on its own reels and retriggerable up to three times. Both are tuned
to a 0.95 RTP and measured by simulation rather than by eye.

### Launching a player

A player needs a signed launch token. **A real operator mints one by calling
`POST /v1/launch`** — see [docs/INTEGRATION.md](docs/INTEGRATION.md), and
`apps/operator-demo` for a working integrator you can click through:

```bash
docker compose -f infra/docker-compose.yml --profile demo up -d operator-demo
```

That needs an operator to sign as. Create one in the backoffice under
**Operators**, copy the secret it shows you once, and put it in `infra/.env`
as `DEMO_OPERATOR_API_KEY_ID` / `DEMO_OPERATOR_API_SECRET`. Then open
`http://localhost:9108`.

To skip all that and mint a token directly, locally:

```bash
node -e 'const{createHmac,randomUUID}=require("crypto");const S=process.env.LAUNCH_TOKEN_SECRET;const n=Date.now();const p={kind:"launch",operatorId:"demo",playerId:"demo-"+randomUUID().slice(0,6),gameId:"reference-5x3",jti:randomUUID(),iat:n,exp:n+900000};const b=Buffer.from(JSON.stringify(p)).toString("base64url");console.log(`http://localhost:9104/?gameId=reference-5x3&token=${b}.${createHmac("sha256",S).update(b).digest("base64url")}`)'
```

The e2e runs sign their own launch token, so they need the same secret the
stack booted with. It is **read from `infra/.env`** rather than written out
here: a secret pasted into a README is a secret every reader shares, and it
survives any rotation of the file it was copied from.

```bash
export LAUNCH_TOKEN_SECRET=$(grep -E "^LAUNCH_TOKEN_SECRET=" infra/.env | cut -d= -f2-)
GAME_BACKEND_URL=http://localhost:9102 GAME_SOCKET_URL=ws://localhost:9103 npm run e2e:spin
```

(Grepping the one line rather than `source`-ing the file is deliberate —
`MONGO_URI` contains an unquoted `&`, which a shell would treat as a job
control operator.)

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
| `integration-api` | 9006 | **The operator boundary.** Signed wallet, launch, catalogue and player-limit calls |
| `operator-demo` | 9008 | A reference integrator — the worked example of `docs/INTEGRATION.md` |
| `game-frontend` | 9104 | The player's browser client (PixiJS, WebGL/WebGPU) |
| `backoffice-frontend` | 9106 | The designer's admin UI (React) |

| Package | Why it exists |
|---|---|
| `math-engine` | **Fairness core** — evaluation, bonus modules, RTP simulation |
| `rng` | CSPRNG seeding, xoshiro256\*\*, statistical test suite |
| `ledger` | **Money.** Debit, credit, idempotency |
| `launch-token` | Player token signing and verification |
| `player-limits` | **Player protection** — stake and loss ceilings per period |
| `secrets` | **At-rest encryption** for credentials that must be recoverable |
| `service-auth` | **Internal service-to-service HMAC** |
| `asset-storage` | S3-compatible object storage for game artwork |
| `mongo-schemas` | Collections and — importantly — every index |
| `shared-types` | The cross-service contract |
| `logging` | One logger shape, with token redaction |

### Why the services split where they do

**Money is one service.** `game-backend` is the only process that writes to
the ledger, so "did this player get charged twice" has exactly one place to
look. Splitting the wallet from the outcome would put a network boundary
inside the transaction that makes a spin atomic.

**Identity is separate from money.** `game-socket` decides *who a player
is*; `game-backend` decides *what happens*. A client can name a bet, never a
player — the socket resolves identity from a signed token and the backend
never accepts a `playerId` from a browser.

**The operator boundary is its own surface.** `integration-api` is the only
service a casino's systems talk to, so the rules that apply to an external
partner — signed requests, no player enumeration, a stable contract — are
enforced in one place rather than spread across the money path.

**The two most correctness-critical packages, `ledger` and `launch-token`,
are also the smallest.** That inversion is intentional: security-critical
code is kept small enough to audit in one sitting, while the bulk of the
complexity sits where bugs are cheap.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the longer version: the same
structure, with the reasoning behind each boundary worked through in full.

---

## Module decisions

The one decision per module that a reader would otherwise have to infer from
the code. Each is a fork where the obvious alternative was rejected for a
reason.

### `math-engine` — a game is a document

Evaluation is a pure function of `(gameDef, seed, totalBet)`. No I/O, no
clock, no database. That is what makes a round replayable from its stored
seed and what makes the whole thing safe to retry inside a transaction.

**Payline wins sum across matching lines** rather than paying only
full-length matches. This differs from the reference architecture and is the
single most important thing to know before porting maths between the two.

Bonus rounds are **modules behind a registry** (`wheel`, `pick`,
`freeSpins`), so adding one is a registration rather than a change to the
evaluator. The backoffice reads that same registry over
`GET /v1/bonus-modules` — a second hardcoded list in the UI is how a module
becomes unreachable through the only screen that configures it.

### `rng` — seeded, not streamed

`crypto.randomBytes(32)` seeds a xoshiro256\*\* generator per round, and the
full 256 bits reach the state; nothing is folded down. A CSPRNG per draw
would be defensible but not replayable — the seed is what lets a support
agent re-derive a disputed spin years later.

The statistical suite retries once with an independent seed. At α=0.005 a
perfect generator fails ~1% of runs by definition, while a broken one fails
at every seed.

### `ledger` — insert and let the index arbitrate

Every guarantee is **"insert and let a unique index decide the race"**, never
read-then-write. An application-level check cannot survive two concurrent
callers; the in-flight check handles the common case and the index makes a
lost race impossible.

Money is **always integer minor units** — `100` means 1.00. Floats compound
rounding error across millions of transactions, and a fractional `$inc`
corrupts a balance silently. `InvalidAmountError` rejects a non-integer
before any write happens.

### `player-limits` — the check runs inside the transaction

Stake and loss ceilings per day, week or month — the controls a licensed
operator is required to offer. The package itself is pure: given limits,
usage and a proposed bet, decide. No clock, no database, so a refusal is
reproducible from its inputs, which matters when a player disputes one.

**The enforcement is not here, and that is the design.** Checking limits
*before* the spin is the intuitive implementation and it is wrong: two
concurrent bets both read "900 of 1,000 staked", both decide 200 fits, and
both commit. The counter is therefore advanced inside the same transaction
as the debit (`game-backend/rounds/limits.ts`), where snapshot isolation
does the arbitration. Measured at 20 concurrent bets against a ceiling of
10: exactly 10 pass.

**A period is a string key** (`2026-08-18`, `2026-W34`), not a pair of
timestamps, so accumulating is an upsert-and-`$inc` needing no prior read —
and periods reset with nothing running. Weeks are ISO weeks, because the
naive form resets a weekly limit three days early at new year.

**Loss is net**: staking 100 and winning 95 back is a loss of 5. A win
genuinely re-opens headroom, which is the honest reading of a loss limit
and what regulators specify.

A refusal is **403, never 402** — "insufficient funds" means top up and try
again, while this means topping up changes nothing. A client offering a
deposit prompt against a responsible-gambling control is the worst response
the feature could produce.

### `launch-token` — hand-rolled HMAC, not a JWT library

One fewer dependency, one less format for a reviewer to learn, and the whole
verification path fits on one screen. Tokens are **single-use**, enforced by
a unique index on `jti` rather than by a lookup — the same idiom as the
ledger.

### `secrets` — encryption, deliberately not hashing

Operator API secrets must come back out in plaintext to sign with, so they
are encrypted at rest (AES-256-GCM), not hashed. Getting this backwards is a
plausible mistake in both directions: hashing a value you need to recover
loses it, and encrypting a password you only ever compare is a weaker choice
than hashing it. User passwords use scrypt.

### `service-auth` — sign the path, not just the body

Internal calls are HMAC-signed over `timestamp.METHOD.path.body`. Signing the
path matters as much as the body: otherwise a captured signature for one
route replays against another. The service refuses to boot without a secret
rather than defaulting to open.

### `asset-storage` — a private bucket, re-asserted every boot

S3-compatible (MinIO locally, real S3 in production by changing the endpoint).
**The bucket is private and stays private**: every read goes through a
short-lived signed URL minted at serve time, so a leaked asset URL stops
working within the day rather than forever.

The bucket policy is cleared on *every* boot rather than only at creation.
The reference architecture set public-read at creation, which means an
environment whose bucket already existed kept that policy indefinitely —
"create if missing" never runs again.

### `mongo-schemas` — indexes are part of the schema

Collections and their indexes are declared together and applied at boot,
because in this system an index *is* a correctness guarantee rather than a
performance tweak — idempotency, single-use tokens and one-bonus-per-round
all rest on one. `applySchemas` handles index conflicts so a corrected index
rebuilds instead of refusing to boot on an existing database.

### `logging` — redaction at the logger, not the call site

Tokens are redacted by the logger itself. A call site that must remember to
strip a secret is one that will eventually forget, and the failure is a
credential in a log file.

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

- **The debit precedes evaluation.** There is no state in which a spin
  happened but wasn't paid for.
- **The RNG is inside the transaction but pure.** `evaluateSpin` does no I/O,
  which is what makes the transaction safe to retry and the round replayable.
- **The outcome exists before the reels move.** Animation is presentation, not
  decision — which is exactly why a client is free to make the reveal as
  dramatic as it likes without touching fairness.

### Exactly-once

| Guarantee | Enforced by |
|---|---|
| A retried spin doesn't charge twice | `operator_player_clientRequest_idempotency` |
| A ledger op applies once | `operator_transaction_idempotency` |
| A launch token is single-use | `jti_unique` |
| One bonus session per triggering round | `bonusSessions.roundId` unique |

### Bonus steps are claimed, not read

A multi-step bonus claims each step with a `findOneAndUpdate` matching on the
current `stepIndex` and advancing it in the same operation, so exactly one
caller wins. Module randomness is derived from `(sessionSeed, stepIndex)`, so
a step is deterministic and a retry computes the identical result.

The alternative — read status, evaluate, write back — lets two concurrent
steps both observe `active` and both credit. Ledger idempotency would keep
the *amount* right, but the two runs use independent randomness and can
compute **different wins**, so the recorded win disagrees with what was paid.

Bonus session expiry is checked **on every read** rather than by a sweep. A
money path that takes correctness from a timer is wrong the first time a tick
is missed. The row survives expiry rather than being TTL-deleted, so a player
returning to a timed-out bonus gets `410 bonus_session_abandoned` — "that
round timed out" — instead of "no such session".

---

## Fairness and audit

Every round stores its **seed** and the **algorithm** that consumed it, so any
historical round can be re-derived exactly — including under a past algorithm
after the platform default changes.

Publishing is **append-only**: every published version is snapshotted, and the
live document is *replaced* rather than patched, so the game players read
always equals the snapshot of the version it claims to be. An audit trail that
can disagree with what was actually served is wrong about the one thing it
exists to establish.

### What a browser never learns

`/public/games/:gameId` is the only browser-facing game route, and its
projection is an **allowlist, never a blocklist** — so a field added to
`GameDefinition` tomorrow is withheld by default rather than leaking.

- **Withheld:** `reelStrips`, `symbolWeights` — how *often* a symbol appears.
  The actual edge.
- **Exposed:** `allowedReels` — *where* a symbol may land. A coarse fact a
  player infers by watching anyway, and the client needs it to avoid drawing
  symbols on reels they can never stop on.

---

## Security boundaries

### Authentication, per surface

| Surface | How a caller proves itself |
|---|---|
| `game-backend` `/internal/*` | HMAC over `timestamp.METHOD.path.body` |
| `game-backend` `/public/*` | Nothing — read-only game metadata |
| `game-socket` `JOIN` | Signed, single-use launch token |
| `backoffice-api` | Bearer session token (8h, revocable) |
| `integration-api` | Operator API key + HMAC signature |

Backoffice sessions are re-checked against the database on **every request**,
not just verified as signatures. A stateless token means a deactivated user
keeps access until it expires on its own — up to eight hours in which
revoking does nothing. One indexed lookup per request is a trivial price on
an admin surface; it would be the wrong trade on the money path, which is why
that path doesn't make it.

### Which origins may connect

Every browser-reachable surface names its origins explicitly, and none accepts
`*`.

| Surface | Setting |
|---|---|
| `game-backend` `/public/*` | `GAME_CORS_ORIGINS` |
| `backoffice-api` | `BACKOFFICE_CORS_ORIGINS` |
| `game-socket` handshake | `SOCKET_ALLOWED_ORIGINS` |

**Comparison is exact, on scheme, host and port.** Suffix matching is the
usual shortcut and the usual hole — `endsWith("example.com")` also accepts
`notexample.com`. The value is parsed and rebuilt rather than string-mangled,
so `null` and anything unparseable are refused rather than compared.

**A missing `Origin` header is allowed, deliberately.** Only browsers send
one, and a page cannot forge it — which is what makes the check worth
anything. Server-side clients send none. Refusing them would break every
legitimate non-browser client while stopping no attacker, since anything that
can omit the header can equally set it to an allowed value.

**This is defence in depth, not authentication.** Connecting has never proved
anything; identity comes from the launch token at `JOIN`.

The backoffice API also sets `Access-Control-Expose-Headers`, because the UI
is served from a different origin than the API — a response header a browser
cannot read is a signal that silently never fires.

### Rate limiting

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
arrives from `game-socket`, so an IP-keyed limit there would throttle the
entire platform the moment traffic was healthy — converting a defence into an
outage.

**Login is limited twice, by IP and by account, because neither alone is
enough.** A per-IP ceiling does nothing against an attacker spreading
attempts across many addresses; every one of ten thousand guesses looks like
a first attempt. The per-account counter is keyed to the thing being attacked.

Three details there are load-bearing: the counter is keyed by the *attempted
email* rather than a user id (so attempts against non-existent accounts count
too, closing an enumeration oracle); the lock is checked *before* the password
is verified (so a flood against a locked account cannot burn scrypt CPU); and
a lockout is a *timestamp, not a flag* (a latching boolean needs something to
unlatch it, which is a second failure mode).

**Health is exempt**, because a limiter able to fail a readiness probe will
eventually take a service out of rotation for being busy.

**The socket uses token buckets, not fixed windows.** A fixed window lets a
client spend a full allowance at the end of one window and again at the start
of the next — double the intended rate at exactly the moment the limiter
claims to be holding the line.

### Startup guards

The pattern throughout: turn a configuration promise into a code guarantee.
"We'll set the secret in production" is a promise; a process that will not
start without one is a guarantee. The failure mode of the promise is a
service that looks perfectly healthy while being wide open.

`game-backend` refuses to start if `MONGO_URI`, `SERVICE_AUTH_SECRET` or
`LAUNCH_TOKEN_SECRET` are missing or too short — and in production, if the two
secrets match or `INITIAL_PLAYER_BALANCE` would hand out free money.

**What the guards do not catch:** they check length and difference, not
whether a value is *publicly known*. The placeholders in `.env.example` are 53
characters and differ from each other, so they **pass every check** — a stack
copied from the template boots happily on a secret published in this
repository. Generate real values with `openssl rand -hex 32` before anything
is reachable from outside your machine.

---

## Authoring a game

No code, no release. The backoffice UI at `http://localhost:9106` is where a
designer works: eight tabs — **Settings, Symbols, Reels, Paylines, Artwork,
Theme, Maths & publish, History** — with autosave, live validation and the
publish gate.

Three deliberate choices in that UI:

**Paylines are drawn, not typed.** A designer thinks about a payline as a
*shape* across the reels, so each line is a miniature of the real grid you
click cells on. `[1,2,1,0,1]` is the same data and far harder to read.

**The reels tab shows live symbol frequency.** Reel strips *are* the game's
maths — a symbol's frequency on the strip is its real probability — but that
relationship is invisible in a flat list.

**"Publish anyway" only appears after a refusal.** An override that is always
visible is one people reach for by habit. It is offered only once the gate has
actually blocked something, and it is recorded as a deliberate override.

**Artwork** uploads symbol and background images to object storage, and
**Theme** sets a game's colours — both so that giving a game its own look is
a designer's job rather than a deploy. Clearing an uploaded image is a real
operation, not just an empty field: an absent key in a draft save means
"leave unchanged", so a removal is sent as an explicit `null` and unset
server-side.

The **Users** tab (administrators only) creates accounts, changes roles,
deactivates and resets passwords. Every one of those signs the affected user
out everywhere immediately, and the two changes that would lock everyone out
are refused: removing the last administrator, and deactivating yourself.

**Reports** and **Support** read the money: every ledger movement by operator
and date with CSV export, and a read-only per-player lookup showing balance,
recent transactions and recent rounds. Support is deliberately read-only —
correcting a balance is a ledger movement and belongs on the money path with
an idempotency key and an audit trail, not on a support screen.

The same operations are available over HTTP:

```
POST /v1/auth/login                    → session token (8h, revocable)
GET  /v1/users                         → manage who can sign in (admin only)
POST /v1/games                         → a valid starter draft
PUT  /v1/games/:id                     → edit; saves even when invalid, reports why
POST /v1/games/:id/simulate            → fast RTP preview while tuning
POST /v1/games/:id/publish             → validate → simulate → gate → version → live
GET  /v1/games/:id/versions            → every published version, append-only
GET  /v1/reports/transactions          → ledger movements; ?format=csv to export
GET  /v1/reports/summary               → staked, paid out, net for a range
GET  /v1/support/players/:op/:player   → balance, money, rounds and play limits
GET  /v1/audit?entityId=:id            → who changed what, when
```

Three properties are worth stating plainly.

**Editing a draft never changes what players see.** A draft has no `version`
and no `status`, because those are facts about a *publish*, not an edit — so
it is structurally impossible to edit a version number.

**An invalid draft still saves.** Validity is a publish-time gate, not a
save-time one; a designer must be able to leave something half-done. The
errors come back on every save so the UI can show them live.

**A mistuned game cannot be published.** `rtpTarget` is an intention and the
simulation is a measurement; the two disagreeing by more than 5% means the
paytable does not do what its author believes, and the publish is **refused
with a 422** rather than warned about. A warning is something people click
past at 6pm on a Friday.

The bundled `reference-5x3` measures **0.95–0.96** against a 0.95 target.

**What isn't config:** a genuinely new mechanic (cascades, respins,
hold-and-spin) or a new kind of bonus round. Those are real engineering. The
line between "recipe change" and "new mechanic" is the most useful thing to
know before planning a feature.

---

## Playing a game

The client renders with **PixiJS** (`render/pixiRenderer.ts`), which picks
WebGPU or WebGL at runtime and falls back to Canvas. Built output is ~601 kB
across code-split chunks, ~182 kB gzipped — the renderer's backends load
separately from the app, so a browser pulls one of them rather than all
three.

**The drawing library is confined to one module.** Nothing outside
`pixiRenderer.ts` imports Pixi, and everything that decides *what* to draw —
spin timing, symbol styling, wheel geometry, win presentation — is a pure
module beside it with no renderer import at all. That is what makes the
timing testable without a GPU, and it is why replacing the renderer is a
one-file change rather than a rewrite.

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

---

## Testing

```bash
npm test
```

**1,762 unit and integration tests, plus 133 component tests.** `npm test`
runs a full typecheck first — `tsx` strips types without checking them, so the
suite alone once gave a clean pass on a real type error.

Suites that touch schemas, indexes or ordering run against **real MongoDB**
and skip cleanly when it is unreachable, so a laptop without Docker still
passes. Point them at a running stack with:

```bash
MONGO_TEST_URI="mongodb://localhost:27018/?directConnection=true" npm test
```

The end-to-end runs drive real services:

```bash
npm run e2e:spin        # a full spin through socket → backend → ledger
npm run e2e:backoffice  # authoring and publishing
npm run e2e:operator    # the integration boundary
npm run e2e:load        # concurrent spins, reconciled against the ledger
```

### The verification standard

The bar here is higher than "tests pass", because several real bugs in this
repo passed a green suite. In order of how much they establish:

1. **Mutation-verify.** Break the code deliberately and confirm the test
   fails. A test never observed failing has established nothing.
2. **Run it against the real stack.** The in-memory `fakeMongo` models no
   schema validator and no rollback, and has hidden real bugs twice. A
   money-path or schema change is not verified until it has run against live
   services.
3. **Say what a test cannot establish.** Every suite with a known blind spot
   states it in its file header.
4. **Clone what you pushed.** The three checks above all run against the
   *working tree*, so none can see a file missing from the *repository*.

A `pre-push` hook runs build, typecheck and the unit suite (~23s) before
anything leaves the machine. It deliberately does **not** run the Docker
suites: a hook slow enough to be resented is a hook that gets bypassed. CI
owns the slow checks. `npm install` points git at the hook directory, so a
fresh clone is covered without anyone remembering; `--no-verify` skips it,
which is intentional.

**Why this standard exists.** 32 bugs have been found and fixed here, each
recorded in [docs/TODO.md](docs/TODO.md) with *how it was found* — and not one
was found by a test that already passed. Nine needed the real stack to see at
all. The recurring shape is a defect that produces a *plausible wrong answer*
rather than an error: a report missing a day, an export that reports itself
complete, an index that models what was intended rather than what Mongo
builds. Nothing on screen suggests anything is wrong, which is exactly why a
green suite is the starting point rather than the finish line.

---

## Configuration

Copy `.env.example` to `infra/.env` and edit. Every variable is documented
there; the ones that matter most:

| Variable | Why it matters |
|---|---|
| `LAUNCH_TOKEN_SECRET` | Signs player launch tokens. Must differ from the service secret |
| `SERVICE_AUTH_SECRET` | Signs internal service-to-service calls |
| `BACKOFFICE_JWT_SECRET` | Signs admin sessions |
| `SECRETS_ENCRYPTION_KEY` | Encrypts operator API secrets at rest (64 hex chars) |
| `MONGO_URI` | `directConnection=true` is a **host-side** flag — correct from your machine, wrong in-network |
| `INITIAL_PLAYER_BALANCE` | Refused in production; it hands out free money |

Generate secrets with `openssl rand -hex 32`.

## Deployment

CI runs build, typecheck, the unit suite and the Docker end-to-end suites on
every push and pull request. Images are built and pushed on a tagged release,
with a rollback workflow that redeploys a previous tag.

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full runbook, and
[docs/INTEGRATION.md](docs/INTEGRATION.md) for what an operator needs to
integrate.

---

## Working on this

[docs/TODO.md](docs/TODO.md) is the working log: what is fixed, what is open,
and the reasoning behind deliberate non-decisions. [CLAUDE.md](CLAUDE.md)
records the conventions — comments explain *why*, tests are named as claims,
money is always integer minor units.
