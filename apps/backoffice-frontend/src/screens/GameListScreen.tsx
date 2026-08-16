import { useEffect, useState } from "react";
import { ApiError, api, type GameListEntry } from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function GameListScreen({
  canEdit,
  onOpen,
}: {
  canEdit: boolean;
  onOpen: (gameId: string) => void;
}) {
  const [games, setGames] = useState<GameListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

  const load = async () => {
    try {
      setGames((await api.listGames()).games);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setError(null);
    try {
      await api.createGame(newId.trim(), newName.trim());
      setCreating(false);
      setNewId("");
      setNewName("");
      onOpen(newId.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "game_already_exists"
          ? "That game id is already taken. Ids are permanent — every round ever played references one."
          : err instanceof ApiError
            ? err.message
            : String(err),
      );
    }
  };

  return (
    <div>
      <Card
        title="Games"
        actions={canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>New game</Button> : undefined}
      >
        {error && <Banner tone="bad">{error}</Banner>}

        {creating && (
          <div style={{ border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusSm, padding: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ width: 200 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>Game id — permanent</div>
                <TextInput mono value={newId} onChange={setNewId} placeholder="cosmic-fruits" />
              </div>
              <div style={{ width: 220 }}>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>Display name</div>
                <TextInput value={newName} onChange={setNewName} placeholder="Cosmic Fruits" />
              </div>
              <Button variant="primary" onClick={() => void create()} disabled={!newId.trim() || !newName.trim()}>
                Create
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
            <div style={{ fontSize: 11, color: t.faint, marginTop: 8 }}>
              A new game starts from a working 5×3 skeleton, so it is valid before you change anything.
            </div>
          </div>
        )}

        {games === null && <EmptyState>Loading…</EmptyState>}
        {games?.length === 0 && <EmptyState>No games yet.</EmptyState>}

        {games && games.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: t.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 }}>
                <th style={{ textAlign: "left", padding: "6px 0" }}>Game</th>
                <th style={{ textAlign: "left" }}>Live version</th>
                <th style={{ textAlign: "left" }}>Draft</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {games.map((game) => (
                <tr key={game.gameId} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: "10px 0" }}>
                    <div>{game.name}</div>
                    <div style={{ fontSize: 11, color: t.faint, fontFamily: t.mono }}>{game.gameId}</div>
                  </td>
                  <td>
                    {game.publishedVersion === null ? (
                      <Badge>Never published</Badge>
                    ) : (
                      <Badge tone="good">v{game.publishedVersion} live</Badge>
                    )}
                  </td>
                  <td style={{ color: t.muted, fontSize: 12 }}>
                    {game.hasDraft ? `edited ${relativeTime(game.draftUpdatedAt)}` : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button onClick={() => onOpen(game.gameId)}>{canEdit ? "Open" : "View"}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div style={{ fontSize: 12, color: t.faint, lineHeight: 1.6 }}>
        Editing a draft never changes what players see. Publishing is the only thing that does — and it is refused if
        the game&apos;s measured return misses its declared target.
      </div>
    </div>
  );
}
