import { useEffect, useState } from "react";
import type { BonusModuleConfig, PaylineWinRule } from "@slots-engine/shared-types";
import { api, type GameDraft } from "../api.js";
import { Badge, Button, Field, NumberInput, Select, TextInput } from "../ui/primitives.js";
import { BonusParamsForm, type BonusParamSpec } from "./BonusParamsForm.js";
import { t } from "../ui/tokens.js";

/**
 * Last-resort list, used only when the registry has not arrived yet.
 *
 * This used to be *the* list, and it drifted the moment a third module
 * shipped: `freeSpins` was registered in the engine and could not be selected
 * by a designer at all. The real list now comes from `/v1/bonus-modules`,
 * which reads the engine registry itself.
 *
 * Free text is still the wrong answer, for the reason the original comment
 * gave — a module that does not exist publishes cleanly, because the API
 * cannot see this file, and then fails at spin time in front of a player.
 */
const FALLBACK_MODULES = ["wheel", "pick", "freeSpins"];

function BetOptionsEditor({ betOptions, onChange }: { betOptions: number[]; onChange: (options: number[]) => void }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {betOptions.map((bet, index) => (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 92 }}>
              {/* Numbered rather than named after the stake it holds. The
                  Remove button beside it says "Remove bet option 500"
                  because it acts on a value that exists; this box is where
                  a value is CHANGED, so labelling it "Bet option 500" would
                  announce the old amount while the player types the new
                  one. The position is the stable fact. */}
              <NumberInput
                label={`Bet option ${index + 1}`}
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
  available,
  schemas,
  onChange,
}: {
  modules: BonusModuleConfig[];
  /** From the engine registry, via /v1/bonus-modules. */
  available: string[];
  /** Each module's own parameter list, from the same route and the same
   * registry — see `BonusParamsForm` for why this is fetched rather than
   * written down here. */
  schemas: Record<string, BonusParamSpec[]>;
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
            <div style={{ width: 170 }}>
              <Select
                // Numbered, because the value IS the module id — naming it
                // after the current selection would announce the old module
                // while the designer picks a new one.
                label={`Bonus module ${index + 1}`}
                value={module.moduleId}
                // A draft can name a module this build does not have — saved
                // before the module was removed, or restored from an older
                // deployment. Its own id is kept as an option so the select
                // does not silently rewrite the draft to whatever happens to
                // be first, which would change what the game pays without
                // anyone choosing it.
                options={(available.includes(module.moduleId) ? available : [module.moduleId, ...available]).map(
                  (id) => ({ value: id, label: available.includes(id) ? id : `${id} — not in this build` }),
                )}
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
                    label={`Trigger chance per spin for ${module.moduleId}`}
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

          {/* Built from the module's own declared schema rather than a raw
              JSON blob. F24's follow-up: making a module selectable does not
              help if its parameters are undocumented anywhere a designer
              looks — and every module silently substitutes a default for
              anything malformed, so nothing downstream ever complains. */}
          <BonusParamsForm
            schema={schemas[module.moduleId] ?? []}
            params={module.params}
            onChange={(params) => update(index, { params })}
          />
        </div>
      ))}
      <Button onClick={() => onChange([...modules, { moduleId: available[0] ?? FALLBACK_MODULES[0], params: {} }])}>
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
  // Read once per mount from the engine registry. On failure the fallback
  // stands in rather than leaving the select empty — an editor that cannot
  // offer any module is worse than one offering a slightly stale list, and
  // the list only changes when the engine ships a new module.
  const [available, setAvailable] = useState<string[]>(FALLBACK_MODULES);
  /** Keyed by moduleId. Empty until the fetch lands, and an unknown module
   * resolves to `[]` — which `BonusParamsForm` renders as the raw JSON
   * editor, so a designer is never worse off than before the schema
   * existed. */
  const [schemas, setSchemas] = useState<Record<string, BonusParamSpec[]>>({});
  useEffect(() => {
    let cancelled = false;
    api
      .listBonusModules()
      .then(({ modules, schemas: fetched }) => {
        if (cancelled) return;
        if (modules.length > 0) setAvailable(modules);
        // Tolerated as absent rather than required: an older API build
        // serves `modules` without `schemas`, and the form degrades to the
        // JSON editor rather than the screen failing to render.
        if (fetched) setSchemas(Object.fromEntries(fetched.map((s) => [s.moduleId, s.params])));
      })
      .catch(() => {
        /* keep the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
      <div>
        <Field label="Name">
          <TextInput label="Name" value={draft.name} onChange={(name) => onChange({ name })} />
        </Field>

        <Field label="Grid" hint="Changing this reshapes every payline to match.">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ width: 78 }}>
              {/* Named individually because `Field` names the GROUP. The
                  "×" and "reels × rows" beside these boxes are visual cues
                  a screen reader never reaches, so without these labels the
                  two inputs are announced identically. */}
              <NumberInput
                label="Reels"
                value={draft.grid.reels}
                step={1}
                min={1}
                onChange={(reels) => onChange({ grid: { ...draft.grid, reels } })}
              />
            </div>
            <span style={{ color: t.faint }}>×</span>
            <div style={{ width: 78 }}>
              <NumberInput
                label="Rows"
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
            <NumberInput
              label="RTP target"
              value={draft.rtpTarget}
              step={0.01}
              min={0}
              onChange={(rtpTarget) => onChange({ rtpTarget })}
            />
          </div>
        </Field>

        <Field label="Payline win rule">
          <Select<PaylineWinRule>
            label="Payline win rule"
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
            <TextInput label="Currency" mono value={draft.currency ?? "USD"} onChange={(currency) => onChange({ currency })} />
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
            available={available}
            schemas={schemas}
            onChange={(bonusModules) => onChange({ bonusModules })}
          />
          <div style={{ fontSize: 11, color: t.faint, marginTop: 8 }}>
            <Badge>Note</Badge> A bonus needs a trigger symbol or a random trigger to ever fire. The RTP preview does
            not play the bonus out — it scores it from the module's own expected return, derived from these parameters
            where the module can compute it and assumed where it cannot.
          </div>
        </div>
      </div>
    </div>
  );
}
