import { Application, Assets, BlurFilter, Container, Graphics, Sprite, Text, TextStyle, type Texture } from "pixi.js";
import type { PublicGameView } from "../api.js";
import {
  DEFAULT_TIMING,
  blurAmount,
  reelStateAt,
  spinningSymbolAt,
  totalSpinDurationMs,
  type SpinTiming,
} from "./reelStrip.js";
import {
  GRID_FRAME_PADDING_PX,
  computeBlurStrength,
  computeGridMetrics,
  heavyEffectsAllowed,
  measurementSource,
  shouldForceSettle,
  wrapIndex,
  type GridMetrics,
} from "./spinMotion.js";
import { styleFor } from "./symbolStyle.js";
import { shouldWarnAboutAssets, summariseLoad, symbolImageUrl } from "./symbolAssets.js";

export interface WinLineHighlight {
  positions: Array<{ reel: number; row: number }>;
  symbol: string;
}

/**
 * One grid cell: real artwork if the game has any, a derived glyph if not.
 *
 * Both objects exist for every cell and exactly one is visible. Artwork is
 * optional per *symbol*, not per game, so a single game can legitimately mix
 * the two — and swapping display-list children per frame is what makes a
 * sprite renderer stutter.
 */
interface SymbolCell {
  text: Text;
  sprite: Sprite;
}

/**
 * The reel grid, drawn with Pixi.
 *
 * **This class deliberately contains no arithmetic that can be wrong.**
 * Every decision — cell size, wrapping, blur strength, phase timing — is
 * delegated to `spinMotion.ts` and `reelStrip.ts`, which are pure and
 * tested. What is left here is sprite creation, positioning and teardown,
 * and the reason for that split is measured rather than stylistic: `jsdom`
 * returns `null` for both the `webgl2` and `2d` contexts, so a live
 * `Application` cannot be constructed in a test at all. Logic left in this
 * file would be logic no test could reach.
 *
 * The property inherited from the canvas renderer and preserved here:
 * **reel state is a pure function of elapsed time.** Each frame recomputes
 * absolute positions from the clock rather than advancing from wherever the
 * previous frame left off, so a dropped frame cannot desynchronise the
 * reels and the settle order holds however frames land.
 *
 * What has *not* changed, and must not: the outcome is decided server-side
 * before any of this runs. The animation reveals a settled fact, which is
 * why skipping it is always safe and why nothing here can affect fairness.
 */
export class PixiReelRenderer {
  private readonly app = new Application();
  private readonly root = new Container();
  private readonly frame = new Graphics();
  private readonly highlightLayer = new Graphics();
  /** One container per reel, each clipped to its column. */
  private readonly reels: Container[] = [];
  /** The symbol cells inside each reel, reused across frames rather than
   * recreated — allocating text objects every frame is what makes a
   * sprite renderer stutter. */
  private readonly cells: SymbolCell[][] = [];
  /** Symbol id → loaded artwork. A symbol absent here draws its glyph, which
   * is the ordinary case: no fixture in this repo ships artwork. */
  private readonly textures = new Map<string, Texture>();
  private readonly blurs: BlurFilter[] = [];

  private metrics: GridMetrics;
  private ready = false;
  private destroyed = false;

