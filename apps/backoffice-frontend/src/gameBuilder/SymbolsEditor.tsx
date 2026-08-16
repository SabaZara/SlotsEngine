import type { BonusModuleConfig, GridSize, SymbolRole, SymbolRule } from "@slots-engine/shared-types";
import { Badge, Button, EmptyState, NumberInput, Select, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

const ROLES: Array<{ value: SymbolRole; label: string }> = [
  { value: "regular", label: "Regular — pays on a payline" },
  { value: "wild", label: "Wild — substitutes for others" },
  { value: "scatter", label: "Scatter — pays on count, anywhere" },
  { value: "bonusTrigger", label: "Bonus trigger — starts a bonus round" },
];

/** A new symbol of each role, pre-filled so it is immediately valid. A role
 * change that leaves a symbol invalid would be reported by the API on the
 * next save, which is a worse way to learn what a role requires. */
function defaultsForRole(role: SymbolRole, reels: number, modules: BonusModuleConfig[]): Partial<SymbolRule> {
  switch (role) {
    case "regular":
      return { paytable: { 3: 10, 4: 30, 5: 100 }, wildConfig: undefined, scatterConfig: undefined, bonusTriggerConfig: undefined };
    case "wild":
      return { wildConfig: { substitutesFor: "all-regular" }, scatterConfig: undefined, bonusTriggerConfig: undefined };
    case "scatter":
      return {
        scatterConfig: { multiplierOf: "totalBet", payout: { 3: 2, 4: 10, 5: 50 } },
        wildConfig: undefined,
        bonusTriggerConfig: undefined,
      };
    case "bonusTrigger":
      return {
        bonusTriggerConfig: { module: modules[0]?.moduleId ?? "", minCount: Math.min(3, reels) },
        wildConfig: undefined,
        scatterConfig: undefined,
      };
  }
}

function PaytableRow({
  label,
  hint,
  paytable,
  reels,
  onChange,
}: {
  label: string;
  hint: string;
  paytable: Record<number, number>;
  reels: number;
  onChange: (paytable: Record<number, number>) => void;
}) {
  // Counts from 3 upward: a 1- or 2-of-a-kind win is possible in the schema
  // but vanishingly rare in real games, and offering every count from 1
  // makes the common case harder to read.
  const counts = Array.from({ length: Math.max(0, reels - 2) }, (_, i) => i + 3);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>
        {label} <span style={{ color: t.faint }}>· {hint}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {counts.map((count) => (
          <label key={count} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 11, color: t.faint, fontFamily: t.mono }}>{count}×</span>
            <div style={{ width: 78 }}>
              <NumberInput
                value={paytable[count] ?? 0}
                step={1}
                min={0}
                onChange={(value) => {
                  const next = { ...paytable };
                  // Zero means "this count doesn't pay". Storing a 0 would
                  // be rejected by the API, which requires positive
                  // multipliers, so it is removed instead.
                  if (value > 0) next[count] = value;
                  else delete next[count];
                  onChange(next);
                }}
              />
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

export function SymbolsEditor({
  symbols,
  grid,
  bonusModules,
  onChange,
}: {
  symbols: SymbolRule[];
  grid: GridSize;
  bonusModules: BonusModuleConfig[];
  onChange: (symbols: SymbolRule[]) => void;
}) {
  const allReels = Array.from({ length: grid.reels }, (_, i) => i);
  const update = (index: number, patch: Partial<SymbolRule>) =>
    onChange(symbols.map((symbol, i) => (i === index ? { ...symbol, ...patch } : symbol)));

  const addSymbol = () => {
    // A distinct id by construction — a duplicate is rejected at publish,
    // and having to think of a unique name before seeing the row is friction
    // for no benefit.
    let n = symbols.length + 1;
    while (symbols.some((s) => s.symbol === `symbol${n}`)) n++;
    onChange([
      ...symbols,
      { symbol: `symbol${n}`, allowedReels: allReels, role: "regular", paytable: { 3: 10, 4: 30, 5: 100 } },
    ]);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: t.muted }}>
          A symbol&apos;s <strong style={{ color: t.text }}>role</strong> decides what the engine does with it.
          Frequency comes from the reel strips, never from here.
        </div>
        <Button onClick={addSymbol}>Add symbol</Button>
      </div>

      {symbols.length === 0 && <EmptyState>No symbols yet.</EmptyState>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {symbols.map((symbol, index) => {
          const duplicate = symbols.filter((s) => s.symbol === symbol.symbol).length > 1;
          return (
            <div
              key={index}
              style={{
                border: `1px solid ${duplicate ? `${t.bad}55` : t.border}`,
                borderRadius: t.radiusSm,
                padding: 12,
                background: t.bg,
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ width: 160 }}>
                  <TextInput mono value={symbol.symbol} onChange={(value) => update(index, { symbol: value })} />
                  {duplicate && <div style={{ fontSize: 11, color: t.bad, marginTop: 4 }}>Duplicate id</div>}
                </div>
                <div style={{ width: 260 }}>
                  <Select
                    value={symbol.role}
                    options={ROLES}
                    onChange={(role) =>
                      update(index, { role, ...defaultsForRole(role, grid.reels, bonusModules) } as Partial<SymbolRule>)
                    }
                  />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>
                    Allowed reels <span style={{ color: t.faint }}>· where it may land</span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {allReels.map((reel) => {
                      const on = symbol.allowedReels.includes(reel);
                      return (
                        <button
                          key={reel}
                          onClick={() =>
                            update(index, {
                              allowedReels: on
                                ? symbol.allowedReels.filter((r) => r !== reel)
                                : [...symbol.allowedReels, reel].sort((a, b) => a - b),
                            })
                          }
                          style={{
                            width: 30,
                            height: 26,
                            border: `1px solid ${on ? t.accent : t.border}`,
                            background: on ? `${t.accent}22` : "transparent",
                            color: on ? t.text : t.faint,
                            borderRadius: 4,
                            fontSize: 11,
                            fontFamily: t.mono,
                            cursor: "pointer",
                          }}
                        >
                          {reel + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => onChange(symbols.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </div>

              {symbol.role === "regular" && (
                <PaytableRow
                  label="Paytable"
                  hint="multiplier of this line's stake"
                  reels={grid.reels}
                  paytable={symbol.paytable ?? {}}
                  onChange={(paytable) => update(index, { paytable })}
                />
              )}

              {symbol.role === "wild" && (
                <div style={{ marginTop: 8, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
                    <input
                      type="checkbox"
                      checked={symbol.wildConfig?.expanding === true}
                      onChange={(e) =>
                        update(index, {
                          wildConfig: { substitutesFor: "all-regular", ...symbol.wildConfig, expanding: e.target.checked },
                        })
                      }
                    />
                    Expanding — fills its whole reel
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
                    Multiplier
                    <div style={{ width: 70 }}>
                      <NumberInput
                        value={symbol.wildConfig?.multiplier ?? 1}
                        step={1}
                        min={1}
                        onChange={(multiplier) =>
                          update(index, {
                            wildConfig: { substitutesFor: "all-regular", ...symbol.wildConfig, multiplier },
                          })
                        }
                      />
                    </div>
                  </label>
                  <span style={{ fontSize: 11, color: t.faint }}>
                    Substitutes for every regular symbol. Never a scatter or bonus trigger.
                  </span>
                </div>
              )}

              {symbol.role === "scatter" && (
                <PaytableRow
                  label="Scatter payout"
                  hint="multiplier of the WHOLE bet, by count anywhere on the grid"
                  reels={grid.reels}
                  paytable={symbol.scatterConfig?.payout ?? {}}
                  onChange={(payout) =>
                    update(index, { scatterConfig: { multiplierOf: "totalBet", ...symbol.scatterConfig, payout } })
                  }
                />
              )}

              {symbol.role === "bonusTrigger" && (
                <div style={{ marginTop: 8, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
                    Module
                    <div style={{ width: 180 }}>
                      <Select
                        value={symbol.bonusTriggerConfig?.module ?? ""}
                        options={
                          bonusModules.length > 0
                            ? bonusModules.map((m) => ({ value: m.moduleId, label: m.moduleId }))
                            : [{ value: "", label: "— add a bonus module first —" }]
                        }
                        onChange={(module) =>
                          update(index, {
                            bonusTriggerConfig: { minCount: 3, ...symbol.bonusTriggerConfig, module },
                          })
                        }
                      />
                    </div>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.muted }}>
                    Needs at least
                    <div style={{ width: 62 }}>
                      <NumberInput
                        value={symbol.bonusTriggerConfig?.minCount ?? 3}
                        step={1}
                        min={1}
                        onChange={(minCount) =>
                          update(index, {
                            bonusTriggerConfig: { module: "", ...symbol.bonusTriggerConfig, minCount },
                          })
                        }
                      />
                    </div>
                    on screen
                  </label>
                  {(symbol.bonusTriggerConfig?.minCount ?? 0) > grid.reels * grid.rows && (
                    <Badge tone="bad">More than the {grid.reels * grid.rows} positions — can never trigger</Badge>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
