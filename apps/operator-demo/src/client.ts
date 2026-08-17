import { createHmac } from "node:crypto";

/**
 * A worked implementation of the request signing described in
 * `docs/INTEGRATION.md`.
 *
 * **Deliberately not imported from `apps/integration-api`, and deliberately
 * not extracted into a shared package.** This app stands in for a real
 * aggregator's own backend, and a real aggregator writes this from the
 * published protocol in whatever language their stack uses — they cannot
 * import our internals, so a demo that does would prove the protocol is
 * implementable only by us. The duplication is the test: if the document is
 * wrong, this file and the server disagree, and `npm run e2e:operator`
 * fails.
 *
 * The same reasoning already governs `scripts/e2e/*.mjs`, which re-derive
 * their signing for the same reason.
 */

/**
 * The canonical string, reproduced from the specification:
 *
 *     <timestamp>.<METHOD>.<url>.<rawBody>
 *
 * Two details a re-implementer gets wrong and the tests here pin:
 *
 *  - **`url` includes the query string.** A GET has no body, so the query is
 *    the only thing distinguishing one balance request from another. Sign
 *    the path alone and a signature valid for your own player is valid for
 *    every player.
 *  - **`rawBody` is the exact bytes you send**, not a re-serialisation. If
 *    you build the JSON, sign it, then hand the *object* to your HTTP
 *    client and let it serialise again, the two can differ — key order and
 *    whitespace are not guaranteed stable — and every request fails
 *    verification for a reason no log explains. Serialise once, sign that
 *    string, send that string.
 */
export function canonicalRequest(timestamp: string, method: string, url: string, rawBody: string): string {
  return `${timestamp}.${method.toUpperCase()}.${url}.${rawBody}`;
}

export function computeSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export interface OperatorCredentials {
  apiKeyId: string;
  apiSecret: string;
}

export interface IntegrationResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

/**
 * Signs and sends one call, exactly as a partner backend would.
 *
 * `fetch` is injectable so the tests can drive this without a server —
 * everything worth checking here is what goes *onto the wire*, and a test
 * that needs a live service to check a header is a test nobody runs.
 */
export function createIntegrationClient(options: {
  baseUrl: string;
  credentials: OperatorCredentials;
  fetchImpl?: typeof fetch;
}) {
  const { baseUrl, credentials, fetchImpl = fetch } = options;

  async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<IntegrationResponse<T>> {
    // Serialised once. See the note on `rawBody` above — this single
    // variable being used for both the signature and the payload is the
    // whole discipline.
    const rawBody = body !== undefined ? JSON.stringify(body) : "";
    const timestamp = Date.now().toString();
    const signature = computeSignature(credentials.apiSecret, canonicalRequest(timestamp, method, url, rawBody));

    const response = await fetchImpl(`${baseUrl}${url}`, {
      method,
      headers: {
        // Content-Type only when there is a body. Sending it on a bodyless
        // GET is harmless for the signature but misdescribes the request,
        // and some proxies will helpfully supply an empty body to match.
        ...(rawBody.length > 0 ? { "content-type": "application/json" } : {}),
        "x-api-key-id": credentials.apiKeyId,
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
      ...(rawBody.length > 0 ? { body: rawBody } : {}),
    });

    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: (text ? JSON.parse(text) : undefined) as T,
    };
  }

  return {
    listGames: () => call<{ games: Array<{ gameId: string; name: string }> }>("GET", "/v1/games"),

    cashIn: (input: { transactionId: string; playerId: string; amount: number }) =>
      call<{ balance: number; alreadyProcessed: boolean }>("POST", "/v1/wallet/cash-in", input),

    balance: (playerId: string) =>
      // Encoded, because a playerId is the operator's own identifier and may
      // legitimately contain characters that would otherwise change which
      // URL is signed.
      call<{ balance: number }>("GET", `/v1/wallet/balance?playerId=${encodeURIComponent(playerId)}`),

    launch: (input: { playerId: string; gameId: string }) =>
      call<{ token: string; expiresAt: number; launchUrl: string }>("POST", "/v1/launch", input),
  };
}

export type IntegrationClient = ReturnType<typeof createIntegrationClient>;