  private restingGrid: string[][];
  private readonly filler: string[];
  private pendingResult: string[][] | null = null;
  /** The grid on screen when the current spin began, so the first frames
   * continue from it rather than jumping to filler. */
  private outgoingGrid: string[][] | null = null;
  private spinStartedAt: number | null = null;
  private timing: SpinTiming = DEFAULT_TIMING;
  private highlights: WinLineHighlight[] = [];
  private onSettled: (() => void) | null = null;
  /** Previous frame's offset per reel, so blur is derived from real
   * measured movement rather than from an assumed speed. */
  private readonly lastOffset: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: PublicGameView,
  ) {
    this.filler = game.symbols.map((s) => s.symbol);
    this.restingGrid = Array.from({ length: game.grid.reels }, (_, reel) =>
      Array.from({ length: game.grid.rows }, (_, row) => this.filler[(reel + row) % this.filler.length] ?? "?"),
    );
    // Provisional only — `layout()` recomputes from the real box as soon as
    // `init()` resolves. Present so the fields are never undefined if a
    // draw somehow lands first.
    this.metrics = computeGridMetrics(game.grid, canvas.clientWidth || 800, canvas.clientHeight || 600, 10, 0.94, 0.92);
  }

  /**
   * Pixi 8 initialises asynchronously, so construction and readiness are
   * separate. Awaited by the caller before any draw, and guarded on
   * `destroyed` because a player can navigate away mid-initialisation —
   * resolving into a destroyed renderer would attach a ticker to nothing.
   */
  async init(): Promise<void> {
    await this.app.init({
      canvas: this.canvas,
      // Deliberately NOT `resizeTo`. It writes width/height attributes onto
      // the canvas, which override the stylesheet's `width: 100%` and pin
      // the element at its first measured size — see `layout()` for the bug
      // that produced. Sizing is driven from the CSS box instead, so the
      // stylesheet stays the one authority on how large the canvas is.
      antialias: true,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }

    this.app.stage.addChild(this.root);
    await this.loadArtwork();
    this.buildGrid();
    this.root.addChild(this.frame, this.highlightLayer);
    this.app.ticker.add(this.draw);
    // Driven from the window rather than from the renderer's own resize
    // event: with `resizeTo` removed the renderer only resizes because
    // `layout` told it to, so listening to it would be listening to this
    // class's own echo.
    window.addEventListener("resize", this.layout);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.ready = true;
    this.layout();
  }

  /**
   * Loads whatever artwork the game configures, and tolerates all of it
   * being absent or broken.
   *
   * **A missing picture must never hide a symbol.** Every failure here falls
   * back to the derived glyph rather than propagating: a game with no assets
   * (every fixture in this repo), a symbol absent from the map, a URL that
   * 404s, or a whole asset host being down. A blank cell on a reel a player
   * is being paid on is a worse failure than an ugly one, because the player
   * cannot tell what they won.
   *
   * Loaded in parallel and awaited as a group, so one slow asset delays the
   * others rather than serialising behind them — and `Promise.all` over
   * individually-caught promises never rejects, which is what keeps a single
   * bad URL from failing `init()` and dropping the player to the
   * graphics-failed screen.
   */
  private async loadArtwork(): Promise<void> {
    const symbols = this.game.symbols.map((s) => s.symbol);

    await Promise.all(
      symbols.map(async (symbol) => {
        const url = symbolImageUrl(this.game.assets, symbol, window.location.href);
        if (!url) return;
        try {
          this.textures.set(symbol, await Assets.load(url));
        } catch {
          // Falls through to the glyph. An uploaded URL that has since gone
          // missing must not blank the symbol out.
        }
      }),
    );

    const report = summariseLoad(
      symbols,
      (symbol) => symbolImageUrl(this.game.assets, symbol, window.location.href) !== null,
      (symbol) => this.textures.has(symbol),
    );
    // Warned about only when artwork was *asked for* and did not arrive.
    // Every game here ships none, so warning on absence would be a warning
    // nobody reads by the second day — while a whole asset host being down
    // renders placeholders everywhere and looks like a styling choice.
    if (shouldWarnAboutAssets(report)) {
      console.warn(
        `[slots] ${report.failed.length} of ${report.requested} symbol images failed to load; ` +
          `drawing placeholders for: ${report.failed.join(", ")}`,
      );
    }
  }

  /**
   * Draws one cell as artwork or as a glyph.
   *
   * One place decides, so the resting and spinning paths cannot disagree
   * about which representation a symbol gets — a symbol that renders as art
   * at rest and as a letter mid-spin would read as the reels changing their
   * contents as they stop.
   */
  private paintCell(cell: SymbolCell, symbol: string, y: number, cellSize: number): void {
    const texture = this.textures.get(symbol);
    cell.sprite.visible = texture !== undefined;
    cell.text.visible = texture === undefined;

    if (texture) {
      if (cell.sprite.texture !== texture) cell.sprite.texture = texture;
      // Fitted to the cell rather than stretched, so art with a different
      // aspect ratio is letterboxed instead of distorted — a squashed symbol
      // is harder to recognise, and recognising symbols is the whole job.
      const scale = Math.min(cellSize / texture.width, cellSize / texture.height) * 0.86;
      cell.sprite.scale.set(scale);
      cell.sprite.x = cellSize / 2;
      cell.sprite.y = y;
      return;
    }

    const style = styleFor(symbol);
    if (cell.text.text !== style.glyph) cell.text.text = style.glyph;
    cell.text.tint = style.color;
    cell.text.x = cellSize / 2;
    cell.text.y = y;
  }

  private buildGrid(): void {
    const { reels, rows } = this.game.grid;
    for (let reel = 0; reel < reels; reel++) {
      const column = new Container();
      // Own mask per column, so a symbol scrolling out of the window is
      // clipped at the grid edge rather than drawn over the chrome.
      const mask = new Graphics();
      column.mask = mask;
      this.root.addChild(column, mask);
      this.reels.push(column);

      const blur = new BlurFilter({ strength: 0 });
      // Vertical only: reels move on one axis, and blurring horizontally
      // smears a symbol into its neighbours for no motion that exists.
      blur.strengthX = 0;
      column.filters = [blur];
      this.blurs.push(blur);
      this.lastOffset.push(0);

      // One extra cell above and below, so a symbol entering or leaving the
      // window is never clipped mid-glyph.
      const columnCells: SymbolCell[] = [];
      for (let row = -1; row <= rows; row++) {
        const text = new Text({ text: "", style: new TextStyle({ fontSize: 32, fill: 0xffffff, fontWeight: "600" }) });
        text.anchor.set(0.5);
        // Both a sprite and a glyph per cell, with exactly one visible.
        // Kept as a pair rather than swapped in and out of the display list
        // because a symbol's artwork can be missing for one symbol and
        // present for its neighbour, and rebuilding the tree per frame is
        // what makes a sprite renderer stutter.
        const sprite = new Sprite();
        sprite.anchor.set(0.5);
        sprite.visible = false;
        column.addChild(sprite, text);
        columnCells.push({ text, sprite });
      }
      this.cells.push(columnCells);
    }
  }

  /**
   * Recomputes geometry and repositions everything, on every resize.
   *
   * **Measured from the canvas's PARENT, never from the canvas itself.**
   * That is not a stylistic choice — measuring the canvas creates a
   * feedback loop that pins the grid at Pixi's default size forever, and
   * it was found by running the game rather than by reading the code.
   *
   * Pixi's `autoDensity` writes an inline `style.width`/`style.height` onto
   * the canvas (measured: `width: 800px; height: 600px`), and an inline
   * style beats the stylesheet's `width: 100%`. So the canvas stops
   * following its container, `clientWidth` reports Pixi's own last value
   * rather than the available space, and every later layout re-derives the
   * same 800x600 from the number Pixi just wrote. The grid then centres
   * perfectly inside a box that is itself stuck in the corner of a
   * 1280x596 `<main>` — correct arithmetic on the wrong input, which is why
   * it looks like a centring bug and is not one.
   *
   * The parent's box is set by the stylesheet and nothing writes to it, so
   * it is the one measurement Pixi cannot feed back into.
   */
  private readonly layout = (): void => {
    if (this.destroyed) return;

    const box = measurementSource(this.canvas) as HTMLElement;
    const width = box.clientWidth;
    const height = box.clientHeight;
    // Nothing to lay out into a zero-sized box, and dividing by it produces
    // a grid of zero area that never recovers on a later resize.
    if (width <= 0 || height <= 0) return;

    // Keeps the drawing buffer in step with the CSS box. Pixi applies the
    // resolution multiplier itself via `autoDensity`.
    this.app.renderer.resize(width, height);

    // The canvas *is* the play area — the header and footer are separate
    // DOM elements outside it — so the grid may use nearly all of it. The
    // margins left are for the frame and its glow, not for chrome.
    this.metrics = computeGridMetrics(this.game.grid, width, height, 10, 0.94, 0.92);

    const { cell, reelGap, originX, originY, gridWidth, gridHeight } = this.metrics;

    for (let reel = 0; reel < this.reels.length; reel++) {
      const x = originX + reel * (cell + reelGap);
      const column = this.reels[reel];
      column.position.set(x, originY);

      const mask = column.mask as Graphics;
      mask.clear().rect(x, originY, cell, gridHeight).fill(0xffffff);

      for (const { text, sprite } of this.cells[reel]) {
        text.style.fontSize = Math.round(cell * 0.42);
        text.x = cell / 2;
        // The sprite's own scale is recomputed per frame in `paintCell`,
        // since it depends on the texture's dimensions as well as the cell's.
        sprite.x = cell / 2;
      }
    }

    this.frame
      .clear()
      .roundRect(
        originX - GRID_FRAME_PADDING_PX,
        originY - GRID_FRAME_PADDING_PX,
        gridWidth + GRID_FRAME_PADDING_PX * 2,
        gridHeight + GRID_FRAME_PADDING_PX * 2,
        14,
      )
      .stroke({ width: 1, color: 0x4fd1ff, alpha: 0.18 });
  };

  /**
   * Starts revealing an already-decided result.
   *
   * The result is handed over when the animation *begins*, not when it
   * ends, because the server decided it before this was called. That is
   * what makes the reveal interruptible at any point without risk of
   * showing something other than what was paid.
   */
  spinTo(result: string[][], onSettled?: () => void): void {
    // Captured before the spin starts: the reels have to scroll OUT of the
    // grid the player is looking at, not cut to a filler column.
    this.outgoingGrid = this.restingGrid;
    this.pendingResult = result;
    this.highlights = [];
    this.highlightLayer.clear();
    this.onSettled = onSettled ?? null;
    this.spinStartedAt = performance.now();
  }

  get isSpinning(): boolean {
    return this.spinStartedAt !== null;
  }

  /** Jumps to the settled result. A player who wants the outcome now should
   * never have to wait out an animation. */
  skipToResult(): void {
    if (!this.spinStartedAt || !this.pendingResult) return;
    this.restingGrid = this.pendingResult;
    this.pendingResult = null;
    this.spinStartedAt = null;
    this.settle();
  }

  showWinLines(lines: WinLineHighlight[]): void {
    this.highlights = lines;
  }

  private settle(): void {
    for (const blur of this.blurs) blur.strengthY = 0;
    const callback = this.onSettled;
    this.onSettled = null;
    callback?.();
  }

  private readonly draw = (): void => {
    if (!this.ready || this.destroyed) return;
    if (this.spinStartedAt !== null) this.drawSpinning(performance.now() - this.spinStartedAt);
    else this.drawResting();
  };

  /**
   * Finishes a reveal that the browser stopped animating.
   *
   * A real bug, found by running the client rather than by reading it: the
   * settle is detected **inside the draw loop**, and browsers throttle
   * `requestAnimationFrame` to zero in a hidden tab. So a player who
   * switches tabs mid-spin comes back to a round that never completed —
   * spin still disabled, the button still reading "Skip", the status still
   * "Spinning…". Measured directly: `document.hidden === true` produced 0
   * frames in 500ms and a reveal stuck for as long as it was observed.
   *
   * The money was never at risk — the server settled the round before any
   * of this ran — which is exactly why the client must not be the thing
   * that strands it. On becoming visible again the reveal is completed
   * immediately rather than resumed: the elapsed time is already past, so
   * animating the remainder would replay a reveal the player has waited
   * through.
   */
  private readonly onVisibilityChange = (): void => {
    if (this.destroyed) return;
    if (shouldForceSettle(document.hidden, this.spinStartedAt, performance.now(), this.spinDurationMs)) {
      this.skipToResult();
    }
  };

  private drawSpinning(elapsed: number): void {
    const { rows } = this.game.grid;
    const { cell } = this.metrics;
    let allStopped = true;

    for (let reel = 0; reel < this.reels.length; reel++) {
      const state = reelStateAt(elapsed, reel, this.timing);
      if (state.phase !== "stopped") allStopped = false;

      // Blur from measured movement, normalised against cell size by
      // `computeBlurStrength` — the raw-pixel form is what made the
      // reference's reels invisible.
      const deltaPx = (state.offset - this.lastOffset[reel]) * cell;
      this.lastOffset[reel] = state.offset;
      this.blurs[reel].strengthY = heavyEffectsAllowed(false)
        ? 0
        : Math.min(computeBlurStrength(deltaPx, cell), blurAmount(state) * 2.6);

      const fraction = state.offset - Math.floor(state.offset);
      const columnCells = this.cells[reel];

      for (let i = 0; i < columnCells.length; i++) {
        const row = i - 1;
        const cellObjects = columnCells[i];
        const symbol =
          state.phase === "stopped"
            ? this.settledSymbol(reel, row)
            : this.blendedSymbol(reel, row, Math.floor(state.offset) + row, state.settleProgress, state.offset);

        if (symbol === null) {
          cellObjects.text.visible = false;
          cellObjects.sprite.visible = false;
          continue;
        }

        this.paintCell(cellObjects, symbol, (row - fraction + 0.5) * cell, cell);
      }
    }

    if (allStopped && this.pendingResult) {
      this.restingGrid = this.pendingResult;
      this.pendingResult = null;
      this.spinStartedAt = null;
      this.settle();
    }
  }

  private drawResting(): void {
    const { cell } = this.metrics;
    for (let reel = 0; reel < this.reels.length; reel++) {
      const columnCells = this.cells[reel];
      for (let i = 0; i < columnCells.length; i++) {
        const row = i - 1;
        const cellObjects = columnCells[i];
        const symbol = this.settledSymbol(reel, row);
        if (symbol === null) {
          cellObjects.text.visible = false;
          cellObjects.sprite.visible = false;
          continue;
        }
        this.paintCell(cellObjects, symbol, (row + 0.5) * cell, cell);
      }
    }
    this.drawHighlights();
  }

  /**
   * Which symbol to draw mid-spin.
   *
   * Once a reel is far enough into its settle it switches from filler to
   * the real result, so the symbols decelerating into view are the ones
   * that actually landed — the reel never visibly swaps its contents at the
   * instant it stops.
   */
  private blendedSymbol(
    reel: number,
    row: number,
    index: number,
    settleProgress: number,
    offset: number,
  ): string | null {
    if (settleProgress > 0.55 && row >= 0 && row < this.game.grid.rows) return this.settledSymbol(reel, row);
    // `outgoingGrid` is what was on screen when the spin started. Without
    // it the first frame indexes straight into the filler and the whole
    // grid appears to reload instead of starting to move.
    return spinningSymbolAt(
      index,
      row,
      offset,
      this.filler,
      this.outgoingGrid?.[reel],
      this.game.grid.rows,
    );
  }

  private settledSymbol(reel: number, row: number): string | null {
    if (row < 0 || row >= this.game.grid.rows) return null;
    const grid = this.pendingResult ?? this.restingGrid;
    return grid[reel]?.[row] ?? null;
  }

  private drawHighlights(): void {
    this.highlightLayer.clear();
    if (this.highlights.length === 0) return;

    const { cell, reelGap, originX, originY } = this.metrics;
    // A slow pulse rather than a static outline: a win that moves is far
    // easier to spot than one that does not, especially across several
    // lines. Driven off the clock so it is frame-rate independent.
    const phase = (Math.sin(performance.now() / 320) + 1) / 2;

    for (const line of this.highlights) {
      for (const { reel, row } of line.positions) {
        this.highlightLayer
          .roundRect(originX + reel * (cell + reelGap) + 2, originY + row * cell + 2, cell - 4, cell - 4, cell * 0.14)
          .stroke({ width: 2 + phase * 2, color: styleFor(line.symbol).color, alpha: 0.55 + phase * 0.45 });
      }
    }
  }

  /** Total animation length, so a caller can schedule what follows the
   * reveal without duplicating the timing maths. */
  get spinDurationMs(): number {
    return totalSpinDurationMs(this.timing, this.game.grid.reels);
  }

  /**
   * Tears the renderer down.
   *
   * Explicit rather than left to garbage collection: a ticker callback and
   * a resize listener both hold this object alive, so without removing them
   * a reconnect leaks a whole renderer and keeps drawing into a canvas
   * nobody is looking at. Safe to call before `init` resolves — the flag is
   * checked there too.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.ready) return;
    this.app.ticker.remove(this.draw);
    window.removeEventListener("resize", this.layout);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.app.destroy(true, { children: true });
  }
}
