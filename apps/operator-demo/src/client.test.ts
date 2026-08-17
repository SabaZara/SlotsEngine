import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalRequest, computeSignature, createIntegrationClient } from "./client.js";

/**
 * The signing an integrator has to reproduce.
 *
 * These tests are a second opinion on the protocol, not a second opinion on
 * our code: they recompute the expected signature here, from the
 * specification, rather than calling the same helper the client calls. A
 * test that verifies `computeSignature` against `computeSignature` agrees
 * with itself no matter what the server expects.
 *
 * What they cannot establish: that integration-api actually accepts these
 * requests. Only `npm run e2e:operator` crosses that boundary, and it is
 * the thing that would fail if this file and the server ever disagreed.
 *
 * **One surviving mutation, and it is a genuine equivalent mutant — the
 * distinction from the identical-looking mutation on the server is worth
 * recording.** Replacing `body: rawBody` with
 * `body: JSON.stringify(JSON.parse(rawBody))` survives every test here, and
 * cannot be caught by any test of this client, because `rawBody` is always
 * `JSON.stringify`'s own output: the round trip is provably lossless for
 * every value this client can produce (checked across floats, exponents,
 * non-ASCII, `-0`, nested objects and arrays — none differ).
 *
 * The *same* mutation on `integration-api`'s raw-body parser was a real
 * defect, because there the bytes arrive from an arbitrary client that may
 * pretty-print or order keys differently. Same edit, opposite verdict,
 * decided by which side of the wire owns the bytes. Attempting to close it
 * here produced a test that recomputed the expected value with
 * `JSON.stringify` and therefore shared the blind spot exactly — a test
 * that asserts nothing, which is worse than an acknowledged gap.
 */

const CREDENTIALS = { apiKeyId: "key-1", apiSecret: "secret-1" };

/** Captures what would have gone onto the wire. */
function recordingFetch(response: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headerOf(init: RequestInit, name: string): string {
  return (init.headers as Record<string, string>)[name] ?? "";
}

describe("the canonical string", () => {
  it("is timestamp, method, url and body, joined by dots", () => {
    // Written out literally rather than built from the function under test.
    // This is the line an integrator in another language has to match.
    assert.equal(
      canonicalRequest("1700000000000", "POST", "/v1/launch", '{"a":1}'),
      '1700000000000.POST./v1/launch.{"a":1}',
    );
  });

  it("uppercases the method, so a lowercase verb still signs correctly", () => {
    assert.equal(canonicalRequest("1", "post", "/x", ""), "1.POST./x.");
  });

  it("keeps the query string, which is all a GET has to distinguish it", () => {
    const mine = canonicalRequest("1", "GET", "/v1/wallet/balance?playerId=me", "");
    const theirs = canonicalRequest("1", "GET", "/v1/wallet/balance?playerId=you", "");
    assert.notEqual(mine, theirs);
  });
});

describe("what the client puts on the wire", () => {
  it("signs the exact body it sends", async () => {
    // The failure this pins is the one the module comment warns about:
    // serialising twice. Here the signature is recomputed from the body
    // actually transmitted, so any divergence between the two fails.
    const { impl, calls } = recordingFetch({ body: { balance: 100 } });
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    await client.cashIn({ transactionId: "t1", playerId: "p1", amount: 500 });

    const { init } = calls[0]!;
    const sentBody = init.body as string;
    const expected = createHmac("sha256", CREDENTIALS.apiSecret)
      .update(`${headerOf(init, "x-timestamp")}.POST./v1/wallet/cash-in.${sentBody}`)
      .digest("hex");

    assert.equal(headerOf(init, "x-signature"), expected);
  });

  it("signs the query string on a bodyless GET", async () => {
    const { impl, calls } = recordingFetch({ body: { balance: 0 } });
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    await client.balance("player-1");

    const { init } = calls[0]!;
    const expected = createHmac("sha256", CREDENTIALS.apiSecret)
      .update(`${headerOf(init, "x-timestamp")}.GET./v1/wallet/balance?playerId=player-1.`)
      .digest("hex");

    assert.equal(headerOf(init, "x-signature"), expected);
  });

  it("sends no body and no content-type on a GET", async () => {
    // A GET signed against an empty string but sent with `{}` fails
    // verification — the signature covers bytes that were never sent.
    const { impl, calls } = recordingFetch({ body: { games: [] } });
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    await client.listGames();

    assert.equal(calls[0]!.init.body, undefined);
    assert.equal(headerOf(calls[0]!.init, "content-type"), "");
  });

  it("encodes a playerId that would otherwise change which URL is signed", async () => {
    // A playerId is the operator's own identifier. One containing `&` would
    // silently become a second query parameter, so the URL signed and the
    // resource requested would differ.
    const { impl, calls } = recordingFetch({ body: { balance: 0 } });
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    await client.balance("a&b=c");

    assert.ok(calls[0]!.url.endsWith("/v1/wallet/balance?playerId=a%26b%3Dc"));
  });

  it("sends the key id and a current timestamp", async () => {
    const { impl, calls } = recordingFetch();
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    const before = Date.now();
    await client.listGames();

    const timestamp = Number(headerOf(calls[0]!.init, "x-timestamp"));
    assert.equal(headerOf(calls[0]!.init, "x-api-key-id"), "key-1");
    assert.ok(timestamp >= before && timestamp <= Date.now(), "the timestamp must be now, or the skew check refuses it");
  });

  it("produces a different signature for each call, so nothing is replayable", async () => {
    // Two identical requests must not carry identical signatures, or the
    // second is refused as a replay of the first. The timestamp is what
    // makes them differ.
    const { impl, calls } = recordingFetch();
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    await client.listGames();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await client.listGames();

    assert.notEqual(headerOf(calls[0]!.init, "x-signature"), headerOf(calls[1]!.init, "x-signature"));
  });

  it("reports a refusal rather than throwing", async () => {
    // The demo renders upstream failures as a page. A client that threw
    // would turn a 403 into a stack trace.
    const { impl } = recordingFetch({ status: 403, body: { error: "game_not_enabled_for_operator" } });
    const client = createIntegrationClient({ baseUrl: "http://api.test", credentials: CREDENTIALS, fetchImpl: impl });

    const response = await client.launch({ playerId: "p", gameId: "g" });

    assert.equal(response.ok, false);
    assert.equal(response.status, 403);
    assert.equal(response.body.error as unknown, "game_not_enabled_for_operator");
  });
});

describe("computeSignature", () => {
  it("matches an independently computed HMAC-SHA256", () => {
    const canonical = "1700000000000.GET./v1/games.";
    const expected = createHmac("sha256", "s").update(canonical).digest("hex");
    assert.equal(computeSignature("s", canonical), expected);
  });

  it("changes completely when the secret changes", () => {
    const canonical = "1700000000000.GET./v1/games.";
    assert.notEqual(computeSignature("secret-a", canonical), computeSignature("secret-b", canonical));
  });
});
