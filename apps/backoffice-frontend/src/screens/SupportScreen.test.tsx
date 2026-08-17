/**
 * The player lookup screen.
 *
 * The behaviours pinned here are the ones a support agent would be misled
 * by if they broke: that a failed search clears the previous player rather
 * than leaving their data under a new search box, that a capped list says
 * it is capped, and that both identifiers are required — a player ID is
 * only unique within one operator, so a lookup missing the operator would
 * be answering about someone else.
 *
 * Not asserted: wording, colours, spacing.
 *
 * What these cannot establish: that the data is scoped correctly. That is
 * the route's own suite, which tests it against a real collision — the same
 * player ID existing under two operators with different balances.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { SupportScreen, type SupportApi } from "./SupportScreen.js";
import type { SupportLookup } from "../api.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const LOOKUP: SupportLookup = {
  // Every money value here is distinct, including between the balance and
  // the row's balanceAfter, and between a transaction amount and a round's
  // bet. A first draft reused them and `getByText` matched two elements,
  // failing for a reason unrelated to the behaviour under test.
  player: { operatorId: "acme", playerId: "player-1", balance: 123_400 },
  recentTransactions: [
    {
      transactionId: "tx-1",
      operatorId: "acme",
      playerId: "player-1",
      roundId: "round-1",
      type: "debit",
      amount: 5_000,
      balanceAfter: 98_700,
      status: "completed",
      createdAt: "2026-03-15T12:00:00.000Z",
    },
  ],
  recentRounds: [
    {
      roundId: "round-1",
      gameId: "reference-5x3",
      gameVersion: 3,
      totalBet: 2_500,
      seed: "abcdef0123456789deadbeef",
      rngAlgorithm: "xoshiro256ss-d16",
      status: "resolved",
      createdAt: "2026-03-15T12:00:00.000Z",
    },
  ],
  truncated: { transactions: false, rounds: false },
  limit: 50,
};

function stub(result: SupportLookup | Error = LOOKUP) {
  const queries: Array<[string, string]> = [];
  const client = {
    supportLookup: (operatorId: string, playerId: string) => {
      queries.push([operatorId, playerId]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  } as unknown as SupportApi;
  return { client, queries };
}

async function mount(client: SupportApi) {
  const result = renderComponent(<SupportScreen client={client} />);
  await interact(() => {});
  return result;
}

async function searchFor(operatorId: string, playerId: string) {
  await interact(() => {
    fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: operatorId } });
  });
  await interact(() => {
    fireEvent.change(screen.getByRole("textbox", { name: "Player ID" }), { target: { value: playerId } });
  });
  await interact(() => {
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));
  });
}

describe("searching", () => {
  it("requires both an operator and a player", async () => {
    // A player ID is only unique within one operator. Searching without the
    // operator would either fail or — worse — answer about a different
    // person with the same ID.
    const { client, queries } = stub();
    await mount(client);

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /look up/i }));
    });
    assert.equal(queries.length, 0, "nothing is looked up without both");

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Player ID" }), { target: { value: "player-1" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /look up/i }));
    });
    assert.equal(queries.length, 0, "a player alone is not enough");
  });

  it("sends both identifiers, trimmed", async () => {
    // Trimmed because these are pasted from a support ticket more often
    // than typed, and a trailing space would produce "no such player" for a
    // player who exists.
    const { client, queries } = stub();
    await mount(client);
    await searchFor("  acme  ", "  player-1  ");

    assert.deepEqual(queries[0], ["acme", "player-1"]);
  });
});

describe("what it shows", () => {
  it("shows the balance as money, not as raw minor units", async () => {
    const { client } = stub();
    await mount(client);
    await searchFor("acme", "player-1");

    assert.ok(screen.getByText("1234.00"), "the balance must be formatted");
    assert.equal(screen.queryByText("123400"), null, "the raw value must not be shown");
  });

  it("shows recent transactions and rounds", async () => {
    const { client } = stub();
    await mount(client);
    await searchFor("acme", "player-1");

    assert.ok(screen.getByText("reference-5x3"));
    assert.ok(screen.getByText("50.00"), "the movement amount, formatted");
    assert.ok(screen.getByText("25.00"), "and the round's bet");
  });

  it("shows the seed, so a fairness question is answerable without a developer", async () => {
    // The second question support gets, after "where is my money". A round
    // is replayable from the seed and algorithm alone.
    const { client } = stub();
    await mount(client);
    await searchFor("acme", "player-1");

    assert.ok(screen.getByText(/abcdef0123456789/), "the seed must be visible");
  });

  it("says when it is showing only part of the history", async () => {
    // A list of exactly the limit is ambiguous between "that is all" and
    // "there are more". An agent reading the second as the first tells a
    // customer something untrue.
    const { client } = stub({ ...LOOKUP, truncated: { transactions: true, rounds: false } });
    await mount(client);
    await searchFor("acme", "player-1");

    assert.ok(screen.getByText(/showing only the latest 50/i));
  });

  it("does not claim truncation when it is showing everything", async () => {
    const { client } = stub();
    await mount(client);
    await searchFor("acme", "player-1");

    assert.equal(screen.queryByText(/showing only the latest/i), null);
  });

  it("says so plainly when a player has no history", async () => {
    const { client } = stub({ ...LOOKUP, recentTransactions: [], recentRounds: [] });
    await mount(client);
    await searchFor("acme", "player-1");

    assert.ok(screen.getByText(/no money has moved/i));
    assert.ok(screen.getByText(/has not spun/i));
  });
});

describe("when the lookup fails", () => {
  it("clears the previous player rather than leaving them on screen", async () => {
    // The failure worth preventing: an agent searches a second customer,
    // the search fails, and the first customer's balance is still displayed
    // under the new search box — so they answer the wrong person's question
    // with the wrong person's data.
    let shouldFail = false;
    const client = {
      supportLookup: () => (shouldFail ? Promise.reject(new Error("nope")) : Promise.resolve(LOOKUP)),
    } as unknown as SupportApi;

    await mount(client);
    await searchFor("acme", "player-1");
    assert.ok(screen.getByText("1234.00"), "the premise: a successful search showed a balance");

    shouldFail = true;
    await searchFor("acme", "player-2");

    assert.equal(screen.queryByText("1234.00"), null, "the previous player must be cleared");
  });
});
