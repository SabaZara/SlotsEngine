# Direct integration

How an operator connects to this platform: authenticate every request,
fund a player, hand them into a game.

This is the specification `apps/operator-demo` is written against. That app
implements everything below from this document alone — it does not import
the server's code — so if the two disagree, `npm run e2e:operator` fails.
That is deliberate: a protocol only one codebase can implement is not a
protocol.

**Base URL:** `https://<host>:9006` (`http://localhost:9107` locally.)

---

## 1. Getting credentials

Credentials are issued in the backoffice, under **Operators**. Creating an
operator returns two values:

| | What it is |
|---|---|
| `apiKeyId` | Public. Sent in the clear on every request; names which secret to verify against. |
| `apiSecret` | Secret. Signs every request. **Shown exactly once, on creation.** |

The secret cannot be retrieved afterwards — only an encrypted copy is
stored, and no endpoint decrypts it back out. If it is lost, rotate it,
which issues a new pair and stops the old one working immediately.

Before you can launch anything, an administrator must also grant your
operator at least one game, and that game must be **published**. A game
that is enabled but still a draft is refused.

---

## 2. Signing a request

Every request except `/health` carries three headers:

```
X-Api-Key-Id:  <your apiKeyId>
X-Timestamp:   <milliseconds since the Unix epoch>
X-Signature:   <hex HMAC-SHA256, computed below>
```

The signature covers a **canonical string** built from four parts joined by
a literal `.`:

```
<timestamp>.<METHOD>.<url>.<rawBody>
```

- `timestamp` — the same value sent in `X-Timestamp`.
- `METHOD` — uppercase (`GET`, `POST`).
- `url` — path **and query string**, exactly as requested
  (`/v1/wallet/balance?playerId=abc`).
- `rawBody` — the exact request body as sent. Empty string when there is
  no body.

Then:

```
X-Signature = hex( HMAC-SHA256( apiSecret, canonicalString ) )
```

### Three ways this goes wrong

These are the mistakes worth stating explicitly, because each produces a
`bad_signature` that no log will explain.

**Sign the bytes you send, not an equal-valued object.** Serialise your
body once, sign that string, and send that same string. If you sign a
serialisation and then hand the *object* to your HTTP client to serialise
again, the two can differ — key order and whitespace are not guaranteed
stable across serialisers — and every request fails.

**Include the query string.** A `GET` has no body, so the query is the only
thing distinguishing one balance request from another. Sign the path alone
and your signature for your own player is equally valid for someone else's,
which is exactly why the server will not accept it.

**Send `Content-Type: application/json` only when there is a body.** A
bodyless `GET` signed against an empty string but sent with `{}` fails: the
signature covers bytes that were never sent.

### Worked example

```
apiSecret     = "s3cr3t"
timestamp     = "1700000000000"
method        = "POST"
url           = "/v1/launch"
rawBody       = {"playerId":"p1","gameId":"reference-5x3"}

canonical     = 1700000000000.POST./v1/launch.{"playerId":"p1","gameId":"reference-5x3"}
X-Signature   = hex(HMAC-SHA256("s3cr3t", canonical))
```

`apps/operator-demo/src/client.ts` is this in ~40 lines of TypeScript.

---

## 3. Replay and clock skew

**A request may be sent once.** The server records every signature it has
accepted and refuses a repeat with `replayed_request`. Since a signature
covers the exact timestamp, method, URL and body, a byte-identical resend
necessarily carries a byte-identical signature — so retrying a request
means building a **new** one with a fresh timestamp, not resending the old
bytes.

This is safe on the money routes because those are separately idempotent:
see `transactionId` below.

**Your clock must be within five minutes of ours.** Outside that,
`timestamp_out_of_range`, in both directions. If you see this
intermittently, check NTP before checking anything else.

---

## 4. Endpoints

All responses are JSON. `operatorId` is never a parameter — it is resolved
from your verified signature, so you cannot name another operator's player
even by accident.

### `GET /v1/games`

The games you may launch: entitled to you *and* currently published.

```json
{ "games": [ { "gameId": "reference-5x3", "name": "Reference 5x3" } ] }
```

### `POST /v1/wallet/cash-in`

Moves money onto a player's balance. Creates the player if new.

```json
{ "transactionId": "<your unique id>", "playerId": "p1", "amount": 100000 }
```

`amount` is **integer minor units** — 100000 is £1,000.00. Never a decimal;
a fractional amount is refused with `400`.

`transactionId` is your idempotency key, and it is the reason retrying is
safe. Repeat a call with the same one and the money moves once; the
response tells you which happened:

```json
{ "transactionId": "...", "balance": 100000, "alreadyProcessed": false }
```

### `POST /v1/wallet/cash-out`

The same shape, in the other direction. Refuses with `402
insufficient_funds` rather than letting a balance go negative; the balance
is untouched when it does.

### `GET /v1/wallet/balance?playerId=p1`

```json
{ "playerId": "p1", "balance": 99000 }
```

An unknown player reads as `0` rather than `404` — "no player" and "no
money" are the same answer, and a `404` would confirm which of your player
ids exist to anyone who obtained your credentials.

### `GET /v1/wallet/transactions?playerId=p1`

Or `?roundId=...`. One of the two is required. Returns up to 200 rows,
newest first, scoped to your operator.

### `POST /v1/launch`

The handoff.

```json
{ "playerId": "p1", "gameId": "reference-5x3" }
```

```json
{
  "token": "<single-use launch token>",
  "expiresAt": 1700000060000,
  "launchUrl": "https://games.example.com/?token=..."
}
```

Send the player's browser to `launchUrl`, or embed it in an iframe.

