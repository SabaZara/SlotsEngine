# Architecture

Structure and the reasoning behind it. For getting it running, see the
[README](../README.md).

---

## 1. The one idea

**A game is a recipe, not a program.**

Most slot platforms build each game as its own software. This one doesn't:
there is a single engine that knows how to play *any* slot game, and each game
is a document describing rules — grid, symbols, paytable, bonus modules.

Nearly every structural choice below follows from that one decision. It is
also the most useful thing to internalise before planning any feature, because
it defines a hard line:

- **Recipe changes are cheap.** New game, different symbols, changed payouts,
  new paylines, different grid size, tuned RTP, existing bonus configured
  differently. No code, no release.
- **New mechanics are real engineering.** Cascading symbols, respins,
  hold-and-spin, a genuinely new kind of bonus round. The engine has to learn
  the mechanic before a recipe can use it.

Most friction between design and engineering on platforms like this comes from
not knowing which side of that line a request falls on.

---

## 2. The two entry paths

Everything reaching `game-backend` arrives through exactly one of two doors.

### Path A — operator launch

```
Operator server
  │  signs a launch token (shared LAUNCH_TOKEN_SECRET)
  ▼
Browser receives a one-time, 60-second token
```

The TTL is short because the token travels in a URL, and URLs leak through
referrer headers, proxy logs and browser history. The WebSocket session is the
thing that persists — not the token.

### Path B — player socket

```
Browser ──JOIN{token}──► game-socket ── verifyLaunchToken()
                              │            signature + expiry, no I/O
                    kind="launch"?        kind="session"?
                          │                     │
          consume via game-backend              └─► reuse (reconnect)
          (insert jti → unique index)
                          │
              signSessionToken() → reusable token returned
                          │
              sessions.set(socket, {operatorId, playerId, gameId})
```

**The single most important structural fact in the system:**

```ts
await spin({
  operatorId: session.operatorId,  // ← from the verified token
  playerId:   session.playerId,    // ← from the verified token
  gameId:     session.gameId,      // ← from the verified token
  totalBet:   message.betAmount,   // ← from the client, validated downstream
});
```

Identity comes from a server-side map keyed by socket, populated only from a
cryptographically verified token. **A client can name a bet; it can never name
a player.** The one client-controlled value on the money path is `betAmount`,
validated twice — integer and positive at the route, then against the game's
own `betOptions` allowlist before any debit.

---

## 3. `game-backend`'s internal shape

Four layers, and the boundaries are respected:

```
index.ts              boot: guards → mongo → schemas → seed → routes → sweeper
  │
routes/               HTTP boundary — validate, map errors to codes, nothing else
  ├── serviceAuth.ts  HMAC guard on every /internal/* route
  ├── rounds.ts       /internal/rounds/spin · /recover · /players/balance
  ├── bonus.ts        /internal/bonus/start · /step
  ├── launchTokens.ts /internal/launch-tokens/consume
  ├── simulate.ts     /internal/simulate
  ├── public.ts       /public/games/:gameId   ← the ONLY browser-facing route
  └── health.ts
  │
rounds/ · bonus/ · launch/    domain logic — owns transactions
  ├── service.ts      spinRound() — the money path
  ├── games.ts        loadGameDefinition() + boot seeding
  ├── publicView.ts   the projection that strips RNG structure
  ├── session.ts      bonus lifecycle + abandonment sweep
  └── consume.ts      launch-token single-use
  │
@slots-engine/*       ledger · math-engine · rng · mongo-schemas · service-auth
```

Routes never touch Mongo directly; domain logic never formats HTTP responses.
Typed domain errors are translated at the boundary — `InsufficientFundsError`
→ 402, `InvalidBetAmountError` → 400, `BonusSessionAbandonedError` → 410.

That last one is worth a word: 410 rather than 404, because the session
genuinely existed and is now gone. A client needs to tell "never existed" from
"expired" to explain it to a player.

---

## 4. Config over code, kept honest

```
GameDefinition document
   → validate
   → POST /internal/simulate   (Monte Carlo → measured RTP)
   → publish → games (status: published) + gameVersions (append-only)
                    │
   game-backend: loadGameDefinition(db, gameId)   ← reads Mongo, not the fixture
```

Two deliberate details:

