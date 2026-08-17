import { formatMoney } from "./formatMoney.js";
import { readBonusPanel, tileClickable, type BonusPanel, type PickPanel } from "./bonusView.js";

/**
 * Draws the bonus panel, and keeps its elements between steps.
 *
 * **Replaces an `innerHTML` rebuild, and the reason is not tidiness.** The
 * previous version rewrote the whole panel on every `BONUS_STATE`, which
 * destroyed and recreated every tile each time a player picked one. Three
 * consequences, in rising order of seriousness:
 *
 * - No tile can animate a reveal, because the element showing the result is
 *   a different object from the one that was clicked.
 * - Keyboard focus is lost on every step, so the panel is unusable without
 *   a mouse — a player tabbed onto tile 4 is returned to the top of the
 *   document the instant they press it.
 * - Values were interpolated straight into markup. Nothing in a bonus view
 *   is attacker-controlled today, but a module's `view` is free-form and
 *   reaches this string directly, so the safe construction is worth having
 *   before someone adds a module that echoes a name.
 *
 * Elements are therefore created once per *round* and updated in place.
 */
export interface BonusPanelTargets {
  panel: HTMLElement;
}

export interface BonusPanelCallbacks {
  onPick: (tileIndex: number) => void;
  onSpin: () => void;
  /** Called when a resolved round has finished being shown, so the caller
   * can return the client to idle. Passed in rather than timed here because
   * "the round is over" is a phase change, and phases live in one place. */
  onResolvedDismissed: () => void;
}

/** How long a resolved bonus stays on screen before handing control back.
 * Long enough to read the figure, short enough not to feel stuck. */
const RESOLVED_DWELL_MS = 2600;

export class BonusPanelView {
  private readonly panel: HTMLElement;
  private readonly callbacks: BonusPanelCallbacks;
  private currency?: string;

  /** Tiles, kept between steps so a reveal can animate and focus survives. */
  private tiles: HTMLButtonElement[] = [];
  private heading: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private spinButton: HTMLButtonElement | null = null;
  private tileGrid: HTMLElement | null = null;

  /** Which layout is currently built, so it is rebuilt only on a real
   * change of module rather than on every step. */
  private builtKind: BonusPanel["kind"] | null = null;
  /** True between sending a step and its result arriving. No tile is
   * clickable in that window even though none is revealed yet. */
  private stepInFlight = false;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  /** The most recent pick model, so `syncTileEnablement` can apply the same
   * rule from a click handler, which has no model of its own. */
  private lastPickModel: PickPanel | null = null;
  /** Index of the tile that most recently held focus, tracked live because
   * by the time a tile is disabled the browser has already blurred it. */
  private lastFocusedTileIndex = -1;

  constructor(targets: BonusPanelTargets, callbacks: BonusPanelCallbacks) {
    this.panel = targets.panel;
    this.callbacks = callbacks;
    // `focusin` bubbles where `focus` does not, so one listener covers every
    // tile — including tiles created later for a different round.
    this.panel.addEventListener("focusin", (event) => {
      const index = this.tiles.indexOf(event.target as HTMLButtonElement);
      if (index >= 0) this.lastFocusedTileIndex = index;
    });
  }

  setCurrency(currency: string | undefined): void {
    this.currency = currency;
  }

  /** Hides the panel and forgets its layout, so the next round builds fresh
   * rather than inheriting the previous one's tiles. */
  hide(): void {
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
    this.panel.hidden = true;
    this.panel.replaceChildren();
    this.tiles = [];
    this.heading = this.detail = this.tileGrid = null;
    this.spinButton = null;
    this.builtKind = null;
    this.stepInFlight = false;
    this.lastPickModel = null;
    this.lastFocusedTileIndex = -1;
  }

  render(state: unknown): void {
    const model = readBonusPanel(state as never);
    this.panel.hidden = false;
    // A step's result has arrived, whatever it was.
    this.stepInFlight = false;

    if (model.kind !== this.builtKind) {
      this.panel.replaceChildren();
      this.tiles = [];
      this.buildFor(model);
      this.builtKind = model.kind;
    }

    this.update(model);
  }

  private buildFor(model: BonusPanel): void {
    this.heading = document.createElement("strong");
    this.detail = document.createElement("span");
    this.panel.append(this.heading, this.detail);

    if (model.kind === "pick") {
      this.tileGrid = document.createElement("div");
      this.tileGrid.className = "tiles";
      this.panel.append(this.tileGrid);
      for (const tile of model.tiles) {
        const button = document.createElement("button");
        button.className = "tile";
        button.type = "button";
        // Listener bound once per round rather than per step, which is what
        // the rebuild made impossible.
        button.addEventListener("click", () => {
          if (button.disabled) return;
          this.stepInFlight = true;
          this.syncTileEnablement();
          this.callbacks.onPick(tile.index);
        });
        this.tiles.push(button);
        this.tileGrid.append(button);
      }
      return;
    }

    if (model.kind === "freeSpins") {
      this.spinButton = document.createElement("button");
      this.spinButton.className = "tile";
      this.spinButton.type = "button";
      this.spinButton.textContent = "Spin";
      this.spinButton.addEventListener("click", () => {
        if (this.spinButton?.disabled) return;
        this.stepInFlight = true;
        this.spinButton!.disabled = true;
        this.callbacks.onSpin();
      });
      this.panel.append(this.spinButton);
    }
  }

