// Set before the import below, because `secret()` reads the environment per
// call but the module also captures its backend URL at load time. Assigning
// GAME_BACKEND_URL here would be misleading — it is read once at import and
// the default wins regardless; see the URL test for the detail.
process.env.SERVICE_AUTH_SECRET = "a-test-service-secret-long-enough-to-pass";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { verifyServiceRequest } from "@slots-engine/service-auth";
import {
  BackendError,
  BonusSessionAbandonedError,
  GameNotFoundError,
  InsufficientFundsError,
  InvalidBetAmountError,
  LaunchTokenAlreadyUsedError,
  getBalance,
  recover,
  spin,
} from "./backendClient.js";

/**
 * Tests for the socket's boundary to the money path.
 *
 * Everything a player does that costs or pays money leaves this service
 * through this file, and the error translation here is what decides whether
 * a player is told "you don't have enough" or given a generic failure. The
 * mapping was previously covered only incidentally, through end-to-end runs
 * that happen to produce a few of these codes.
 *
 * `fetch` is stubbed rather than hitting a server: the interesting
 * behaviour is what this module does with a response, and a real backend
 * makes the error cases hard to produce on purpose.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stubs fetch with a fixed response, capturing the request for inspection. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as never;
  return calls;
}

const spinInput = { operatorId: "op-1", playerId: "p-1", gameId: "g-1", totalBet: 100 };

describe("request shape", () => {
  it("signs the exact bytes it transmits, verified the way the backend verifies them", async () => {
    // The body is serialised once and both signed and sent as that same
    // string. Re-serialising for the signature risks a key-order or
    // whitespace difference producing a signature that does not match the
    // bytes on the wire — a bug that shows up only intermittently.
    //
    // This verifies the signature the way the backend does, rather than
    // comparing the body to a locally re-serialised copy: the assertion
    // that matters is that the bytes on the wire and the bytes under the
    // signature are the same bytes.
    //
    // Worth being precise about the limit. Replacing `rawBody` with
    // `JSON.stringify({ ...body })` does not fail this test — but it also
    // is not a bug: for these objects it produces a byte-identical string,
    // so it is an equivalent mutant, not an escaped defect. Signing bytes
    // that genuinely differ from those transmitted *is* caught (verified by
    // mutation), and that is the failure this guards.
    const calls = stubFetch(200, { round: {}, balanceAfter: 900 });
    await spin(spinInput);

    const { body, headers } = calls[0].init as { body: string; headers: Record<string, string> };
    const verified = verifyServiceRequest({
      secret: process.env.SERVICE_AUTH_SECRET!,
      method: "POST",
      path: "/internal/rounds/spin",
      rawBody: body,
      headers,
    });
    assert.equal(verified.caller, "game-socket", "the signature must verify against the body actually sent");
  });

  it("produces a signature that fails if the body is altered in flight", async () => {
    // The other half: proof the check above is capable of failing at all.
    const calls = stubFetch(200, { round: {}, balanceAfter: 900 });
    await spin(spinInput);

    const { headers } = calls[0].init as { body: string; headers: Record<string, string> };
    assert.throws(
      () =>
        verifyServiceRequest({
          secret: process.env.SERVICE_AUTH_SECRET!,
          method: "POST",
          path: "/internal/rounds/spin",
          rawBody: JSON.stringify({ ...spinInput, totalBet: 999_999 }),
          headers,
        }),
      "a rewritten bet amount must not verify",
    );
  });

  it("sends the signature headers and names itself as the caller", async () => {
    const calls = stubFetch(200, { round: {}, balanceAfter: 900 });
    await spin(spinInput);

    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers["x-service-signature"], "an unsigned internal call would simply be refused");
    assert.ok(headers["x-service-timestamp"], "the timestamp is what bounds the replay window");
    assert.equal(headers["x-service-caller"], "game-socket");
    assert.equal(headers["content-type"], "application/json");
  });

  it("posts to the backend URL captured at module load", async () => {
    // `BACKEND_URL` is read once when the module is first imported, NOT per
    // call — so setting GAME_BACKEND_URL after import has no effect, and
    // this test asserts the default it actually resolved to rather than the
    // value assigned at the top of this file.
    //
    // That is fine in production, where the environment is set before the
    // process starts, and it is deliberately pinned here so the behaviour is
    // a documented property rather than a surprise to whoever next tries to
    // point this client somewhere else at runtime.
    const calls = stubFetch(200, { round: {}, balanceAfter: 900 });
    await spin(spinInput);

    assert.equal(calls[0].url, "http://localhost:9002/internal/rounds/spin");
    assert.equal(calls[0].init.method, "POST");
  });
});

describe("error translation — what decides the message a player sees", () => {
  const cases: [string, new (...args: never[]) => BackendError][] = [
    ["insufficient_funds", InsufficientFundsError],
    ["invalid_bet_amount", InvalidBetAmountError],
    ["game_not_found", GameNotFoundError],
    ["bonus_session_abandoned", BonusSessionAbandonedError],
    ["launch_token_already_used", LaunchTokenAlreadyUsedError],
  ];

  for (const [code, type] of cases) {
    it(`maps ${code} to its own error type`, async () => {
      stubFetch(400, { error: code, message: "detail from the backend" });
      await assert.rejects(() => spin(spinInput), type);
    });
  }

  it("preserves the status and message alongside the code", async () => {
    stubFetch(402, { error: "insufficient_funds", message: "balance is 50, bet is 100" });
    await assert.rejects(
      () => spin(spinInput),
      (err: BackendError) => {
        assert.equal(err.code, "insufficient_funds");
        assert.equal(err.status, 402);
        assert.equal(err.message, "balance is 50, bet is 100");
        return true;
      },
    );
  });

  it("falls back to a generic error for an unrecognised code", async () => {
    // A code this client has never heard of must still surface as an
    // error, not be mistaken for one of the specific types.
    stubFetch(500, { error: "something_new" });
    await assert.rejects(() => spin(spinInput), (err: BackendError) => {
      assert.ok(err instanceof BackendError);
      assert.ok(!(err instanceof InsufficientFundsError), "an unknown code must not be mapped to a known one");
      assert.equal(err.code, "something_new");
      return true;
    });
  });

  it("does not crash on an error response with no JSON body at all", async () => {
    // A 502 from a proxy, or a backend that died mid-response, returns
    // something unparseable. The client must still raise a clean error.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as never;

    await assert.rejects(() => spin(spinInput), (err: BackendError) => {
      assert.equal(err.code, "backend_error", "an unreadable body still needs a code");
      assert.equal(err.status, 502);
      return true;
    });
  });

  it("uses the code as the message when the backend sends no message", async () => {
    stubFetch(400, { error: "invalid_bet_amount" });
    await assert.rejects(() => spin(spinInput), /invalid_bet_amount/);
  });
});

describe("recover", () => {
  it("returns null for 404 rather than throwing — no round to recover is normal", async () => {
    // A player with nothing in flight is the ordinary case, not an error.
    stubFetch(404, { error: "round_not_found" });
    assert.equal(await recover("op-1", "p-1"), null);
  });

  it("still throws on any other failure", async () => {
    // A 500 means something is wrong; swallowing it as "no round" would
    // silently hide a broken backend from the player and the logs.
    stubFetch(500, { error: "internal_error" });
    await assert.rejects(() => recover("op-1", "p-1"), BackendError);
  });

  it("returns the round when there is one", async () => {
    stubFetch(200, { round: { roundId: "r-1" } });
    const result = await recover("op-1", "p-1");
    assert.equal(result?.round.roundId, "r-1");
  });
});

describe("getBalance", () => {
  it("unwraps the balance field", async () => {
    stubFetch(200, { balance: 12_345 });
    assert.equal(await getBalance("op-1", "p-1"), 12_345);
  });

  it("propagates a failure rather than reporting a balance of zero", async () => {
    // Returning 0 on error would show a player an empty wallet they still
    // own — the most alarming possible way to render a transient failure.
    stubFetch(500, { error: "internal_error" });
    await assert.rejects(() => getBalance("op-1", "p-1"), BackendError);
  });
});

describe("secret configuration", () => {
  it("refuses to make an unsigned call when the secret is missing", async () => {
    const saved = process.env.SERVICE_AUTH_SECRET;
    try {
      delete process.env.SERVICE_AUTH_SECRET;
      stubFetch(200, {});
      await assert.rejects(() => spin(spinInput), /SERVICE_AUTH_SECRET/);
    } finally {
      process.env.SERVICE_AUTH_SECRET = saved;
    }
  });

  it("refuses a trivially short secret", async () => {
    const saved = process.env.SERVICE_AUTH_SECRET;
    try {
      process.env.SERVICE_AUTH_SECRET = "short";
      stubFetch(200, {});
      await assert.rejects(() => spin(spinInput), /32 characters/);
    } finally {
      process.env.SERVICE_AUTH_SECRET = saved;
    }
  });
});