**The boot seed reads its fixture from `math-engine`, but round logic reads
the definition back out of Mongo.** If round logic could fall back to a
compiled-in constant, the running system would have a special path for one
game and "config over code" would quietly stop being true.

**The seed is strictly non-overwriting** (`$setOnInsert`). An unconditional
re-seed would fight `gameId_version_unique` the moment anyone published a
second version.

`gameVersions` is append-only because a round records the `gameVersion` it ran
under — so a historical round can always be reconstructed against the exact
math in force at the time.

---

## 4a. The authoring layer

```
Designer (backoffice-api :9005)
   → gameDrafts          freely edited, never playable
   → validateDraft()      synchronous, DB-free, cheap high-value guards
   → simulate             Monte Carlo → measured RTP
   → RTP gate             refuse if measured drifts >5% from rtpTarget
   → publish              version+1 → gameVersions (append-only) → games
   → auditLogs            who, when, from which version, at what RTP
```

**Why the gate refuses rather than warns.** `rtpTarget` is what an author
*believes* the game returns; the simulation is what it *does*. Those
disagreeing means the paytable does not behave as intended — the game either
loses money on every spin or is unplayable, and neither looks wrong in a
config file. A warning in an admin UI is a warning someone clicks past. The
override exists, and it is recorded in the audit log as having been forced.

**Why validation is synchronous and database-free.** Anything needing a lookup
lives in `publishDraft`. That keeps `validateDraft` a pure function over a
draft — trivially testable, and it is the single densest concentration of
correctness rules in the codebase, so making it easy to test matters more than
making it convenient.

**What it deliberately does not check.** Whether the maths is *good*. Whether
weights hit `rtpTarget` is a tuning question the simulation answers, not a
correctness question inspection can. What it does catch is the class of error
that would otherwise surface at *spin time in front of a player*: a payline
pointing at a row that no longer exists after a grid resize, a strip naming a
deleted symbol, a bonus trigger needing more symbols than the grid can hold.

Authentication is JWT with a `tokenVersion` re-checked against the database on
every request. That extra lookup is the point, not an oversight: without it a
deactivated admin keeps full access until their token expires on its own — up
to eight hours in which revoking access does nothing. It would be the wrong
trade on the player money path, which is why that path doesn't make it.

**Every user change bumps `tokenVersion`.** A role change, a deactivation and
a password reset all revoke that user's existing sessions, because a signed
token carries its own copy of the roles: without the bump, a demoted
administrator keeps administrator access until their token expires, and a
password reset leaves whoever prompted it still signed in. Revoking is
therefore part of the update rather than a step a caller may forget.

Two changes are refused outright: removing the **last active administrator**,
and **deactivating yourself**. Recovering from either needs direct database
access — precisely the situation an admin UI exists to avoid — so they are
blocked at the API rather than warned about in the UI, where a warning is one
misclick from being ignored.

---

## 5. The three invariants that make it a *money* system

### 5.1 Exactly-once, enforced twice

Every ledger op carries a `transactionId` (`${roundId}:debit`,
`${roundId}:credit`, `${bonusSessionId}:bonus-credit`). `applyLedgerOp` checks
for an existing transaction inside the session, and a **unique index** backs
it up.

Belt and braces, and both halves are needed: the check handles the ordinary
retry without raising an error, the index makes a lost race impossible.

### 5.2 Integer minor units, everywhere

No float touches money. `InvalidAmountError` rejects a non-integer *before*
any `$inc`, because a fractional increment corrupts a balance silently — no
error, no log, just a number that is slightly wrong forever.

### 5.3 Replayability

Each round persists `seed` **and** `rngAlgorithm`, and `evaluateSpin` is
deterministic given both. A dispute six months later is settled by re-running
the spin, not by trusting a log that says what we think happened.

The algorithm id (`xoshiro256ss-d16`) encodes the 16-draw warm-up, because a
sequence generated with it differs from one generated without it. Any future
change to seeding, scrambler or discard count must take a **new** id and keep
the old one readable.

---

## 6. Where the trust boundaries sit

```
  Internet
     │
     ├─► game-socket        signed token, single-use launch   ✅ strong
     │
     └─► /public/games/:id  unauthenticated, allowlisted      ✅ by design
                                    │
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│╌╌╌╌ network boundary ╌╌╌╌╌╌╌╌
                                    ▼
              game-backend  /internal/*   ✅ HMAC-signed
```