  private update(model: BonusPanel): void {
    // `textContent`, never `innerHTML`: a module's view is free-form and
    // reaches these values directly.
    switch (model.kind) {
      case "pick": {
        this.setText(this.heading, model.exhausted ? "Bonus finishing…" : "Pick a prize");
        this.setText(this.detail, "");
        for (const [i, tile] of model.tiles.entries()) {
          const button = this.tiles[i];
          if (!button) continue;
          button.textContent = tile.label;
          button.setAttribute("aria-label", `Tile ${tile.index + 1}${tile.revealed ? `, ${tile.label}` : ""}`);
        }
        this.lastPickModel = model;
        this.syncTileEnablement();
        return;
      }

      case "freeSpins": {
        this.setText(this.heading, model.multiplier > 1 ? `Free spins ×${model.multiplier}` : "Free spins");
        const retriggerNote =
          model.retriggers > 0 ? ` · ${model.retriggers} retrigger${model.retriggers > 1 ? "s" : ""}` : "";
        this.setText(
          this.detail,
          `${model.remaining} left${retriggerNote} · ${formatMoney(model.accumulatedMinor, this.currency)}`,
        );
        if (this.spinButton) this.spinButton.disabled = !model.canSpin;
        return;
      }

      case "resolved": {
        this.setText(this.heading, "Bonus complete");
        this.setText(this.detail, formatMoney(model.totalWinMinor, this.currency));
        // Timer cleared first, so two resolved states in a row cannot stack
        // two dismissals and return the client to idle twice.
        if (this.dismissTimer) clearTimeout(this.dismissTimer);
        this.dismissTimer = setTimeout(() => {
          this.hide();
          this.callbacks.onResolvedDismissed();
        }, RESOLVED_DWELL_MS);
        return;
      }

      case "unknown": {
        // A module this build cannot draw. Said plainly rather than left as
        // an empty overlay: a bonus blocks the base game until it resolves,
        // so a panel with nothing in it reads as a frozen client.
        this.setText(this.heading, "Bonus round in progress");
        this.setText(this.detail, "This round is being played on the server.");
      }
    }
  }

  /**
   * Pushes tile enablement onto the buttons.
   *
   * The last-seen model is remembered rather than taken as an argument on
   * every call, because the click handler has no model to hand — and the
   * first version simply disabled everything in that case. That *looked*
   * right (a pick does disable every tile) but meant `stepInFlight` was
   * never consulted on the click path, so the flag was decorative. Found by
   * mutation: removing it changed nothing.
   *
   * With the model kept, one rule decides in both directions — a tile is
   * clickable when it is unrevealed and nothing is in flight — so the click
   * path and the render path cannot disagree about what is enabled.
   */
  private syncTileEnablement(): void {
    const model = this.lastPickModel;

    /**
     * Disabling the focused element blurs it — the browser moves focus to
     * `<body>` — so every pick throws a keyboard player back to the top of
     * the document even though the tiles themselves survive.
     *
     * Found by running the client, and **not** by the test that was written
     * for exactly this: `jsdom` does not implement the blur-on-disable
     * behaviour, so the assertion passed against a stand-in more permissive
     * than the real thing. Same trap as `fakeMongo` in section D.
     *
     * The focused tile is therefore remembered across the enablement pass
     * and refocused if it is still usable. A tile that has become disabled
     * is deliberately not refocused — focus would sit on a dead control.
     */
    // Captured before anything is disabled. Reading it afterwards is too
    // late — the browser has already blurred to `<body>`, so the index
    // would always be -1 and the restore would never fire. That was the
    // first version of this fix, and it failed in exactly that way.
    const focusedIndex = this.rememberedFocusIndex();

    for (const [i, button] of this.tiles.entries()) {
      const tile = model?.tiles[i];
      button.disabled = tile ? !tileClickable(tile, this.stepInFlight) : true;
    }

    if (focusedIndex >= 0) {
      const button = this.tiles[focusedIndex];
      // Only onto a tile that is still usable: focus on a dead control is
      // worse than focus at the top of the document, because the player
      // cannot tell why their keyboard does nothing.
      if (!button.disabled && document.activeElement !== button) button.focus();
    }
  }

  /**
   * Which tile held focus most recently.
   *
   * Tracked on `focusin` rather than read at disable time, because by then
   * the browser has already moved focus to `<body>` and the answer is always
   * "none". `focusin` bubbles, which `focus` does not, so one listener on
   * the panel covers every tile including ones added later.
   *
   * `document.activeElement` is still consulted first, since it is correct
   * whenever focus has not yet been lost — the remembered index is the
   * fallback for the window after a disable.
   *
   * Verified in a real browser, and worth knowing how: **a programmatic
   * `.focus()` does not emit `focusin` in a headless pane**, so a check that
   * calls `.focus()` and then picks a tile will see focus land on `<body>`
   * and conclude this is broken. It is not — a real Tab keypress does fire
   * the event. Dispatching `focusin` explicitly alongside the `.focus()`
   * call reproduces the keyboard path, and focus is then restored correctly.
   */
  private rememberedFocusIndex(): number {
    const active = document.activeElement;
    const live = this.tiles.findIndex((button) => button === active);
    return live >= 0 ? live : this.lastFocusedTileIndex;
  }

  private setText(element: HTMLElement | null, text: string): void {
    if (element && element.textContent !== text) element.textContent = text;
  }
}
