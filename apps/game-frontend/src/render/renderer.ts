import type { PublicGameView } from "../api.js";
import { DEFAULT_TIMING, blurAmount, reelStateAt, totalSpinDurationMs, type SpinTiming } from "./reelStrip.js";

/** Per-symbol presentation. The engine never sends colours or glyphs — a
 * game definition describes maths, not art — so the client derives a stable
 * look from the symbol id until real artwork exists. */
interface SymbolStyle {
  glyph: string;
  color: string;
}

const SYMBOL_STYLES: Record<string, SymbolStyle> = {
  ten: { glyph: "10", color: "#7c93b8" },
  jack: { glyph: "J", color: "#7c93b8" },
  queen: { glyph: "Q", color: "#8d86c9" },
  king: { glyph: "K", color: "#c98d86" },
  ace: { glyph: "A", color: "#d4a05a" },
  cherry: { glyph: "🍒", color: "#e05a6d" },
  plum: { glyph: "🍇", color: "#9a6dd7" },
  bell: { glyph: "🔔", color: "#f0c05a" },
  seven: { glyph: "7", color: "#ff5d5d" },
  wild: { glyph: "★", color: "#4fd1ff" },
  scatter: { glyph: "◆", color: "#ffd166" },
  star: { glyph: "✦", color: "#a78bfa" },
};

/** A symbol the styles above don't know: derive a stable colour from the
 * name rather than rendering nothing. A new symbol should look
 * unremarkable, never invisible. */
function styleFor(symbol: string): SymbolStyle {
  const known = SYMBOL_STYLES[symbol];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return { glyph: symbol.slice(0, 2).toUpperCase(), color: `hsl(${hash % 360}, 55%, 62%)` };
}

export interface WinLineHighlight {
  positions: Array<{ reel: number; row: number }>;
  symbol: string;
}

interface Layout {
  cell: number;
  gap: number;
  gridX: number;
  gridY: number;
  gridWidth: number;
  gridHeight: number;
}

/**
 * Canvas 2D renderer for the reel grid.
 *
 * Self-contained by design: no engine, no scene graph, no asset pipeline.
 * A slot client's rendering needs are narrow and well understood — a scrolling
 * strip, a settle, a highlight — and expressing them directly keeps the
 * whole visual layer inspectable in one file. It is also swappable: nothing
 * outside this class knows a canvas exists.
 */