The reference architecture this follows had that last line reading **NO AUTH
AT ALL**, mitigated by network isolation only. The perimeter being well built
does not make the interior safe — it only makes the interior's weakness harder
to notice. One misconfigured network policy, one sidecar, or one SSRF and the
whole thing is open.

Network isolation is still in place here. It just isn't the only layer.

---

## 7. Bonus sessions — the one genuinely stateful flow

Everything else is request/response. Bonuses are not:

```
spin → evaluation.bonusTriggered
     → game-socket auto-starts (no client action needed)
     → bonusSessions {status: "active"}
     → client steps …
     → module reports done → status "resolved" → credit ONCE
```

Three states: `active` → `resolved` | `abandoned`.

The auto-start is server-driven because the outcome was already decided by the
spin. Requiring a client action to open the round would only add a way for the
two to disagree.

**This is the least naturally defended part of the money path**, and where the
reference implementation had its real defect — see the README's *Two fixes*
section for the race and how the atomic step-claim closes it.

The abandonment sweep runs on a 5-minute in-process interval. It is a
conditional `updateMany`, so it is idempotent and safe to run on several
instances at once — appropriate at this scale, and easy to move to a proper
job runner later.

---

## 8. Reading this codebase

If you're new, this order gets you productive fastest:

1. `packages/shared-types/src/game-definition.ts` — the vocabulary everything
   else speaks.
2. `apps/game-backend/src/rounds/service.ts` — the money path, top to bottom.
3. `packages/ledger/src/wallet.ts` — short. Read every line.
4. `packages/math-engine/src/engine/spin.ts` — the pure evaluation pipeline.
5. `apps/game-socket/src/index.ts` — where player identity is established.
6. `packages/mongo-schemas/src/collections.ts` — **the indexes are the
   concurrency design.** Most exactly-once guarantees are declared here, not
   in application code.

**Read the comments.** They explain *why*, and several record a real bug's
post-mortem. That history is an asset — treat it as documentation, not
clutter.

---

## 9. Honest assessment

**Strong.** Perimeter and internal auth, ledger design, replayable RNG with a
real statistical suite, config-over-code kept honest, an allowlist disclosure
boundary, and both known defects of the reference architecture closed with
tests that would catch a regression.

**Known gaps, stated plainly.**

- **The in-memory test double does not model transaction rollback.** It runs
  the callback and lets a throw propagate without undoing writes. Tests that
  depend on real rollback semantics need the end-to-end path.
- **`/internal/simulate` still runs synchronously** on the process that serves
  live rounds. The definition is loaded by id rather than accepted from the
  caller, and the count is capped at 100k — but a cap is a mitigation, not a
  fix. The real fix is a worker process. (The backoffice's own pre-publish
  simulation deliberately runs in the *backoffice* process for this reason:
  if a publish is briefly slow, one designer waits instead of every player.)
- **`bonusReturnMultiplier` is an estimate supplied to the simulation**, not a
  measurement of the module. A bonus module's real expected value should
  eventually be derived by simulating the module itself — until then a game
  whose bonus pays very differently will have a correspondingly wrong
  `bonusRtp`.
- **Bonus abandonment is in-process.** Fine at this scale, wrong at ten
  services.
- **A user cannot change their own password.** Only an administrator can
  reset one, which is backwards for the common case.
- **No email, so no self-service recovery.** A forgotten password needs
  another administrator.
- **The UI has no undo.** Autosave means an accidental edit is persisted
  immediately; the published-version history is the only way back, and it
  restores nothing automatically.
- **The frontend has no artwork.** Symbols render as glyphs and colours
  derived from the symbol id, because a `GameDefinition` describes maths, not
  art. An asset pipeline is a separate piece of work.
- **No operator management or reporting yet.** Operators are assumed to exist;
  there is no HMAC api-key issuance flow and no revenue reporting.

**Verification status.** Everything above was executed, not just written:
244 unit tests pass, both end-to-end suites run green against real services
and a real MongoDB replica set, and both browser clients were driven in a real
browser — the player through a full launch → spin → win → balance cycle, and
the backoffice through login → edit → RTP preview → refused publish → corrected
publish → v2 live → confirmed playable. The reference game
measures **0.949–0.966 RTP** against its 0.95 target across runs.
