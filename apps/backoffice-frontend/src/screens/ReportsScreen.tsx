import { useEffect, useState } from "react";
import { formatMoney } from "@slots-engine/shared-types";
import {
  ApiError,
  api,
  type ManagedOperator,
  type ReportPage,
  type ReportQuery,
  type ReportSummary,
  type ReportTransaction,
} from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, Field, Select, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Reading the money that moved.
 *
 * **This screen exists because the API without it was F24's shape.** The
 * reporting routes were built, mutation-verified and confirmed against live
 * data — and were reachable only by `curl`, which is to say not reachable
 * at all by the finance and support people they were built for. That is the
 * third time in this repo that a feature has been complete on the money
 * path and unreachable through the only interface anyone would use, so it
 * is worth naming plainly rather than filing as polish.
 */

function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err);
  switch (err.code) {
    case "invalid_from_date":
      return "The 'from' date could not be read. Use YYYY-MM-DD.";
    case "invalid_to_date":
      return "The 'to' date could not be read. Use YYYY-MM-DD.";
    case "invalid_date_range":
      return "The 'from' date is after the 'to' date.";
    case "invalid_cursor":
      return "That page link is no longer valid. Start the report again.";
    case "export_failed":
      return "The export could not be produced. Try a narrower date range.";
    default:
      return err.message;
  }
}

/** Money is integer minor units everywhere in this system, so rendering it
 * raw would show "12345" for £123.45. Formatted through the shared helper
 * rather than a local `/ 100`, which would be a second copy of a rule that
 * is not the same for every currency — JPY has no minor unit at all. */
function money(minorUnits: number): string {
  return formatMoney(minorUnits);
}

