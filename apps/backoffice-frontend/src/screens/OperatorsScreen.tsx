import { useEffect, useState } from "react";
import { ApiError, api, type GameListEntry, type ManagedOperator } from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, Field, Select, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/** Turns a server error code into something a person can act on. A raw code
 * is accurate and useless; these say what to do instead. */
function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err);
  switch (err.code) {
    case "operator_already_exists":
      return "An operator with that ID already exists. Pick a different one.";
    case "invalid_integration_type":
      return "Integration type must be direct or reverse.";
    case "invalid_enabled_game_ids":
      return "The enabled games list must be a list of game IDs.";
    case "operatorId_required":
      return "An operator ID is required.";
    case "name_required":
      return "A name is required.";
    case "nothing_to_update":
      return "Nothing changed.";
    default:
      return err.message;
  }
}

/**
 * The credential, shown once.
 *
 * This is the only place in the backoffice that displays an operator's
 * secret, and it can never be shown again — the stored copy is encrypted
 * and no route returns it. So the panel is deliberately hard to dismiss by
 * accident: it does not disappear on a re-render, on a background refresh,
 * or when the create form resets. Closing it is an explicit act, and the
 * button says what closing costs.
 */
function SecretPanel({
  operatorId,
  apiKeyId,
  apiSecret,
  onDismiss,
}: {
  operatorId: string;
  apiKeyId: string;
  apiSecret: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiSecret);
      setCopied(true);
    } catch {
      // A clipboard failure must not hide the secret — the value is on
      // screen and selectable regardless, which is the real fallback. A
      // thrown error here would unmount the one panel that can never be
      // reopened.
      setCopied(false);
    }
  };

  return (
    <Card title={`Credential for ${operatorId}`}>
      <Banner tone="warn">
        This secret is shown once and cannot be retrieved later. Copy it now — if it is lost, the only remedy is to
        rotate, which invalidates the credential the operator is using.
      </Banner>

      <Field label="Key ID" hint="Public. Sent as the X-Api-Key-Id header, and safe to share.">
        <code style={{ display: "block", padding: 8, background: t.bg, border: `1px solid ${t.border}`, fontSize: 12 }}>
          {apiKeyId}
        </code>
      </Field>

      <Field label="API secret" hint="Secret. Signs every request; treat it like a password.">
        <code
          data-testid="api-secret"
          style={{
            display: "block",
            padding: 8,
            background: t.bg,
            border: `1px solid ${t.border}`,
            fontSize: 12,
            wordBreak: "break-all",
          }}
        >
          {apiSecret}
        </code>
      </Field>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy secret"}</Button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            aria-label="I have stored this secret"
          />
          I have stored this secret
        </label>
        {/* Disabled until acknowledged: dismissing is irreversible, and a
            mis-click here costs a rotation. */}
        <Button variant="ghost" disabled={!acknowledged} onClick={onDismiss}>
          Done
        </Button>
      </div>
    </Card>
  );
}

/**
 * The subset of the API client this screen uses.
 *
 * Injected rather than imported directly so the screen can be mounted in a
 * test without a network or a module mock. That is not a testing
 * convenience bolted on afterwards: this is the screen through which
 * credentials are issued, and F24's lesson is that the UI path is exactly
 * where a feature turns out to be unreachable. A screen that cannot be
 * mounted in a test is a screen nobody checks.
 */
export interface OperatorsApi {
  listOperators: typeof api.listOperators;
  listGames: typeof api.listGames;
  createOperator: typeof api.createOperator;
  updateOperator: typeof api.updateOperator;
  rotateOperatorSecret: typeof api.rotateOperatorSecret;
}

/** Asks before an irreversible action. Injectable for the same reason as
 * `OperatorsApi` — `window.confirm` cannot be answered from a test, and a
 * rotation guarded by a dialog nothing can drive is a rotation nothing
 * tests. */
export type ConfirmFn = (message: string) => boolean;

