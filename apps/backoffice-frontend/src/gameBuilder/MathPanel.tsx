import { useState } from "react";
import { ApiError, api, type GameDraft, type SimulationReport } from "../api.js";
import { Badge, Banner, Button, EmptyState } from "../ui/primitives.js";
import { rtpColor, t } from "../ui/tokens.js";

/** Mirrors the API's publish gate exactly. A UI that warned at a different
 * threshold than the server enforces would teach people to ignore it. */
const RTP_TOLERANCE = 0.05;

function Metric({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint: string;
  color?: string;
}) {
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: t.radiusSm, padding: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted }}>{label}</div>
      <div style={{ fontSize: 24, fontFamily: t.mono, color: color ?? t.text, margin: "4px 0 2px" }}>{value}</div>
      <div style={{ fontSize: 11, color: t.faint, lineHeight: 1.4 }}>{hint}</div>
    </div>
  );
}

/**
 * The tuning loop, and the publish gate.
 *
 * `rtpTarget` is what a designer *believes* the game returns; the simulation
 * is what it actually does. Showing both side by side is the whole point of
 * this panel — the gap between them is the thing worth looking at, and it is
 * also exactly what decides whether a publish is allowed.
 */
export function MathPanel({
  draft,
  valid,
  errors,
  onPublished,
}: {
  draft: GameDraft;
  valid: boolean;
  errors: string[];
  onPublished: () => void;
}) {
  const [report, setReport] = useState<SimulationReport | null>(null);
  const [busy, setBusy] = useState<"simulate" | "publish" | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "warn" | "bad"; text: string } | null>(null);
  /** Only offered after a publish has actually been refused — an override
   * that is always visible is an override people reach for by habit. */
  const [offerForce, setOfferForce] = useState(false);

  const simulate = async (simCount: number) => {
    setBusy("simulate");
    setMessage(null);
    try {
      const { simulation } = await api.simulate(draft.gameId, simCount);
      setReport(simulation);
      const drift = Math.abs(simulation.resultRtp - draft.rtpTarget);
      if (drift > RTP_TOLERANCE) {
        setMessage({
          tone: "bad",
          text: `Measured ${(simulation.resultRtp * 100).toFixed(2)}% against a ${(draft.rtpTarget * 100).toFixed(2)}% target — publishing will be refused until this is within ${RTP_TOLERANCE * 100}%.`,
        });
      }
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const publish = async (force: boolean) => {
    setBusy("publish");
    setMessage(null);
    try {
      const result = await api.publish(draft.gameId, force);
      setReport(result.simulation);
      setOfferForce(false);
      setMessage({
        tone: "good",
        text: `Published version ${result.gameDef.version}. It is live for players now, measuring ${(result.simulation.resultRtp * 100).toFixed(2)}%.`,
      });
      onPublished();
    } catch (err) {
      if (err instanceof ApiError && err.code === "rtp_out_of_tolerance") {
        // Surface the refusal's own simulation, so the designer sees the
        // number that blocked them without re-running anything.
        const blocked = err.payload?.simulation as SimulationReport | undefined;
        if (blocked) setReport(blocked);
        setOfferForce(true);
        setMessage({ tone: "bad", text: err.message });
      } else {
        setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : String(err) });
      }
    } finally {
      setBusy(null);
    }
  };

  const drift = report ? Math.abs(report.resultRtp - draft.rtpTarget) : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <Button onClick={() => void simulate(20_000)} disabled={busy !== null || !valid}>
          {busy === "simulate" ? "Running…" : "Quick preview (20k)"}
        </Button>
        <Button onClick={() => void simulate(100_000)} disabled={busy !== null || !valid}>
          Full run (100k)
        </Button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button variant="primary" onClick={() => void publish(false)} disabled={busy !== null || !valid}>
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
          {offerForce && (
            <Button variant="danger" onClick={() => void publish(true)} disabled={busy !== null}>
              Publish anyway
            </Button>
          )}
        </div>
      </div>

      {!valid && (
        <Banner tone="bad">
          <strong>This draft cannot be published yet.</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {errors.map((error, i) => (
              <li key={i} style={{ marginTop: 2 }}>
                {error}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {offerForce && (
        <div style={{ fontSize: 12, color: t.muted, marginBottom: 12 }}>
          Publishing anyway is recorded in the audit log as a deliberate override. It is the right choice only when the
          target itself is wrong — not when the paytable is.
        </div>
      )}

      {!report && <EmptyState>Run a simulation to measure what this game actually returns.</EmptyState>}

      {report && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <Metric
              label="Measured RTP"
              value={`${(report.resultRtp * 100).toFixed(2)}%`}
              color={rtpColor(report.resultRtp, draft.rtpTarget)}
              hint={`Target ${(draft.rtpTarget * 100).toFixed(2)}% · off by ${(drift * 100).toFixed(2)}pp`}
            />
            <Metric
              label="Base game"
              value={`${(report.baseRtp * 100).toFixed(2)}%`}
              hint="Return from ordinary spins"
            />
            <Metric
              label="Bonus"
              value={`${(report.bonusRtp * 100).toFixed(2)}%`}
              hint="Estimated at 20× the bet per trigger, not simulated"
            />
            <Metric
              label="Hit frequency"
              value={`${(report.hitFrequency * 100).toFixed(1)}%`}
              hint={`About 1 in ${(1 / Math.max(report.hitFrequency, 1e-9)).toFixed(1)} spins wins something`}
            />
            <Metric
              label="Volatility"
              value={report.volatilityIndex.toFixed(2)}
              hint="How swingy it feels. Independent of RTP."
            />
            <Metric
              label="Biggest win"
              value={`${report.maxWinMultiplier.toFixed(0)}×`}
              hint={`Largest seen across ${report.simCount.toLocaleString()} spins`}
            />
          </div>

          <div style={{ fontSize: 12, color: t.faint, marginTop: 12, lineHeight: 1.6 }}>
            <Badge>Reading this</Badge> A real game returns <em>less</em> than it takes — the gap is the business.
            RTP and volatility are independent: two games can both return 95% and feel completely different, one paying
            small amounts constantly and the other rarely but hugely. Moving return from the base game into the bonus
            makes a game spikier without changing what it pays overall.
          </div>
        </>
      )}
    </div>
  );
}
