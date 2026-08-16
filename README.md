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

244 unit tests covering payout correctness, money invariants, the concurrency
fixes, token verification, the disclosure boundary, draft validation, the RTP
gate, role guards, user management, the spin-timing maths and payline-grid
editing. `npm test` runs a full typecheck first — `tsx` strips types without
checking them, so the suite alone once gave a clean pass on a real type error. They use an in-memory database
stand-in that models the two behaviours correctness depends on — unique
indexes that throw `11000`, and atomic `findOneAndUpdate`.

```bash
npm run e2e:spin
```

```bash
npm run e2e:backoffice
```

The honest tests. Unit tests cannot prove transactions roll back, that indexes
are really declared, or that two services agree about what a published game
is. These drive real services end to end.

Both run in CI on every push and pull request, along with the build and
typecheck — a suite that is never consulted before code ships is
documentation, not a safety net.

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