export function OperatorsScreen({
  canManage,
  client = api,
  confirm = (message) => window.confirm(message),
}: {
  canManage: boolean;
  client?: OperatorsApi;
  confirm?: ConfirmFn;
}) {
  const [operators, setOperators] = useState<ManagedOperator[]>([]);
  const [games, setGames] = useState<GameListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [newOperatorId, setNewOperatorId] = useState("");
  const [newName, setNewName] = useState("");
  const [newIntegrationType, setNewIntegrationType] = useState<"direct" | "reverse">("direct");

  /** Held outside the list so a background refresh cannot clear it. */
  const [issued, setIssued] = useState<{ operatorId: string; apiKeyId: string; apiSecret: string } | null>(null);

  const refresh = async () => {
    try {
      const [operatorList, gameList] = await Promise.all([client.listOperators(), client.listGames()]);
      setOperators(operatorList.operators);
      setGames(gameList.games);
      setError(null);
    } catch (err) {
      setError(explain(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    try {
      const { operator } = await client.createOperator({
        operatorId: newOperatorId.trim(),
        name: newName.trim(),
        integrationType: newIntegrationType,
        // Entitlement starts empty and is granted afterwards, deliberately:
        // it makes granting a game a separate, visible act rather than
        // something buried in a create form nobody re-reads.
        enabledGameIds: [],
      });
      setIssued({ operatorId: operator.operatorId, apiKeyId: operator.apiKeyId, apiSecret: operator.apiSecret });
      setNewOperatorId("");
      setNewName("");
      await refresh();
    } catch (err) {
      setError(explain(err));
    }
  };

  const rotate = async (operatorId: string) => {
    // A rotation breaks the operator's live integration the moment it
    // returns, so it asks first. `confirm` rather than a bespoke modal:
    // this screen is used rarely by a handful of people, and a native
    // prompt is the one dialog that cannot be missed.
    if (!confirm(`Rotate ${operatorId}'s secret? Their current credential stops working immediately.`)) return;
    try {
      const { operator } = await client.rotateOperatorSecret(operatorId);
      setIssued({ operatorId: operator.operatorId, apiKeyId: operator.apiKeyId, apiSecret: operator.apiSecret });
      await refresh();
    } catch (err) {
      setError(explain(err));
    }
  };

  const setEnabled = async (operator: ManagedOperator, gameId: string, enabled: boolean) => {
    const next = enabled
      ? [...operator.enabledGameIds, gameId]
      : operator.enabledGameIds.filter((id) => id !== gameId);
    try {
      await client.updateOperator(operator.operatorId, { enabledGameIds: next });
      await refresh();
    } catch (err) {
      setError(explain(err));
    }
  };

  const setDisabled = async (operatorId: string, disabled: boolean) => {
    try {
      await client.updateOperator(operatorId, { disabled });
      await refresh();
    } catch (err) {
      setError(explain(err));
    }
  };

  if (loading) return <EmptyState>Loading operators…</EmptyState>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Operators</h2>
        <p style={{ color: t.muted, fontSize: 13, marginTop: 4 }}>
          The companies whose players spin these games. Each holds a signing credential issued here, and can launch only
          the games it has been granted.
        </p>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}

      {issued && (
        <SecretPanel
          operatorId={issued.operatorId}
          apiKeyId={issued.apiKeyId}
          apiSecret={issued.apiSecret}
          onDismiss={() => setIssued(null)}
        />
      )}

      {canManage && (
        <Card title="Add an operator">
          <Field label="Operator ID" hint="Stable identifier used on every round and transaction. It cannot be changed later.">
            <TextInput label="Operator ID" value={newOperatorId} onChange={setNewOperatorId} />
          </Field>
          <Field label="Name" hint="How this operator appears in this list.">
            <TextInput label="Name" value={newName} onChange={setNewName} />
          </Field>
          <Field
            label="Integration type"
            hint="Direct means they call us and we hold the wallet. Reverse is not implemented."
          >
            <Select
              label="Integration type"
              value={newIntegrationType}
              options={[
                { value: "direct", label: "Direct — they call us" },
                { value: "reverse", label: "Reverse — we call them (not implemented)" },
              ]}
              onChange={setNewIntegrationType}
            />
          </Field>
          <Button disabled={!newOperatorId.trim() || !newName.trim()} onClick={() => void create()}>
            Create operator
          </Button>
        </Card>
      )}

      {operators.length === 0 && <EmptyState>No operators yet. Nobody can launch a game until one exists.</EmptyState>}

      {operators.map((operator) => (
        <Card
          key={operator.operatorId}
          title={operator.name}
          actions={
            canManage ? (
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="ghost" onClick={() => void rotate(operator.operatorId)}>
                  Rotate secret
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void setDisabled(operator.operatorId, !operator.disabledAt)}
                >
                  {operator.disabledAt ? "Re-enable" : "Disable"}
                </Button>
              </div>
            ) : undefined
          }
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontSize: 12, color: t.muted }}>{operator.operatorId}</code>
            <Badge>{operator.integrationType}</Badge>
            {operator.disabledAt ? <Badge tone="bad">disabled</Badge> : <Badge tone="good">active</Badge>}
          </div>

          <Field label="Key ID" hint="The public half. The secret is never shown after it is issued.">
            <code style={{ fontSize: 12, color: t.muted }}>{operator.apiKeyId}</code>
          </Field>

          <Field label="Games this operator may launch" hint="A game must also be published before it can be launched.">
            {games.length === 0 ? (
              <span style={{ fontSize: 12, color: t.muted }}>No games exist yet.</span>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {games.map((game) => {
                  const on = operator.enabledGameIds.includes(game.gameId);
                  return (
                    <button
                      key={game.gameId}
                      disabled={!canManage}
                      aria-pressed={on}
                      onClick={() => void setEnabled(operator, game.gameId, !on)}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        border: `1px solid ${on ? t.accent : t.border}`,
                        background: on ? `${t.accent}22` : "transparent",
                        color: on ? t.text : t.muted,
                        fontSize: 11,
                        cursor: canManage ? "pointer" : "default",
                      }}
                    >
                      {game.name}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        </Card>
      ))}
    </div>
  );
}
