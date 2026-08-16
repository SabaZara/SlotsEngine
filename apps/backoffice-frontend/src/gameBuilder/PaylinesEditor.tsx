import type { GridSize, PaylinePath } from "@slots-engine/shared-types";
import { Badge, Button, EmptyState } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";
import { cycleCell, defaultPayline, effectiveLength, paylineWarning } from "./paylineGrid.js";

/**
 * Each payline is drawn as a miniature of the real grid, and edited by
 * clicking the cells it passes through.
 *
 * A designer thinks about a payline as a *shape* across the reels, so the
 * editor shows that shape. A table of row indices is the same data and far
 * harder to read: a zigzag is obvious as a picture and invisible as
 * `[1,2,1,0,1]`.
 */
export function PaylinesEditor({
  paylines,
  grid,
  onChange,
}: {
  paylines: PaylinePath[];
  grid: GridSize;
  onChange: (paylines: PaylinePath[]) => void;
}) {
  const update = (index: number, path: PaylinePath) =>
    onChange(paylines.map((existing, i) => (i === index ? path : existing)));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: t.muted }}>
          Click a cell to route the line through it; click it again to drop that reel.
          {" "}
          Each line is staked at <strong style={{ color: t.text }}>1/{paylines.length || 1}</strong> of the bet.
        </div>
        <Button onClick={() => onChange([...paylines, defaultPayline(grid.reels, grid.rows)])}>Add line</Button>
      </div>

      {paylines.length === 0 && <EmptyState>No paylines yet. A game needs at least one to pay anything.</EmptyState>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {paylines.map((path, index) => {
          const warning = paylineWarning(path);
          return (
            <div
              key={index}
              style={{
                border: `1px solid ${warning ? `${t.warn}55` : t.border}`,
                borderRadius: t.radiusSm,
                padding: 10,
                background: t.bg,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: t.muted }}>
                  Line {index + 1}
                  {!warning && (
                    <span style={{ color: t.faint }}> · {effectiveLength(path)} reels</span>
                  )}
                </span>
                <Button variant="ghost" onClick={() => onChange(paylines.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${grid.reels}, 1fr)`,
                  gap: 3,
                }}
              >
                {Array.from({ length: grid.rows }).flatMap((_, row) =>
                  Array.from({ length: grid.reels }).map((__, reel) => {
                    const active = path[reel] === row;
                    return (
                      <button
                        key={`${reel}-${row}`}
                        onClick={() => update(index, cycleCell(path, reel, row, grid.rows))}
                        style={{
                          gridColumn: reel + 1,
                          gridRow: row + 1,
                          aspectRatio: "1",
                          border: `1px solid ${active ? t.accent : t.border}`,
                          background: active ? `${t.accent}33` : "transparent",
                          borderRadius: 4,
                          cursor: "pointer",
                          padding: 0,
                        }}
                        aria-label={`Line ${index + 1}, reel ${reel + 1}, row ${row + 1}`}
                        aria-pressed={active}
                      />
                    );
                  }),
                )}
              </div>

              {warning && (
                <div style={{ fontSize: 11, color: t.warn, marginTop: 8 }}>{warning}</div>
              )}
            </div>
          );
        })}
      </div>

      {paylines.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12, color: t.faint }}>
          <Badge>Note</Badge>{" "}
          A paytable multiplier applies to a line&apos;s own stake, not the whole bet — with {paylines.length} lines, a
          3-of-a-kind paying 10 returns {(10 / paylines.length).toFixed(2)}× the total bet.
        </div>
      )}
    </div>
  );
}