function shortDate(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

export interface ReportsApi {
  reportTransactions: typeof api.reportTransactions;
  reportSummary: typeof api.reportSummary;
  reportTransactionsCsv: typeof api.reportTransactionsCsv;
  listOperators: typeof api.listOperators;
}

/** Handing the browser a file. Injectable so a test can assert that a
 * download was offered without a real DOM download happening. */
export type DownloadFn = (filename: string, content: string) => void;

/**
 * Exported only so it can be tested. Every screen test injects a stub
 * `DownloadFn`, which is right for asserting *that* a download was offered
 * — and it left this function, the one that actually touches the DOM,
 * covered by nothing. Both bugs it carried (a detached anchor and a
 * same-tick revoke) lived in exactly that gap.
 */
export function browserDownload(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;

  // Appended before clicking. A detached anchor's click is ignored outright
  // by Firefox, so the export silently produced no file there while working
  // in Chrome — the kind of difference nobody notices until a user on the
  // wrong browser reports "the button does nothing".
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoked on a later task, NOT synchronously.
  //
  // The previous comment here claimed the click had already handed the blob
  // to the browser's download machinery. That is true in Chrome and not
  // guaranteed anywhere else: `click()` only *queues* the download, so
  // revoking in the same tick can invalidate the URL before the browser has
  // read it — producing a failed or zero-byte file while the screen reports
  // "Export downloaded." A financial export that silently does not arrive
  // is the same class of failure as one that arrives truncated.
  //
  // The delay is deliberately not zero: a `setTimeout(0)` still lands in
  // the same frame in some engines. Leaving the URL alive for a second
  // holds the file in memory for that second, which is the trade — and it
  // is the right one, because the alternative is losing the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function ReportsScreen({
  client = api,
  download = browserDownload,
}: {
  client?: ReportsApi;
  download?: DownloadFn;
}) {
  const [operators, setOperators] = useState<ManagedOperator[]>([]);
  const [operatorId, setOperatorId] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [page, setPage] = useState<ReportPage | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [rows, setRows] = useState<ReportTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    client
      .listOperators()
      .then((result) => setOperators(result.operators))
      // A failure here must not block the screen: the operator field falls
      // back to free text, and a report can still be run.
      .catch(() => setOperators([]));
  }, [client]);

  const query = (): ReportQuery => ({ operatorId, playerId, from, to });

  const run = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      // Both together — the summary is the answer to "how much", the page
      // is the answer to "which movements", and someone reconciling wants
      // both at once. Issued in parallel because neither depends on the
      // other.
      const [firstPage, totals] = await Promise.all([
        client.reportTransactions(query()),
        client.reportSummary(query()),
      ]);
      setPage(firstPage);
      setRows(firstPage.transactions);
      setSummary(totals);
    } catch (err) {
      setError(explain(err));
      setPage(null);
      setRows([]);
      setSummary(null);
    } finally {
      setRunning(false);
    }
  };

  const loadMore = async () => {
    if (!page?.nextCursor) return;
    try {
      const next = await client.reportTransactions({ ...query(), cursor: page.nextCursor });
      // Appended rather than replaced: the point of paging here is reading
      // a long statement, not flipping between disjoint views.
      setRows((current) => [...current, ...next.transactions]);
      setPage(next);
    } catch (err) {
      setError(explain(err));
    }
  };

  const exportCsv = async () => {
    try {
      const { csv, truncated } = await client.reportTransactionsCsv(query());
      download(`transactions-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      // Surfaced rather than left in a header nobody reads. A truncated
      // export that looks complete is the failure the server's signal
      // exists to prevent, and it only prevents it if someone is told.
      setNotice(
        truncated
          ? "That export hit the row ceiling and is incomplete — narrow the date range and export again."
          : "Export downloaded.",
      );
    } catch (err) {
      setError(explain(err));
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Reports</h2>
        <p style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>
          Every movement of money, by operator and date. Amounts are shown in the game's currency; the underlying values
          are integer minor units.
        </p>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {notice && <Banner tone="good">{notice}</Banner>}

      <Card title="Filters">
        <Field label="Operator" hint="Leave blank for every operator.">
          {operators.length > 0 ? (
            <Select
              label="Operator"
              value={operatorId}
              options={[
                { value: "", label: "All operators" },
                ...operators.map((operator) => ({ value: operator.operatorId, label: operator.name })),
              ]}
              onChange={setOperatorId}
            />
          ) : (
            <TextInput label="Operator" value={operatorId} onChange={setOperatorId} placeholder="operator-id" />
          )}
        </Field>

        <Field label="Player" hint="Optional. Narrows to one player under that operator.">
          <TextInput label="Player" value={playerId} onChange={setPlayerId} placeholder="player-id" />
        </Field>

        <Field label="From" hint="YYYY-MM-DD. Inclusive.">
          <TextInput label="From" value={from} onChange={setFrom} placeholder="2026-03-01" />
        </Field>

        <Field label="To" hint="YYYY-MM-DD. Inclusive.">
          <TextInput label="To" value={to} onChange={setTo} placeholder="2026-03-31" />
        </Field>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Button disabled={running} onClick={() => void run()}>
            {running ? "Running…" : "Run report"}
          </Button>
          <Button variant="ghost" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        </div>
      </Card>

      {summary && (
        <Card title="Totals">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <Total label="Staked" value={money(summary.staked)} hint={`${summary.debitCount} debits`} />
            <Total label="Paid out" value={money(summary.paidOut)} hint={`${summary.creditCount} credits`} />
            <Total label="Net" value={money(summary.net)} hint="Staked minus paid out" />
          </div>
          {/* Stated on screen, not only in the route's comments. Someone
              reading these totals will otherwise reasonably assume "paid
              out" means winnings. */}
          <p style={{ color: t.muted, fontSize: 12, marginTop: 12 }}>
            Paid out includes operator deposits as well as winnings — the ledger records both as credits, with no field
            separating them.
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <Card title={`Transactions (${rows.length}${page?.hasMore ? "+" : ""})`}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: t.muted }}>
                  <th style={cell}>When</th>
                  <th style={cell}>Player</th>
                  <th style={cell}>Type</th>
                  <th style={cell}>Amount</th>
                  <th style={cell}>Balance after</th>
                  <th style={cell}>Round</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.transactionId} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={cell}>{shortDate(row.createdAt)}</td>
                    <td style={cell}>{row.playerId}</td>
                    <td style={cell}>
                      <Badge tone={row.type === "credit" ? "good" : "neutral"}>{row.type}</Badge>
                    </td>
                    <td style={cell}>{money(row.amount)}</td>
                    <td style={cell}>{money(row.balanceAfter)}</td>
                    <td style={cell}>{row.roundId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {page?.hasMore && (
            <Button variant="ghost" onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
        </Card>
      )}

      {page && rows.length === 0 && (
        <EmptyState>No transactions matched. The filters ran — this period really is empty.</EmptyState>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: "6px 10px", whiteSpace: "nowrap" };

function Total({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div style={{ color: t.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, marginTop: 2 }}>{value}</div>
      <div style={{ color: t.muted, fontSize: 11, marginTop: 2 }}>{hint}</div>
    </div>
  );
}
