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
