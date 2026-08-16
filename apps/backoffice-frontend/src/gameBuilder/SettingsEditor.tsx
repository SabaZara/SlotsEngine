import type { BonusModuleConfig, PaylineWinRule } from "@slots-engine/shared-types";
import type { GameDraft } from "../api.js";
import { Badge, Button, Field, NumberInput, Select, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/** The modules the engine actually ships. Free text would let a designer
 * reference a module that does not exist — accepted at publish (the API
 * cannot see the client registry) and then failing at spin time. */
const KNOWN_MODULES = ["wheel", "pick"];

function BetOptionsEditor({ betOptions, onChange }: { betOptions: number[]; onChange: (options: number[]) => void }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {betOptions.map((bet, index) => (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 92 }}>
              <NumberInput
                value={bet}
                step={100}
                min={1}
                onChange={(value) => onChange(betOptions.map((b, i) => (i === index ? value : b)))}
              />
            </div>
            <button
              onClick={() => onChange(betOptions.filter((_, i) => i !== index))}
              style={{ background: "none", border: "none", color: t.faint, cursor: "pointer", fontSize: 14 }}
              aria-label={`Remove bet option ${bet}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <Button onClick={() => onChange([...betOptions, (betOptions[betOptions.length - 1] ?? 100) * 2])}>
        Add bet option
      </Button>
      <div style={{ fontSize: 11, color: t.faint, marginTop: 6 }}>
        Integer minor units — <strong style={{ color: t.muted }}>100 means 1.00</strong>. Fractions are rejected: a
        float here would reach the ledger and corrupt a balance silently.
      </div>
    </div>
  );
}

function BonusModulesEditor({
  modules,
  onChange,
}: {
  modules: BonusModuleConfig[];
  onChange: (modules: BonusModuleConfig[]) => void;
}) {
  const update = (index: number, patch: Partial<BonusModuleConfig>) =>
    onChange(modules.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  return (
    <div>
      {modules.map((module, index) => (
        <div
          key={index}
          style={{ border: `1px solid ${t.border}`, borderRadius: t.radiusSm, padding: 10, marginBottom: 8 }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
            <div style={{ width: 150 }}>
              <Select
                value={module.moduleId}
                options={KNOWN_MODULES.map((id) => ({ value: id, label: id }))}
                onChange={(moduleId) => update(index, { moduleId })}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
              <input
                type="checkbox"
                checked={module.probabilityTrigger !== undefined}
                onChange={(e) =>
                  update(index, { probabilityTrigger: e.target.checked ? { chancePerSpin: 0.01 } : undefined })
                }
              />
              Random trigger
            </label>
            {module.probabilityTrigger && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
                <div style={{ width: 84 }}>
                  <NumberInput
                    value={module.probabilityTrigger.chancePerSpin}
                    step={0.005}
                    min={0}
                    onChange={(chancePerSpin) => update(index, { probabilityTrigger: { chancePerSpin } })}
                  />
                </div>
                per spin
              </label>
            )}
            <div style={{ marginLeft: "auto" }}>
              <Button variant="ghost" onClick={() => onChange(modules.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </div>
          </div>

          <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>
            Parameters <span style={{ color: t.faint }}>· validated by the module itself</span>
          </div>
          <TextInput
            mono
            value={JSON.stringify(module.params)}
            onChange={(value) => {
              // Free-form because each module defines its own parameters and
              // the API deliberately does not know their shapes. Invalid JSON
              // is ignored rather than thrown away, so a half-typed edit
              // doesn't wipe the field.
              try {
                update(index, { params: JSON.parse(value) as Record<string, unknown> });
              } catch {
                /* keep the previous value until the text parses */
              }
            }}
          />
        </div>
      ))}
      <Button onClick={() => onChange([...modules, { moduleId: KNOWN_MODULES[0], params: {} }])}>
        Add bonus module
      </Button>
    </div>
  );
}

export function SettingsEditor({
  draft,
  onChange,
}: {
  draft: GameDraft;
  onChange: (patch: Partial<GameDraft>) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
      <div>
        <Field label="Name">
          <TextInput value={draft.name} onChange={(name) => onChange({ name })} />
        </Field>

        <Field label="Grid" hint="Changing this reshapes every payline to match.">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ width: 78 }}>
              <NumberInput
                value={draft.grid.reels}
                step={1}
                min={1}
                onChange={(reels) => onChange({ grid: { ...draft.grid, reels } })}
              />
            </div>
            <span style={{ color: t.faint }}>×</span>
            <div style={{ width: 78 }}>
              <NumberInput
                value={draft.grid.rows}
                step={1}
                min={1}
                onChange={(rows) => onChange({ grid: { ...draft.grid, rows } })}
              />
            </div>
            <span style={{ fontSize: 12, color: t.faint }}>reels × rows</span>
          </div>
        </Field>

        <Field
          label="RTP target"
          hint="A fraction like 0.95, never a percentage. Publishing is refused if the measured return misses this by more than 0.05."
        >
          <div style={{ width: 110 }}>
            <NumberInput value={draft.rtpTarget} step={0.01} min={0} onChange={(rtpTarget) => onChange({ rtpTarget })} />
          </div>
        </Field>

        <Field label="Payline win rule">
          <Select<PaylineWinRule>
            value={draft.paylineWinRule ?? "sum"}
            options={[
              { value: "sum", label: "Sum — every winning line pays" },
              { value: "highestOnly", label: "Highest only — best line pays" },
            ]}
            onChange={(paylineWinRule) => onChange({ paylineWinRule })}
          />
        </Field>

        <Field label="Currency" hint="Display and denomination only — it does not partition wallets.">
          <div style={{ width: 110 }}>
            <TextInput mono value={draft.currency ?? "USD"} onChange={(currency) => onChange({ currency })} />
          </div>
        </Field>
      </div>

      <div>
        <Field label="Bet options">
          <BetOptionsEditor betOptions={draft.betOptions} onChange={(betOptions) => onChange({ betOptions })} />
        </Field>

        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, marginBottom: 6 }}>
            Bonus modules
          </div>
          <BonusModulesEditor
            modules={draft.bonusModules}
            onChange={(bonusModules) => onChange({ bonusModules })}
          />
          <div style={{ fontSize: 11, color: t.faint, marginTop: 8 }}>
            <Badge>Note</Badge> A bonus needs a trigger symbol or a random trigger to ever fire. The RTP preview
            estimates a bonus at a flat 20× the bet rather than playing it.
          </div>
        </div>
      </div>
    </div>
  );
}