The token is **single-use and short-lived** (60 seconds). It travels in a
URL, which leaks through referrer headers, proxy logs and browser history,
so it is deliberately useless almost immediately and cannot be replayed
once the game has consumed it. Mint a new one per launch; do not cache
them.

Fund the player **before** launching. A player with no balance can only be
shown an `insufficient_funds` error.

### `PUT /v1/players/limits`

Sets the ceilings a player plays under. **These are the responsible-gambling
controls a licence requires**, so they belong wherever the player already
manages their account with you — this endpoint is how that reaches us.

```json
{
  "playerId": "p1",
  "limits": [
    { "period": "daily", "maxStake": 50000, "maxLoss": 20000 },
    { "period": "monthly", "maxLoss": 200000 }
  ]
}
```

`period` is `daily`, `weekly` or `monthly`. Both ceilings are optional per
period, but a period must carry at least one. Amounts are integer minor
units, like every amount in this API.

**The array replaces the whole set.** Send every limit that should apply,
not just the one that changed — an absent period is a request to remove it,
and `[]` a request to clear all of them. A partial update has no safe
reading ("leave alone" or "remove"?), so it is not offered.

**Tightening applies at once. Loosening waits 24 hours.** This is the
control that stops a player lifting their own ceiling in the moment it
starts to bind, and the asymmetry is deliberate: protecting someone from a
decision made under pressure must never mean delaying their decision to be
safer.

- **Lowering a ceiling, or setting one where there was none, is immediate.**
- **Raising a ceiling is deferred**, and so is *removing* one — an absent
  ceiling means unlimited, so dropping a limit is the largest possible
  loosening, not a clearance.

When anything is deferred, the response carries a `pending` block and
`limits` shows what is **still in force**:

```json
{
  "playerId": "p1",
  "limits": [{ "period": "daily", "maxStake": 10000 }],
  "pending": {
    "limits": [{ "period": "daily", "maxStake": 90000 }],
    "effectiveAt": 1700086400000,
    "requestedAt": 1700000000000
  }
}
```

Read `limits` as the answer to "what applies now" and `pending` as "what
will apply, and when". A submission with nothing deferred returns no
`pending` key at all, so a client can branch on its presence — and an
integrator who ignores it is never silently told a raise took effect.

A later submission **replaces** any pending change rather than queueing
behind it: the player has just said what they want, and it is not the raise
they asked for yesterday. Every change is recorded in the audit log with
its direction, attributed to your operator.

Two things worth knowing before you set these:

- **Loss is net.** Staking 100 and winning 95 back counts as a loss of 5,
  not 100. A winning session therefore re-opens headroom the player had
  used, which is the standard reading and probably what your compliance
  team expects — but confirm it, because the gross reading exhausts a limit
  far faster.
- **Periods are calendar periods in UTC**, and reset on their own. A daily
  limit resets at 00:00 UTC, a weekly one on Monday (ISO weeks), a monthly
  one on the 1st. There is no rolling "any 24 hours" window.

A player who reaches a limit gets `403` on their next spin, and the game
tells them which limit and how much room is left. **They are not shown a
deposit prompt** — see the note on `stake_limit_reached` below.

### `GET /v1/players/limits?playerId=p1`

Reads them back. Returns `{ "playerId": "p1", "limits": [...] }`, with an
empty array for a player who has none — a player with no limits is a normal
state, not a missing one, so this is `200` rather than `404`.

---

## 5. Errors

| Status | `error` | What to do |
|---|---|---|
| 401 | `missing_auth_headers` | Send all three headers. |
| 401 | `unknown_api_key` | Check `X-Api-Key-Id`. Also returned for a credential that is no longer usable. |
| 401 | `bad_signature` | See §2 — almost always the body or the query string. |
| 401 | `timestamp_out_of_range` | Check your clock. |
| 401 | `replayed_request` | Build a new request rather than resending old bytes. |
| 403 | `operator_disabled` | Your access was withdrawn. Talk to us. |
| 403 | `game_not_enabled_for_operator` | Ask for that game to be granted. |
| 404 | `game_not_found` | Granted, but not published. |
| 400 | `invalid_request` | Check types — `amount` must be a positive integer. |
| 400 | `must_provide_playerId_or_roundId` | A statement query needs one of the two. |
| 402 | `insufficient_funds` | The balance is unchanged. |
| 403 | `stake_limit_reached` | The player hit their own stake ceiling. **Do not offer a deposit** — they have money and chose a limit. The response carries `period` and `remaining`. |
| 403 | `loss_limit_reached` | As above, against their net-loss ceiling. |
| 400 | `invalid_player_id` | `playerId` is required and must be a non-empty string. |
| 400 | `invalid_limits` | `limits` must be an array of objects. |
| 400 | `invalid_period` | `period` must be `daily`, `weekly` or `monthly`. |
| 400 | `duplicate_period` | Two entries named the same period; there is no correct way to merge them. |
| 400 | `invalid_amount` | A ceiling must be a non-negative integer in minor units. |
| 400 | `empty_limit` | A period named neither `maxStake` nor `maxLoss` — usually a misspelled field. |
| 429 | `rate_limited` | 300 requests/minute per key. Honour `Retry-After`. |

---

## 6. Trying it

`apps/operator-demo` is a working integrator you can run:

```bash
docker compose -f infra/docker-compose.yml --profile demo up -d
```

It needs `DEMO_OPERATOR_API_KEY_ID` and `DEMO_OPERATOR_API_SECRET` in
`infra/.env` — create an operator in the backoffice first, and copy the
secret when it is shown. It refuses to start without them rather than
falling back to a default, because a demo with a known secret is a
production incident waiting for someone to copy it.

Then open `http://localhost:9108`.
