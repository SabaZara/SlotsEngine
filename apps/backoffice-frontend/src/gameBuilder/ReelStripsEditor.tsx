import type { GridSize, ReelStrip, SymbolRule } from "@slots-engine/shared-types";
import { Badge, Button } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Reel strips ARE the game's maths.
 *
 * A symbol's frequency is simply how many times it appears on a strip, so
 * this screen is where RTP is really set — not the paytable, which only says
 * what a win is worth once it happens. The per-reel frequency readout exists
 * because that relationship is invisible in a flat list of symbols: a
 * designer needs to see that the top symbol appears twice in forty positions,
 * not count it.
 */
export function ReelStripsEditor({
  reelStrips,
  grid,
  symbols,
  onChange,
}: {
  reelStrips: ReelStrip[];
  grid: GridSize;
  symbols: SymbolRule[];
  onChange: (strips: ReelStrip[]) => void;
}) {
  const symbolIds = new Set(symbols.map((s) => s.symbol));

  const stripFor = (reel: number): ReelStrip =>
    reelStrips.find((s) => s.reelIndex === reel) ?? { reelIndex: reel, symbols: [] };

  const updateStrip = (reel: number, next: string[]) => {
    const others = reelStrips.filter((s) => s.reelIndex !== reel);
    onChange([...others, { reelIndex: reel, symbols: next }].sort((a, b) => a.reelIndex - b.reelIndex));
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: t.muted, marginBottom: 12 }}>
        One symbol per line. The RNG picks a stop and reads {grid.rows} consecutive symbols, wrapping at the end — so a
        symbol&apos;s <strong style={{ color: t.text }}>frequency on the strip is its real probability</strong>.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${grid.reels}, minmax(150px, 1fr))`, gap: 10 }}>
        {Array.from({ length: grid.reels }, (_, reel) => {
          const strip = stripFor(reel);
          const counts = new Map<string, number>();
          for (const symbol of strip.symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
          const unknown = strip.symbols.filter((s) => !symbolIds.has(s));
          const tooShort = strip.symbols.length > 0 && strip.symbols.length < grid.rows;

          return (
            <div key={reel} style={{ border: `1px solid ${t.border}`, borderRadius: t.radiusSm, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Reel {reel + 1}</span>
                <span style={{ fontSize: 11, color: t.faint, fontFamily: t.mono }}>{strip.symbols.length}</span>
              </div>

              <textarea
                value={strip.symbols.join("\n")}
                onChange={(e) =>
                  updateStrip(
                    reel,
                    e.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      // Blank lines are dropped rather than stored: an empty
                      // string is not a symbol and would fail validation with
                      // a confusing "undefined symbol ''" message.
                      .filter((line) => line.length > 0),
                  )
                }
                spellCheck={false}
                rows={12}
                style={{
                  width: "100%",
                  background: t.bg,
                  border: `1px solid ${unknown.length > 0 ? `${t.bad}55` : t.border}`,
                  borderRadius: 4,
                  color: t.text,
                  fontFamily: t.mono,
                  fontSize: 12,
                  padding: 8,
                  resize: "vertical",
                }}
              />

              {unknown.length > 0 && (
                <div style={{ fontSize: 11, color: t.bad, marginTop: 6 }}>
                  Unknown: {[...new Set(unknown)].join(", ")}
                </div>
              )}
              {tooShort && (
                <div style={{ fontSize: 11, color: t.bad, marginTop: 6 }}>
                  Shorter than the {grid.rows} visible rows.
                </div>
              )}

              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                {[...counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([symbol, count]) => (
                    <div key={symbol} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <span style={{ color: symbolIds.has(symbol) ? t.muted : t.bad, fontFamily: t.mono }}>{symbol}</span>
                      <span style={{ color: t.faint, fontFamily: t.mono }}>
                        {((count / strip.symbols.length) * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          onClick={() => {
            // Copies reel 1 across every reel — the usual starting point,
            // since most games differentiate reels only after tuning.
            const first = stripFor(0).symbols;
            onChange(Array.from({ length: grid.reels }, (_, reel) => ({ reelIndex: reel, symbols: [...first] })));
          }}
        >
          Copy reel 1 to all
        </Button>
        <span style={{ fontSize: 11, color: t.faint }}>
          <Badge>Tip</Badge> Restricting a high-value symbol to the middle reels is the usual lever for holding the top
          end down without making wins feel rare.
        </span>
      </div>
    </div>
  );
}
