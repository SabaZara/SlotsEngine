import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "./app.js";
import { escapeHtml } from "./pages.js";
import type { IntegrationClient } from "./client.js";

/**
 * The demo's own behaviour.
 *
 * The two things worth testing here are not "does it render" but:
 *
 *  1. **The operator's secret never reaches the browser.** Everything
 *     signed happens server-side. A demo that leaked the credential into a
 *     page would be teaching the opposite of the lesson it exists for.
 *  2. **A designer-entered game name is escaped.** Game names come from
 *     `GET /v1/games` as free text and are interpolated into markup — the
 *     one genuine injection surface this app has.
 *
 * What these cannot establish: that integration-api accepts what the client
 * sends. That is `npm run e2e:operator`.
 */

const GAMES = [{ gameId: "reference-5x3", name: "Reference 5x3" }];

function stubClient(overrides: Partial<Record<keyof IntegrationClient, unknown>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ok = <T,>(method: string, body: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ ok: true, status: 200, body });
    };

  const client = {
    listGames: ok("listGames", { games: GAMES }),
    cashIn: ok("cashIn", { balance: 100_000, alreadyProcessed: false }),
    balance: ok("balance", { balance: 100_000 }),
    launch: ok("launch", {
      token: "signed-token",
      expiresAt: Date.now() + 60_000,
      launchUrl: "http://localhost:9104/?token=signed-token",
    }),
    ...overrides,
  } as unknown as IntegrationClient;

  return { client, calls };
}

function app(overrides: Partial<Record<keyof IntegrationClient, unknown>> = {}) {
  const { client, calls } = stubClient(overrides);
  return {
    instance: buildApp({ client, operatorId: "demo-op", topUpAmount: 100_000, newId: () => "fixed-id" }),
    calls,
  };
}

describe("the lobby", () => {
  it("offers exactly the games the operator may launch", async () => {
    const { instance } = app();
    const response = await instance.inject({ method: "GET", url: "/" });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("reference-5x3"));
  });

  it("escapes a game name, which is designer-entered free text", async () => {
    // The injection surface. A name is typed into the backoffice and
    // arrives here as-is; nothing between validates it as markup-safe.
    const hostile = '<script>alert("xss")</script>';
    const { instance } = app({
      listGames: () => Promise.resolve({ ok: true, status: 200, body: { games: [{ gameId: "g", name: hostile }] } }),
    });

    const response = await instance.inject({ method: "GET", url: "/" });

    assert.equal(response.body.includes("<script>alert"), false, "the raw tag must not reach the page");
    assert.ok(response.body.includes("&lt;script&gt;"), "it must appear escaped instead");
  });

  it("degrades to a text field when the game list cannot be loaded", async () => {
    // "We could not ask" and "you have no games" are different answers.
    // An empty dropdown states the second while meaning the first.
    const { instance } = app({
      listGames: () => Promise.resolve({ ok: false, status: 503, body: {} }),
    });

    const response = await instance.inject({ method: "GET", url: "/" });

    assert.equal(response.statusCode, 200, "a down upstream must not take the lobby down");
    assert.ok(response.body.includes('name="gameId"'));
    assert.ok(response.body.toLowerCase().includes("could not load"));
  });

  it("survives the game list throwing outright", async () => {
    const { instance } = app({
      listGames: () => Promise.reject(new Error("connection refused")),
    });

    const response = await instance.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 200);
  });

  it("says so when the operator is entitled to nothing", async () => {
    // The most likely first-run state, and the one where a bare empty
    // dropdown would leave someone stuck. The page names the fix.
    const { instance } = app({
      listGames: () => Promise.resolve({ ok: true, status: 200, body: { games: [] } }),
    });

    const response = await instance.inject({ method: "GET", url: "/" });
    assert.ok(response.body.toLowerCase().includes("entitled to no published games"));
  });

  it("never puts the operator's secret in a page", async () => {
    // The property the whole server-side-signing design exists for. Asserted
    // against the rendered bytes rather than argued from the code.
    const { instance } = app();
    const response = await instance.inject({ method: "GET", url: "/" });

    assert.equal(response.body.includes("x-signature"), false);
    assert.equal(response.body.toLowerCase().includes("apisecret"), false);
  });
});

describe("launching", () => {
  it("tops the player up before handing off", async () => {
    // Order matters: a launch into a zero balance produces a game that can
    // only answer insufficient_funds.
    const { instance, calls } = app();

    await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=p1&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    assert.deepEqual(
      calls.map((c) => c.method),
      ["cashIn", "launch"],
    );
  });

  it("renders the game rather than redirecting, so a refresh re-launches", async () => {
    // The deliberate divergence from the reference, which redirects to a GET
    // carrying the launchUrl. That pattern depends on the game client
    // recovering a spent token from a stored session, and this repo's
    // client keeps its session token in memory only — so a refresh there
    // would show `invalid_token`.
    const { instance } = app();

    const response = await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=p1&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    assert.equal(response.statusCode, 200, "not a 303");
    assert.ok(response.body.includes("<iframe"), "the game is embedded, not linked");
    assert.ok(response.body.includes("token=signed-token"));
  });

  it("sends the top-up as an integer amount", async () => {
    // Money is always integer minor units. A float would be refused by the
    // wallet route with a 400 that reads as a demo bug.
    const { instance, calls } = app();

    await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=p1&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const amount = (calls.find((c) => c.method === "cashIn")!.args[0] as { amount: number }).amount;
    assert.equal(Number.isInteger(amount), true);
    assert.equal(amount, 100_000);
  });

  it("shows why a launch was refused instead of a blank failure", async () => {
    // The most common real refusal: entitlement. The upstream code is what
    // tells someone to go and grant the game.
    const { instance } = app({
      launch: () =>
        Promise.resolve({ ok: false, status: 403, body: { error: "game_not_enabled_for_operator" } }),
    });

    const response = await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=p1&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    assert.equal(response.statusCode, 502);
    assert.ok(response.body.includes("game_not_enabled_for_operator"));
  });

  it("does not launch when the top-up was refused", async () => {
    // Continuing past a failed top-up would hand a player into a game with
    // no money and a misleading error.
    const { instance, calls } = app({
      cashIn: () => Promise.resolve({ ok: false, status: 402, body: { error: "insufficient_funds" } }),
    });

    const response = await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=p1&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    assert.equal(response.statusCode, 502);
    assert.equal(calls.some((c) => c.method === "launch"), false, "the launch must not have been attempted");
  });

  it("refuses a submission missing a player or a game", async () => {
    const { instance, calls } = app();

    const response = await instance.inject({
      method: "POST",
      url: "/launch",
      payload: "playerId=&gameId=reference-5x3",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0, "nothing may be charged for an invalid submission");
  });

  it("sends someone who navigated to /launch back to the lobby", async () => {
    const { instance } = app();
    const response = await instance.inject({ method: "GET", url: "/launch" });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/");
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  });

  it("leaves ordinary text alone", () => {
    assert.equal(escapeHtml("Reference 5x3"), "Reference 5x3");
  });
});
