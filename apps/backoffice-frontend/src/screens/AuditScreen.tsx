import { useEffect, useState } from "react";
import { ApiError, api, type AuditEntry } from "../api.js";
import { Badge, Banner, Card, EmptyState } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

export function AuditScreen() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries((await api.audit({ limit: 200 })).entries);
      } catch (err) {
        // Designers can change games; only operations reviews who changed
        // what. A 403 here is the role split working, not a fault.
        setError(
          err instanceof ApiError && err.status === 403
            ? "The audit log is restricted to operations and administrators."
            : err instanceof ApiError
              ? err.message
              : String(err),
        );
      }
    })();
  }, []);

  return (
    <Card title="Audit log">
      {error && <Banner tone="warn">{error}</Banner>}
      {!error && entries === null && <EmptyState>Loading…</EmptyState>}
      {entries?.length === 0 && <EmptyState>Nothing recorded yet.</EmptyState>}

      {entries && entries.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: t.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 }}>
              <th style={{ textAlign: "left", padding: "6px 0" }}>When</th>
              <th style={{ textAlign: "left" }}>Action</th>
              <th style={{ textAlign: "left" }}>Entity</th>
              <th style={{ textAlign: "left" }}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.entryId} style={{ borderTop: `1px solid ${t.border}` }}>
                <td style={{ padding: "8px 0", color: t.muted, whiteSpace: "nowrap" }}>
                  {new Date(entry.timestamp).toLocaleString()}
                </td>
                <td style={{ fontFamily: t.mono, color: t.accent }}>{entry.action}</td>
                <td style={{ fontFamily: t.mono, color: t.muted }}>{entry.entityId}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {typeof entry.diff?.toVersion === "number" && (
                      <Badge tone="good">
                        v{String(entry.diff.fromVersion ?? "—")} → v{String(entry.diff.toVersion)}
                      </Badge>
                    )}
                    {typeof entry.diff?.resultRtp === "number" && (
                      <span style={{ fontFamily: t.mono, color: t.faint }}>
                        {((entry.diff.resultRtp as number) * 100).toFixed(2)}%
                      </span>
                    )}
                    {entry.diff?.forcedPastRtpTolerance === true && <Badge tone="bad">forced past RTP gate</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 11, color: t.faint, marginTop: 14 }}>
        Append-only. There is no route that edits or deletes an entry — a log its own users can rewrite answers no
        question worth asking.
      </div>
    </Card>
  );
}
