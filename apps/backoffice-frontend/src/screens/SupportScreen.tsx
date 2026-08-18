import { useState } from "react";
import { formatMoney } from "@slots-engine/shared-types";
import { ApiError, api, type SupportLookup } from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, Field, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Answering "what happened to this player".
 *
 * One search, three answers: their balance, what money moved, and what they
 * actually played. Deliberately read-only — there is no adjustment control
 * here and there should not be, because correcting a balance is a ledger
 * movement and belongs on the money path with an idempotency key and an
 * audit trail, not on a support screen.
 */

function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err);
  if (err.code === "player_not_found") {
    return "No player with that ID under that operator. Check both — a player ID is only unique within one operator.";
  }
  return err.message;
}

function shortDate(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The counter for a period as it stands *now*.
 *
 * Takes the highest `periodKey` rather than the first row returned, because
 * the route sends recent history and a stale period must never be shown as
 * current usage — an agent reading yesterday's exhausted daily counter
 * would tell a player they are blocked when they are not. Keys are
 * zero-padded, which is exactly why they compare correctly as strings.
 *
 * Returns zeroes when a period has no counter at all: a limit set today for
 * a player who has not bet yet is not an error, it is an empty one.
 */
function currentUsage(
  rows: Array<{ period: string; periodKey: string; staked: number; won: number }>,
  period: string,
): { staked: number; won: number } {
  let latest: { periodKey: string; staked: number; won: number } | undefined;
  for (const row of rows) {
    if (row.period !== period) continue;
    if (!latest || row.periodKey > latest.periodKey) latest = row;
  }
  return { staked: latest?.staked ?? 0, won: latest?.won ?? 0 };
}

export interface SupportApi {
  supportLookup: typeof api.supportLookup;
}

export function SupportScreen({ client = api }: { client?: SupportApi }) {
  const [operatorId, setOperatorId] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [result, setResult] = useState<SupportLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      setResult(await client.supportLookup(operatorId.trim(), playerId.trim()));
    } catch (err) {
      setError(explain(err));
      // Cleared, so a failed search never leaves the previous player's data
      // on screen under a new search box — which is how someone ends up
      // reading one customer's history while talking to another.
      setResult(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Player lookup</h2>
        <p style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>
          Read-only. Balance, recent money movements and recent rounds for one player.
        </p>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}

      <Card title="Find a player">
        <Field label="Operator ID" hint="A player ID is only unique within one operator, so both are required.">
          <TextInput label="Operator ID" value={operatorId} onChange={setOperatorId} placeholder="acme-casino" />
        </Field>
        <Field label="Player ID" hint="As the operator knows them.">
          <TextInput label="Player ID" value={playerId} onChange={setPlayerId} placeholder="player-1234" />
        </Field>
        <Button disabled={!operatorId.trim() || !playerId.trim() || searching} onClick={() => void search()}>
          {searching ? "Looking up…" : "Look up"}
        </Button>
      </Card>

      {result && (
        <>
          <Card title="Balance">
            <div style={{ fontSize: 24 }}>{formatMoney(result.player.balance)}</div>
            <p style={{ color: t.muted, fontSize: 12, marginTop: 4 }}>
              {result.player.playerId} · {result.player.operatorId}
            </p>
          </Card>

          <Card title="Play limits">
            {/* Placed directly under the balance because it answers the
                question a healthy balance otherwise makes unanswerable:
                "I have money, why was I refused?" An agent without this
                sees funds and no reason, which is how a limit working
                correctly turns into a complaint. */}
            {/* Above the table, because it changes how the numbers below
                should be read — and outside the empty check, since a player
                whose pending change *clears* every limit has none in force
                and still has something scheduled. */}
            {result.pendingLimitChange && (
              <Banner tone="warn">
                A change to these limits takes effect {shortDate(new Date(result.pendingLimitChange.effectiveAt).toISOString())}.
                Until then the limits below are what apply.
              </Banner>
            )}
            {result.limits.length === 0 ? (
              <EmptyState>No limits set. This player can stake any amount.</EmptyState>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: t.muted }}>
                      <th style={cell}>Period</th>
                      <th style={cell}>Max stake</th>
                      <th style={cell}>Staked</th>
                      <th style={cell}>Max loss</th>
                      <th style={cell}>Net loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.limits.map((limit) => {
                      const usage = currentUsage(result.limitUsage, limit.period);
                      // Floored at zero for the same reason the server
                      // floors it: a player who is ahead has lost nothing,
                      // and a negative figure here reads as a credit.
                      const lost = Math.max(0, usage.staked - usage.won);
                      return (
                        <tr key={limit.period} style={{ borderTop: `1px solid ${t.border}` }}>
                          <td style={cell}>{limit.period}</td>
                          <td style={cell}>{limit.maxStake === undefined ? "—" : formatMoney(limit.maxStake)}</td>
                          <td style={cell}>
                            {formatMoney(usage.staked)}
                            {limit.maxStake !== undefined && usage.staked >= limit.maxStake && (
                              <>
                                {" "}
                                <Badge tone="warn">reached</Badge>
                              </>
                            )}
                          </td>
                          <td style={cell}>{limit.maxLoss === undefined ? "—" : formatMoney(limit.maxLoss)}</td>
                          <td style={cell}>
                            {formatMoney(lost)}
                            {limit.maxLoss !== undefined && lost >= limit.maxLoss && (
                              <>
                                {" "}
                                <Badge tone="warn">reached</Badge>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p style={{ color: t.muted, fontSize: 12, marginTop: 8 }}>
                  Limits are set by the operator, not here — this screen is read-only. Usage shown is for the current
                  period and resets on its own.
                </p>
              </div>
            )}
          </Card>

          <Card title={`Recent transactions${result.truncated.transactions ? ` (latest ${result.limit})` : ""}`}>
            {/* The truncation notice is shown rather than inferred from the
                row count. A list of exactly the limit is ambiguous between
                "that is all" and "there are more", and an agent reading the
                second as the first tells a customer something untrue. */}
            {result.truncated.transactions && (
              <Banner tone="warn">
                Showing only the latest {result.limit}. Use Reports for this player's full history.
              </Banner>
            )}
            {result.recentTransactions.length === 0 ? (
              <EmptyState>No money has moved for this player.</EmptyState>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: t.muted }}>
                      <th style={cell}>When</th>
                      <th style={cell}>Type</th>
                      <th style={cell}>Amount</th>
                      <th style={cell}>Balance after</th>
                      <th style={cell}>Round</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.recentTransactions.map((row) => (
                      <tr key={row.transactionId} style={{ borderTop: `1px solid ${t.border}` }}>
                        <td style={cell}>{shortDate(row.createdAt)}</td>
                        <td style={cell}>
                          <Badge tone={row.type === "credit" ? "good" : "neutral"}>{row.type}</Badge>
                        </td>
                        <td style={cell}>{formatMoney(row.amount)}</td>
                        <td style={cell}>{formatMoney(row.balanceAfter)}</td>
                        <td style={cell}>{row.roundId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={`Recent rounds${result.truncated.rounds ? ` (latest ${result.limit})` : ""}`}>
            {result.recentRounds.length === 0 ? (
              <EmptyState>This player has not spun.</EmptyState>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: t.muted }}>
                      <th style={cell}>When</th>
                      <th style={cell}>Game</th>
                      <th style={cell}>Bet</th>
                      <th style={cell}>Status</th>
                      <th style={cell}>Seed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.recentRounds.map((round) => (
                      <tr key={round.roundId} style={{ borderTop: `1px solid ${t.border}` }}>
                        <td style={cell}>{shortDate(round.createdAt)}</td>
                        <td style={cell}>
                          {round.gameId} <span style={{ color: t.muted }}>v{round.gameVersion}</span>
                        </td>
                        <td style={cell}>{formatMoney(round.totalBet)}</td>
                        <td style={cell}>{round.status}</td>
                        {/* The seed and algorithm are shown because "was
                            that spin fair" is the second question support
                            gets, and a round is replayable from exactly
                            these two values. Hiding them would make every
                            fairness query need a developer. */}
                        <td style={{ ...cell, fontFamily: "monospace", color: t.muted }} title={round.rngAlgorithm}>
                          {round.seed.slice(0, 16)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: "6px 10px", whiteSpace: "nowrap" };
