/**
 * Per-symbol presentation.
 *
 * The engine never sends colours or glyphs — a game definition describes
 * mathematics, not art — so the client derives a stable look from the
 * symbol id until real artwork exists. Kept separate from the renderer
 * because "an unknown symbol must still be visible" is a rule that can be
 * wrong, and it is not observable in a screenshot of the shipped game,
 * whose symbols are all known.
 */

export interface SymbolStyle {
  glyph: string;
  /** 24-bit RGB. Pixi tints take a number rather than a CSS string, and
   * converting at each draw call is how the two representations drift. */
  color: number;
  /** Whether this symbol should read as special: wilds and scatters carry
   * the game's meaning and a player must be able to find them instantly. */
  emphasis: boolean;
}

const STYLES: Record<string, SymbolStyle> = {
  ten: { glyph: "10", color: 0x7c93b8, emphasis: false },
  jack: { glyph: "J", color: 0x7c93b8, emphasis: false },
  queen: { glyph: "Q", color: 0x8d86c9, emphasis: false },
  king: { glyph: "K", color: 0xc98d86, emphasis: false },
  ace: { glyph: "A", color: 0xd4a05a, emphasis: false },
  cherry: { glyph: "🍒", color: 0xe05a6d, emphasis: false },
  plum: { glyph: "🍇", color: 0x9a6dd7, emphasis: false },
  bell: { glyph: "🔔", color: 0xf0c05a, emphasis: false },
  seven: { glyph: "7", color: 0xff5d5d, emphasis: false },
  wild: { glyph: "★", color: 0x4fd1ff, emphasis: true },
  scatter: { glyph: "◆", color: 0xffd166, emphasis: true },
  star: { glyph: "✦", color: 0xa78bfa, emphasis: true },
};

/**
 * A symbol the table does not know still gets a look.
 *
 * A new symbol should be *unremarkable*, never invisible. Falling back to
 * nothing would mean a game published with a symbol this build has not seen
 * renders empty cells — and since a game is data here, that is a publish
 * away rather than a deploy away. The colour is derived from the name so it
 * is stable across reloads and distinct between symbols; the glyph is the
 * first two characters, which is legible where a blank cell is not.
 */
export function styleFor(symbol: string): SymbolStyle {
  const known = STYLES[symbol];
  if (known) return known;

  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;

  return {
    glyph: symbol.slice(0, 2).toUpperCase() || "?",
    // Kept in the same lightness/saturation band as the known symbols, so
    // an unknown one reads as part of the set rather than as an error.
    color: hslToRgb(hash % 360, 0.55, 0.62),
    emphasis: false,
  };
}

/** HSL to packed RGB, so derived colours sit in the same numeric space as
 * the table's literals rather than being a second representation. */
export function hslToRgb(hue: number, saturation: number, lightness: number): number {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lightness - c / 2;
  const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}
