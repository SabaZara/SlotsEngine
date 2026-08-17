import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api, setSessionLostHandler, setSessionToken } from "./api.js";

/**
 * The admin client's request layer.
 *
 * Two properties carry real weight here, and both pair with work already
 * done on the backend:
 *
 *   **The session token lives in memory only.** A bearer token in
 *   `localStorage` is readable by any script that reaches the page and it
 *   survives the tab, so a shared machine keeps an admin session alive long
 *   after the person walked away. The cost is re-logging-in after a refresh,
 *   which for an internal tool is the right side of that trade.
 *
 *   **A 401 clears the token and fires one global handler.** This is the
 *   client half of the `tokenVersion` revocation mechanism: the backend
 *   makes a demotion or a deactivation take effect on the very next request
 *   (see `middleware.test.ts` and `users.test.ts`), and this is what turns
 *   that 401 into the user actually being returned to the login screen
 *   rather than staring at a broken page.
 *
 * `fetch` is stubbed. These are assertions about headers, token lifecycle
 * and error mapping — not about the network, and not about the backoffice
 * routes, which have their own tests.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];
let nextResponses: Array<{ status: number; body: unknown }> = [];

function stubFetch(): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: Record<string, unknown> = {}) => {
    recorded.push({
      url: String(url),
      method: (init.method as string) ?? "GET",
      headers: (init.headers as Record<string, string>) ?? {},
      ...(init.body !== undefined ? { body: init.body as string } : {}),
    });
    const next = nextResponses.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
}

beforeEach(() => {
  recorded = [];
  nextResponses = [];
  stubFetch();
  setSessionToken(null);
  setSessionLostHandler(() => {});
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
  setSessionToken(null);
});

/** Queues the next response the stubbed fetch will return. */
const respond = (status: number, body: unknown = {}) => nextResponses.push({ status, body });

