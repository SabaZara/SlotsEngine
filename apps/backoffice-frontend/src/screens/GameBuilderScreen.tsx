import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type AuditEntry, type GameDraft } from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, Tabs } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";
import { reshapePaylines } from "../gameBuilder/paylineGrid.js";
import { SettingsEditor } from "../gameBuilder/SettingsEditor.js";
import { SymbolsEditor } from "../gameBuilder/SymbolsEditor.js";
import { ReelStripsEditor } from "../gameBuilder/ReelStripsEditor.js";
import { PaylinesEditor } from "../gameBuilder/PaylinesEditor.js";
import { AssetsEditor } from "../gameBuilder/AssetsEditor.js";
import { ThemeEditor } from "../gameBuilder/ThemeEditor.js";
import { MathPanel } from "../gameBuilder/MathPanel.js";

type TabId = "settings" | "symbols" | "reels" | "paylines" | "artwork" | "theme" | "math" | "history";

/** How long editing must pause before a save fires. Long enough that typing
 * a name is one save rather than twelve; short enough that a designer who
 * looks away for a moment has already been saved. */
const AUTOSAVE_DELAY_MS = 700;

export function GameBuilderScreen({
  gameId,
  canEdit,
  onBack,
}: {
  gameId: string;
  canEdit: boolean;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<GameDraft | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>("settings");
  const [valid, setValid] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ versions: Array<GameDraft & { version: number; publishedAt?: string }>; audit: AuditEntry[] } | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The latest edit, so a save that fires mid-typing sends current state
   * rather than whatever React had rendered when the timer was set. */
  const pending = useRef<GameDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const { draft: loaded, published } = await api.getGame(gameId);
      setPublishedVersion(published?.version ?? null);

      if (loaded) {
        setDraft(loaded);
      } else if (published) {
        // A published game with no draft: start one from what is live. That
        // is the natural way to edit a running game, rather than from blank.
        setDraft((await api.draftFromPublished(gameId)).draft);
      } else {
        setLoadError("That game no longer exists.");
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    }
  }, [gameId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState("saving");
    try {
      const result = await api.saveDraft(gameId, next);
      // The server's copy wins: it stamps updatedAt/updatedByUserId, and
      // letting the local object drift from it invites confusing diffs.
      setDraft(result.draft);
      setValid(result.valid);
      setErrors(result.errors);
      setSaveState("saved");
    } catch (err) {
      setSaveState("failed");
      setErrors([err instanceof ApiError ? err.message : String(err)]);
    }
  }, [gameId]);

  /**
   * Applies an edit locally and schedules a save.
   *
   * Local state updates immediately so typing never stutters on the network;
   * the save is debounced behind it. A draft saves even when invalid — the
   * API treats validity as a publish-time gate, so the errors that come back
   * are advisory here and blocking only at publish.
   */
  const edit = useCallback(
    (patch: Partial<GameDraft>) => {
      if (!canEdit) return;
      setDraft((current) => {
        if (!current) return current;
        let next = { ...current, ...patch };

        // A grid change invalidates every payline's shape. Reshaping here
        // rather than leaving it to the designer avoids the single most
        // common way a draft becomes unpublishable after a resize.
        if (patch.grid && (patch.grid.reels !== current.grid.reels || patch.grid.rows !== current.grid.rows)) {
          next = { ...next, paylines: reshapePaylines(next.paylines, patch.grid.reels, patch.grid.rows) };
        }

        pending.current = next;
        return next;
      });

      setSaveState("idle");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [canEdit, flush],
  );

  // A pending edit must not be lost when the screen closes.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flush();
    },
    [flush],
  );

  const loadHistory = useCallback(async () => {
    const [versions, audit] = await Promise.all([api.versions(gameId), api.audit({ entityId: gameId, limit: 50 })]);
    setHistory({ versions: versions.versions, audit: audit.entries });
  }, [gameId]);

  useEffect(() => {
    if (tab === "history") void loadHistory();
  }, [tab, loadHistory]);

  if (loadError) return <Banner tone="bad">{loadError}</Banner>;
  if (!draft) return <EmptyState>Loading…</EmptyState>;

  const saveLabel = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    failed: "Save failed",
  }[saveState];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Button variant="ghost" onClick={onBack}>
          ← Games
        </Button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{draft.name}</div>
          <div style={{ fontSize: 11, color: t.faint, fontFamily: t.mono }}>{draft.gameId}</div>
        </div>
        {publishedVersion === null ? <Badge>Never published</Badge> : <Badge tone="good">v{publishedVersion} live</Badge>}
        {valid ? <Badge tone="good">Valid</Badge> : <Badge tone="bad">{errors.length} problem{errors.length === 1 ? "" : "s"}</Badge>}
        <div style={{ marginLeft: "auto", fontSize: 12, color: saveState === "failed" ? t.bad : t.faint }}>
          {saveLabel}
        </div>
      </div>

      {!canEdit && (
        <Banner tone="warn">You have read-only access — changes here will not be saved.</Banner>
      )}

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "settings", label: "Settings" },
          { id: "symbols", label: "Symbols" },
          { id: "reels", label: "Reels" },
          { id: "paylines", label: "Paylines" },
          { id: "artwork", label: "Artwork" },
          { id: "theme", label: "Theme" },
          { id: "math", label: "Maths & publish", badge: !valid ? <Badge tone="bad">!</Badge> : undefined },
          { id: "history", label: "History" },
        ]}
      />

      <Card>
        {tab === "settings" && <SettingsEditor draft={draft} onChange={edit} />}
        {tab === "symbols" && (
          <SymbolsEditor
            symbols={draft.symbols}
            grid={draft.grid}
            bonusModules={draft.bonusModules}
            onChange={(symbols) => edit({ symbols })}
          />
        )}
        {tab === "reels" && (
          <ReelStripsEditor
            reelStrips={draft.reelStrips ?? []}
            grid={draft.grid}
            symbols={draft.symbols}
            onChange={(reelStrips) => edit({ reelStrips })}
          />
        )}
        {tab === "paylines" && (
          <PaylinesEditor paylines={draft.paylines} grid={draft.grid} onChange={(paylines) => edit({ paylines })} />
        )}
        {tab === "artwork" && (
          <AssetsEditor symbols={draft.symbols} assets={draft.assets} onChange={(assets) => edit({ assets })} />
        )}
        {tab === "theme" && <ThemeEditor theme={draft.theme} onChange={(theme) => edit({ theme })} />}
        {tab === "math" && (
          <MathPanel
            draft={draft}
            valid={valid && canEdit}
            errors={errors}
            onPublished={() => {
              void load();
              setHistory(null);
            }}
          />
        )}
        {tab === "history" && (
          <div>
            {!history && <EmptyState>Loading…</EmptyState>}
            {history && (
              <>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, marginBottom: 8 }}>
                  Published versions
                </div>
                {history.versions.length === 0 && <EmptyState>Never published.</EmptyState>}
                {history.versions.map((version) => (
                  <div
                    key={version.version}
                    style={{ display: "flex", gap: 12, padding: "7px 0", borderTop: `1px solid ${t.border}`, fontSize: 12 }}
                  >
                    <Badge tone={version.version === publishedVersion ? "good" : "neutral"}>v{version.version}</Badge>
                    <span style={{ color: t.muted }}>
                      {version.publishedAt ? new Date(version.publishedAt).toLocaleString() : "—"}
                    </span>
                    <span style={{ color: t.faint }}>
                      target {(version.rtpTarget * 100).toFixed(2)}% · {version.symbols.length} symbols ·{" "}
                      {version.paylines.length} lines
                    </span>
                  </div>
                ))}

                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, margin: "20px 0 8px" }}>
                  Activity
                </div>
                {history.audit.map((entry) => (
                  <div
                    key={entry.entryId}
                    style={{ display: "flex", gap: 12, padding: "7px 0", borderTop: `1px solid ${t.border}`, fontSize: 12 }}
                  >
                    <span style={{ fontFamily: t.mono, color: t.accent }}>{entry.action}</span>
                    <span style={{ color: t.muted }}>{new Date(entry.timestamp).toLocaleString()}</span>
                    {entry.diff?.forcedPastRtpTolerance === true && <Badge tone="bad">forced past RTP gate</Badge>}
                    {typeof entry.diff?.resultRtp === "number" && (
                      <span style={{ color: t.faint, fontFamily: t.mono }}>
                        {((entry.diff.resultRtp as number) * 100).toFixed(2)}%
                      </span>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
