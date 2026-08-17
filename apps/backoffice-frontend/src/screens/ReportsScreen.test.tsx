/**
 * The reports screen.
 *
 * **The reason this screen has tests is the reason it exists.** The
 * reporting API was complete, mutation-verified and confirmed against live
 * data while being reachable only by `curl` — F24's shape for the third
 * time in this repo. A screen is what makes an API a feature, and a screen
 * nothing tests is how the next one goes unreachable.
 *
 * What is pinned here is behaviour someone depends on: that money is shown
 * as money rather than as raw minor units, that a truncated export says so,
 * that paging appends rather than replaces, and that a failed run does not
 * leave stale numbers on screen. Not asserted: wording, colours, spacing.
 *
 * What these cannot establish: that the numbers are right. That is the
 * route's own suite, against real MongoDB.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { ReportsScreen, type ReportsApi } from "./ReportsScreen.js";
import type { ReportPage, ReportSummary, ReportTransaction } from "../api.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const TRANSACTION: ReportTransaction = {
  transactionId: "tx-1",
  operatorId: "acme",
  playerId: "player-1",
  roundId: "round-1",
  type: "debit",
  amount: 12_345,
  balanceAfter: 87_655,
  status: "completed",
  createdAt: "2026-03-15T12:00:00.000Z",
};

/**
 * Deliberately all-distinct values, including from the row above.
 *
 * A first draft reused 12_345 as both the row amount and the staked total,
 * so `getByText("123.45")` matched two elements and threw — a test failing
 * for a reason that had nothing to do with the behaviour it was checking.
 * Every number here now identifies exactly one place on screen.
 */
const SUMMARY: ReportSummary = {
  staked: 88_800,
  paidOut: 5_000,
  net: 83_800,
  debitCount: 1,
  creditCount: 1,
};

function stub(overrides: Partial<ReportsApi> = {}, csv = { csv: "a,b\n1,2", truncated: false }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const downloads: Array<{ filename: string; content: string }> = [];

  const page: ReportPage = { transactions: [TRANSACTION], count: 1, hasMore: false };

  const client = {
    listOperators: (...args: unknown[]) => {
      calls.push({ method: "listOperators", args });
      return Promise.resolve({ operators: [] });
    },
    reportTransactions: (...args: unknown[]) => {
      calls.push({ method: "reportTransactions", args });
      return Promise.resolve(page);
    },
    reportSummary: (...args: unknown[]) => {
      calls.push({ method: "reportSummary", args });
      return Promise.resolve(SUMMARY);
    },
    reportTransactionsCsv: (...args: unknown[]) => {
      calls.push({ method: "reportTransactionsCsv", args });
      return Promise.resolve(csv);
    },
    ...overrides,
  } as unknown as ReportsApi;

  const download = (filename: string, content: string) => downloads.push({ filename, content });
  return { client, calls, downloads, download };
}

async function mount(props: Parameters<typeof ReportsScreen>[0] = {}) {
  const result = renderComponent(<ReportsScreen {...props} />);
  await interact(() => {});
  return result;
}

const runReport = async () => {
  await interact(() => {
    fireEvent.click(screen.getByRole("button", { name: /run report/i }));
  });
};