describe("the session token", () => {
  it("is not sent before anyone has logged in", async () => {
    // Login itself must not carry an authorization header — there is no
    // session yet, and sending an empty or stale one invites the backend to
    // reject the very request that would create a session.
    respond(200, { token: "t", expiresAt: 1, user: {} });
    await api.login("admin@example.com", "correct-horse");

    assert.equal(recorded[0].headers.authorization, undefined);
  });

  it("is attached to every request once set", async () => {
    setSessionToken("session-abc");
    respond(200, { user: {} });
    await api.me();

    assert.equal(recorded[0].headers.authorization, "Bearer session-abc");
  });

  it("stops being sent once cleared", async () => {
    // What logout has to accomplish on the client side.
    setSessionToken("session-abc");
    setSessionToken(null);
    respond(200, { user: {} });
    await api.me();

    assert.equal(recorded[0].headers.authorization, undefined);
  });

  it("is never written to browser storage", async () => {
    // The property the module's comment promises. A future "keep me signed
    // in" convenience is exactly how this regresses, so the absence of any
    // storage write is worth pinning rather than trusting.
    const writes: string[] = [];
    const storage = { setItem: (key: string) => writes.push(key), getItem: () => null, removeItem: () => {} };
    (globalThis as { localStorage: unknown }).localStorage = storage;
    (globalThis as { sessionStorage: unknown }).sessionStorage = storage;

    try {
      respond(200, { token: "issued-token", expiresAt: 1, user: {} });
      await api.login("admin@example.com", "correct-horse");
      setSessionToken("issued-token");
      respond(200, { user: {} });
      await api.me();

      assert.deepEqual(writes, [], "no admin token may be written to browser storage");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe("a 401 ends the session", () => {
  it("clears the token and calls the handler exactly once", async () => {
    // The client half of tokenVersion revocation: the backend makes a
    // demotion take effect on the next request, and this turns that 401
    // into the user being sent back to login rather than a broken screen.
    let lost = 0;
    setSessionLostHandler(() => (lost += 1));
    setSessionToken("session-abc");

    respond(401, { error: "session_revoked" });
    await assert.rejects(() => api.me(), ApiError);

    assert.equal(lost, 1, "the session-lost handler must fire");

    // The next request must go out unauthenticated — proof the token is gone.
    respond(200, { user: {} });
    await api.me();
    assert.equal(recorded[1].headers.authorization, undefined, "the revoked token must not be reused");
  });

  it("does not fire the handler for a 401 when nobody was logged in", async () => {
    // A failed login returns 401 too. Treating that as "your session ended"
    // would bounce a user who never had one, and on a login screen that is
    // a confusing loop.
    let lost = 0;
    setSessionLostHandler(() => (lost += 1));

    respond(401, { error: "invalid_credentials" });
    await assert.rejects(() => api.login("admin@example.com", "wrong"), ApiError);

    assert.equal(lost, 0, "a failed login is not a lost session");
  });

  it("does not fire the handler for a 403", async () => {
    // 403 means signed in but not permitted — the user must stay signed in
    // and see a permission error, not be logged out.
    let lost = 0;
    setSessionLostHandler(() => (lost += 1));
    setSessionToken("session-abc");

    respond(403, { error: "forbidden", requiredRoles: ["game_designer"] });
    await assert.rejects(() => api.listGames(), ApiError);

    assert.equal(lost, 0, "a permission error must not log the user out");

    respond(200, { games: [] });
    await api.listGames();
    assert.equal(recorded[1].headers.authorization, "Bearer session-abc", "the session must survive a 403");
  });
});

describe("error mapping", () => {
  it("throws an ApiError carrying the status and the server's code", async () => {
    // A screen needs the code to decide what to say. Collapsing everything
    // to "request failed" makes every backend distinction useless.
    setSessionToken("session-abc");
    respond(409, { error: "game_id_taken", message: "That id is already in use." });

    const error = (await api.createGame("dup", "Dup").catch((e) => e)) as ApiError;

    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "game_id_taken");
    assert.equal(error.message, "That id is already in use.");
  });

  it("falls back to the code when the server sends no message", async () => {
    setSessionToken("session-abc");
    respond(400, { error: "invalid_draft" });

    const error = (await api.listGames().catch((e) => e)) as ApiError;

    assert.equal(error.code, "invalid_draft");
    assert.equal(error.message, "invalid_draft", "a code is better than an empty message");
  });

  it("still throws a usable error when the body is not JSON at all", async () => {
    // A proxy returning an HTML error page must not surface as "cannot read
    // properties of undefined" — the status is the only signal left and it
    // has to survive.
    setSessionToken("session-abc");
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    });

    const error = (await api.listGames().catch((e) => e)) as ApiError;

    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "request_failed");
  });

  it("carries the whole payload, so a screen can read extra fields", async () => {
    // `requiredRoles` on a 403 and the simulation report on a blocked
    // publish are both delivered this way.
    setSessionToken("session-abc");
    respond(403, { error: "forbidden", requiredRoles: ["super_admin"] });

    const error = (await api.listGames().catch((e) => e)) as ApiError;

    assert.deepEqual(error.payload?.requiredRoles, ["super_admin"]);
  });
});

describe("request shape", () => {
  it("sends JSON with a content-type on every request", async () => {
    setSessionToken("session-abc");
    respond(200, { games: [] });
    await api.listGames();

    assert.equal(recorded[0].headers["content-type"], "application/json");
  });

  it("sends no body on a GET", async () => {
    setSessionToken("session-abc");
    respond(200, { games: [] });
    await api.listGames();

    assert.equal(recorded[0].body, undefined);
    assert.equal(recorded[0].method, "GET");
  });

  it("sends an empty object rather than nothing on a bodyless POST", async () => {
    // Uniformity: the API tolerates an absent body, but a POST with no body
    // at all is refused by some proxies and by Fastify's content-type
    // parser — the same 415 the backend route tests ran into.
    setSessionToken("session-abc");
    respond(200, { loggedOut: true });
    await api.logout();

    assert.equal(recorded[0].method, "POST");
    assert.equal(recorded[0].body, "{}");
  });

  it("sends a cleared field as an explicit null, since undefined does not survive JSON", async () => {
    /*
     * F25, and the assertion is on the **bytes** deliberately — that is
     * where the bug lived. `JSON.stringify({assets: undefined})` is `{}`,
     * so a cleared field and an untouched one left the browser identical,
     * and the API reads an absent key as "leave unchanged". Artwork could
     * be set and then never cleared: the editor emptied the field, the save
     * reported success, and the next reload brought the artwork back.
     *
     * Asserting on the serialised body rather than on the argument is what
     * makes this test able to fail — the object handed to `saveDraft` was
     * always correct.
     */
    setSessionToken("session-abc");
    respond(200, { draft: {}, valid: true, errors: [] });
    await api.saveDraft("g1", { assets: undefined });

    assert.deepEqual(JSON.parse(recorded[0].body as string), { assets: null });
  });

  it("says nothing about a field a save does not mention", async () => {
    // The complement, and what keeps per-field saving safe: only a key that
    // is present-and-undefined becomes a null. Converting absent keys too
    // would make every one-field save clear the rest of the draft.
    setSessionToken("session-abc");
    respond(200, { draft: {}, valid: true, errors: [] });
    await api.saveDraft("g1", { name: "Renamed" });

    const body = JSON.parse(recorded[0].body as string);
    assert.deepEqual(body, { name: "Renamed" });
    assert.equal("assets" in body, false, "an unmentioned field must not be nulled");
  });

  it("url-encodes a game id, so an id with a slash cannot escape its path", async () => {
    // A gameId is user-supplied at creation. Without encoding, "a/b" would
    // address a different route entirely.
    setSessionToken("session-abc");
    respond(200, { draft: null, published: null });
    await api.getGame("weird/id?x=1");

    assert.ok(
      recorded[0].url.endsWith("/v1/games/weird%2Fid%3Fx%3D1"),
      `expected an encoded id, got ${recorded[0].url}`,
    );
  });
});