export class GameRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private layout: Layout = { cell: 0, gap: 0, gridX: 0, gridY: 0, gridWidth: 0, gridHeight: 0 };

  /** What is shown when nothing is spinning. */
  private restingGrid: string[][];
  /** The strip each reel scrolls through mid-spin. Purely decorative: the
   * real outcome arrives from the server and is placed at rest. */
  private readonly filler: string[];

  private spinStartedAt: number | null = null;
  private pendingResult: string[][] | null = null;
  private timing: SpinTiming = DEFAULT_TIMING;
  private highlights: WinLineHighlight[] = [];
  private highlightPhase = 0;
  private frame = 0;
  private onSettled: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: PublicGameView,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser does not support the 2D canvas context");
    this.ctx = ctx;

    this.filler = game.symbols.map((s) => s.symbol);
    this.restingGrid = Array.from({ length: game.grid.reels }, (_, reel) =>
      Array.from({ length: game.grid.rows }, (_, row) => this.filler[(reel + row) % this.filler.length]),
    );

    this.resize();
    window.addEventListener("resize", this.resize);
    this.frame = requestAnimationFrame(this.draw);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("resize", this.resize);
  }

  /**
   * Starts the reveal of an already-decided result.
   *
   * The result is passed in at the moment the spin begins, not when the
   * animation ends, because the server decided it before this was called.
   * The animation is a way of showing a settled fact — it can be
   * interrupted, sped up or skipped without any risk of showing something
   * other than what was actually paid.
   */
  spinTo(result: string[][], onSettled?: () => void): void {
    this.pendingResult = result;
    this.highlights = [];
    this.onSettled = onSettled ?? null;
    this.spinStartedAt = performance.now();
  }

  /** True while reels are still moving — the caller uses this to keep the
   * spin button disabled rather than tracking its own timer. */
  get isSpinning(): boolean {
    return this.spinStartedAt !== null;
  }

  /** Jumps straight to the settled result. A player who wants the outcome
   * now should never have to wait out an animation. */
  skipToResult(): void {
    if (!this.spinStartedAt || !this.pendingResult) return;
    this.restingGrid = this.pendingResult;
    this.pendingResult = null;
    this.spinStartedAt = null;
    this.onSettled?.();
    this.onSettled = null;
  }

  showWinLines(lines: WinLineHighlight[]): void {
    this.highlights = lines;
  }

  private readonly resize = (): void => {
    // Render at device resolution and scale down, so symbols stay sharp on
    // a high-DPI display instead of being upscaled from CSS pixels.
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const { reels, rows } = this.game.grid;
    const gap = Math.max(4, Math.round(Math.min(width, height) * 0.012));
    // Fit the grid to whichever axis is tighter, so the whole grid is always
    // visible rather than cropped on a narrow window.
    const cell = Math.floor(Math.min((width * 0.92 - gap * (reels - 1)) / reels, (height * 0.82 - gap * (rows - 1)) / rows));
    const gridWidth = cell * reels + gap * (reels - 1);
    const gridHeight = cell * rows + gap * (rows - 1);

    this.layout = {
      cell,
      gap,
      gridX: Math.round((width - gridWidth) / 2),
      gridY: Math.round((height - gridHeight) / 2),
      gridWidth,
      gridHeight,
    };
  };

  private readonly draw = (now: number): void => {
    this.frame = requestAnimationFrame(this.draw);

    const { width, height } = this.canvas;
    const ratio = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, width / ratio, height / ratio);
    this.drawBackground(width / ratio, height / ratio);

    if (this.spinStartedAt !== null) {
      this.drawSpinning(now - this.spinStartedAt);
    } else {
      this.drawResting();
      this.drawHighlights(now);
    }

    this.drawGridFrame();
  };

  private drawBackground(width: number, height: number): void {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#0d1220");
    gradient.addColorStop(1, "#05070f");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);
  }

  private drawSpinning(elapsed: number): void {
    const { reels, rows } = this.game.grid;
    let allStopped = true;

    for (let reel = 0; reel < reels; reel++) {
      const state = reelStateAt(elapsed, reel, this.timing);
      if (state.phase !== "stopped") allStopped = false;

      this.ctx.save();
      this.clipReel(reel);

      const blur = blurAmount(state);
      if (blur > 0) this.ctx.filter = `blur(${blur.toFixed(2)}px)`;

      // Draw one extra row above and below, so a symbol scrolling into or
      // out of the window is never clipped mid-glyph.
      const offset = state.offset;
      for (let row = -1; row <= rows; row++) {
        const index = Math.floor(offset) + row;
        const fraction = offset - Math.floor(offset);
        const symbol =
          state.phase === "stopped"
            ? this.settledSymbol(reel, row)
            : this.blendedSymbol(reel, row, index, state.settleProgress);
        if (symbol === null) continue;
        this.drawSymbol(reel, row - fraction, symbol, 1);
      }

      this.ctx.restore();
    }

    if (allStopped && this.pendingResult) {
      this.restingGrid = this.pendingResult;
      this.pendingResult = null;
      this.spinStartedAt = null;
      this.onSettled?.();
      this.onSettled = null;
    }
  }

  /**
   * Which symbol to draw mid-spin.
   *
   * Once a reel is far enough into its settle, it switches from filler to
   * the real result — so the symbols decelerating into view are the ones
   * that actually landed, and the reel never visibly swaps its contents at
   * the moment it stops.
   */
  private blendedSymbol(reel: number, row: number, index: number, settleProgress: number): string | null {
    if (settleProgress > 0.55 && row >= 0 && row < this.game.grid.rows) {
      return this.settledSymbol(reel, row);
    }
    const wrapped = ((index % this.filler.length) + this.filler.length) % this.filler.length;
    return this.filler[wrapped];
  }

  private settledSymbol(reel: number, row: number): string | null {
    if (row < 0 || row >= this.game.grid.rows) return null;
    const grid = this.pendingResult ?? this.restingGrid;
    return grid[reel]?.[row] ?? null;
  }

  private drawResting(): void {
    for (let reel = 0; reel < this.game.grid.reels; reel++) {
      for (let row = 0; row < this.game.grid.rows; row++) {
        const symbol = this.restingGrid[reel]?.[row];
        if (symbol) this.drawSymbol(reel, row, symbol, 1);
      }
    }
  }

  private clipReel(reel: number): void {
    const { cell, gap, gridX, gridY, gridHeight } = this.layout;
    this.ctx.beginPath();
    this.ctx.rect(gridX + reel * (cell + gap), gridY, cell, gridHeight);
    this.ctx.clip();
  }

  private drawSymbol(reel: number, row: number, symbol: string, alpha: number): void {
    const { cell, gap, gridX, gridY } = this.layout;
    const x = gridX + reel * (cell + gap);
    const y = gridY + row * (cell + gap);
    const style = styleFor(symbol);

    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    this.roundedRect(x, y, cell, cell, cell * 0.14);
    this.ctx.fill();

    this.ctx.fillStyle = style.color;
    this.ctx.font = `600 ${Math.round(cell * 0.42)}px system-ui, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(style.glyph, x + cell / 2, y + cell / 2);
    this.ctx.globalAlpha = 1;
  }

  private drawHighlights(now: number): void {
    if (this.highlights.length === 0) return;
    const { cell, gap, gridX, gridY } = this.layout;

    // A slow pulse rather than a static outline: a win that moves is far
    // easier to spot than one that doesn't, especially with several lines.
    this.highlightPhase = (Math.sin(now / 320) + 1) / 2;

    for (const line of this.highlights) {
      this.ctx.strokeStyle = styleFor(line.symbol).color;
      this.ctx.lineWidth = 2 + this.highlightPhase * 2;
      this.ctx.globalAlpha = 0.55 + this.highlightPhase * 0.45;

      for (const { reel, row } of line.positions) {
        this.roundedRect(
          gridX + reel * (cell + gap) + 2,
          gridY + row * (cell + gap) + 2,
          cell - 4,
          cell - 4,
          cell * 0.14,
        );
        this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1;
  }

  private drawGridFrame(): void {
    const { gridX, gridY, gridWidth, gridHeight } = this.layout;
    this.ctx.strokeStyle = "rgba(79, 209, 255, 0.18)";
    this.ctx.lineWidth = 1;
    this.roundedRect(gridX - 8, gridY - 8, gridWidth + 16, gridHeight + 16, 14);
    this.ctx.stroke();
  }

  private roundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.arcTo(x + width, y, x + width, y + height, radius);
    this.ctx.arcTo(x + width, y + height, x, y + height, radius);
    this.ctx.arcTo(x, y + height, x, y, radius);
    this.ctx.arcTo(x, y, x + width, y, radius);
    this.ctx.closePath();
  }

  /** Total animation length for the current grid — lets a caller schedule
   * what happens after the reveal without duplicating the timing maths. */
  get spinDurationMs(): number {
    return totalSpinDurationMs(this.timing, this.game.grid.reels);
  }
}