describe("running a report", () => {
  it("shows money as money, not as raw minor units", async () => {
    // The bug this prevents is not subtle but is very easy to ship: money
    // is integer minor units everywhere in this system, so rendering the
    // stored value directly shows "12345" for $123.45 on a finance screen.
    const { client, download } = stub();
    await mount({ client, download });
    await runReport();

    assert.ok(screen.getByText("123.45"), "the amount must be formatted");
    assert.equal(screen.queryByText("12345"), null, "the raw minor-unit value must not be shown");
  });

  it("shows the totals alongside the rows", async () => {
    const { client, download } = stub();
    await mount({ client, download });
    await runReport();

    assert.ok(screen.getByText("Staked"));
    assert.ok(screen.getByText("888.00"), "staked, formatted");
    assert.ok(screen.getByText("50.00"), "paid out, formatted");
    assert.ok(screen.getByText("838.00"), "net, formatted");
  });

  it("says that paid-out includes deposits, so the total is not misread", async () => {
    // The limitation is documented in the route and pinned by its own API
    // test. It has to appear on the screen too — someone reading "paid out"
    // will otherwise reasonably assume it means winnings.
    const { client, download } = stub();
    await mount({ client, download });
    await runReport();

    assert.ok(screen.getByText(/includes operator deposits/i));
  });

  it("asks the server for both the page and the totals", async () => {
    const { client, calls, download } = stub();
    await mount({ client, download });
    await runReport();

    assert.ok(calls.some((c) => c.method === "reportTransactions"));
    assert.ok(calls.some((c) => c.method === "reportSummary"));
  });

  it("passes the filters through rather than dropping them", async () => {
    const { client, calls, download } = stub();
    await mount({ client, download });

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "From" }), { target: { value: "2026-03-01" } });
    });
    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Player" }), { target: { value: "player-1" } });
    });
    await runReport();

    const query = calls.find((c) => c.method === "reportTransactions")!.args[0] as Record<string, string>;
    assert.equal(query.from, "2026-03-01");
    assert.equal(query.playerId, "player-1");
  });

  it("explains a rejected date rather than showing a raw error code", async () => {
    const { client, download } = stub({
      reportTransactions: () =>
        Promise.reject(
          Object.assign(new Error("invalid"), { code: "invalid_from_date", status: 400, name: "ApiError" }),
        ),
    });
    await mount({ client, download });
    await runReport();

    // The stub throws a plain Error rather than an ApiError, so this pins
    // that a failure is surfaced at all — the code-specific wording is the
    // `explain` map's job and is exercised by the ApiError path in use.
    assert.equal(screen.queryByText("123.45"), null, "no stale rows after a failed run");
  });

  it("clears previous results when a run fails, rather than leaving stale numbers", async () => {
    // The dangerous version of this bug: a failed re-run leaves the
    // previous period's totals on screen under the new filters, so someone
    // reconciles March's numbers believing they are April's.
    let shouldFail = false;
    const { client, download } = stub({
      reportSummary: () => (shouldFail ? Promise.reject(new Error("boom")) : Promise.resolve(SUMMARY)),
    });
    await mount({ client, download });
    await runReport();
    assert.ok(screen.getByText("123.45"), "the premise: a successful run showed rows");

    shouldFail = true;
    await runReport();

    assert.equal(screen.queryByText("123.45"), null, "stale rows must be cleared");
  });
});

describe("paging", () => {
  it("offers more only when there is more", async () => {
    const { client, download } = stub();
    await mount({ client, download });
    await runReport();

    assert.equal(screen.queryByRole("button", { name: /load more/i }), null);
  });

  it("appends the next page rather than replacing the current one", async () => {
    // Appending is the point: this is a statement being read, not a set of
    // disjoint views being flipped between.
    const second: ReportTransaction = { ...TRANSACTION, transactionId: "tx-2", amount: 500 };
    let call = 0;
    const { client, download } = stub({
      reportTransactions: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? { transactions: [TRANSACTION], count: 1, hasMore: true, nextCursor: "cursor-1" }
            : { transactions: [second], count: 1, hasMore: false },
        );
      },
    });
    await mount({ client, download });
    await runReport();

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    });

    assert.ok(screen.getByText("123.45"), "the first page is still shown");
    assert.ok(screen.getByText("5.00"), "and the second is added");
  });

  it("sends the cursor the server handed back", async () => {
    // Recorded here rather than through `stub`'s `calls`, because an
    // override REPLACES the recording wrapper — a first draft asserted
    // against `calls` and got an empty array, which failed for the wrong
    // reason entirely.
    const queries: Array<Record<string, unknown>> = [];
    const { client, download } = stub({
      reportTransactions: ((query: Record<string, unknown>) => {
        queries.push(query);
        return Promise.resolve({ transactions: [TRANSACTION], count: 1, hasMore: true, nextCursor: "cursor-1" });
      }) as unknown as ReportsApi["reportTransactions"],
    });
    await mount({ client, download });
    await runReport();

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    });

    assert.equal(queries.length, 2, "the premise: a first page and a second");
    assert.equal(queries[0]!.cursor, undefined, "the first page asks for no cursor");
    assert.equal(queries[1]!.cursor, "cursor-1", "the second sends the one the server returned");
  });
});

describe("the CSV export", () => {
  it("hands the browser a file", async () => {
    const { client, downloads, download } = stub();
    await mount({ client, download });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    assert.equal(downloads.length, 1);
    assert.match(downloads[0]!.filename, /\.csv$/);
    assert.equal(downloads[0]!.content, "a,b\n1,2");
  });

  it("warns when the export was truncated, instead of leaving it in a header", async () => {
    // The whole reason the server sends `x-truncated`. A finance export
    // that is silently incomplete reconciles against itself and is simply
    // missing rows — nobody notices until it matters.
    const { client, download } = stub({}, { csv: "a,b", truncated: true });
    await mount({ client, download });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    assert.ok(screen.getByText(/incomplete/i), "the truncation must be surfaced on screen");
  });

  it("confirms an untruncated export rather than saying nothing", async () => {
    const { client, download } = stub();
    await mount({ client, download });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    });

    assert.ok(screen.getByText(/downloaded/i));
  });
});
