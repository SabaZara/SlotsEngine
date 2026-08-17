import { formatMoney } from "./formatMoney.js";
import { readBonusPanel, tileClickable, type BonusPanel, type PickPanel } from "./bonusView.js";
import { wheelFinalRotation } from "../render/wheelGeometry.js";

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

/** How long the wheel takes to settle. Long enough to read as a spin, short
 * enough that it is not in the way of the next round. */
const WHEEL_SPIN_MS = 3400;

/**
 * A wedge colour per segment.
 *
 * An HSL sweep rather than a fixed palette, for the reason the reference
 * records: any fixed set of accent colours *aliases* once the table is longer
 * than the palette, so two neighbouring wedges come out identical and the
 * wheel reads as one big segment. A sweep is distinct at any length.
 */
function segmentColor(index: number, total: number): string {
  return `hsl(${Math.round((index / total) * 360)} 62% 52%)`;
}

/**
 * The wheel face as a CSS `conic-gradient`.
 *
 * Exported for testing: the wedge boundaries are arithmetic, and arithmetic
 * that is one segment out draws a wheel whose pointer sits on the wrong
 * colour while looking entirely plausible.
 *
 * Segment 0 is centred at 12 o'clock, which is the artist contract
 * `wheelGeometry.ts` documents — so the gradient starts half a segment
 * *before* 0, and `from -90deg` puts 0deg at the top rather than at 3
 * o'clock, which is where CSS would otherwise begin.
 */
export function wheelGradient(segments: number[]): string {
  if (segments.length === 0) return "transparent";
  const step = 360 / segments.length;
  const stops = segments.map((_, i) => `${segmentColor(i, segments.length)} ${i * step}deg ${(i + 1) * step}deg`);
  return `conic-gradient(from ${-90 - step / 2}deg, ${stops.join(", ")})`;
}

/**
 * Where each segment's label sits, as a rotation in degrees.
 *
 * Each label is rotated out to its wedge and then counter-rotated by the same
 * amount, so the text stays upright while the wheel turns beneath it —
 * otherwise the bottom half of the wheel reads upside down.
 */
export function wheelLabelAngle(index: number, total: number): number {
  if (total < 1) return 0;
  return (index / total) * 360;
}

/**
 * One upright label per segment.
 *
 * `textContent`, never `innerHTML` — these values come from a module's
 * free-form view, which is the same rule the rest of this file follows.
 */
function wheelLabels(segments: number[]): HTMLElement[] {
  return segments.map((multiplier, i) => {
    const label = document.createElement("span");
    label.className = "wheel-label";
    label.textContent = `×${multiplier}`;
    const angle = wheelLabelAngle(i, segments.length);
    // Out to the wedge, then counter-rotated so the text stays upright.
    label.style.transform = `rotate(${angle}deg) translateY(-64px) rotate(${-angle}deg)`;
    return label;
  });
}

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
  /** The rotating half of the wheel. The pointer is a sibling and never
   * moves — see `buildFor`. */
  private wheelFace: HTMLElement | null = null;
  /** Cancels an in-flight wheel reveal. A second `render` for the same round
   * (a reconnect replaying state, say) must not leave two animations driving
   * one element, which would visibly fight. */
  private wheelAnimation: ReturnType<typeof setTimeout> | null = null;

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
    // Cleared alongside the dismissal, not instead of it: a reveal still
    // pending here would fire against a panel whose elements are gone, and
    // schedule a second `onResolvedDismissed` — handing the client back to
    // idle twice, once for a round that is already over.
    if (this.wheelAnimation !== null) clearTimeout(this.wheelAnimation);
    this.wheelAnimation = null;
    this.panel.hidden = true;
    this.panel.replaceChildren();
    this.tiles = [];
    this.heading = this.detail = this.tileGrid = null;
    this.wheelFace = null;
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

    if (model.kind === "wheel") {
      /*
       * Drawn in the DOM with a `conic-gradient`, not on a canvas.
       *
       * The reference builds this in Pixi with a `Graphics` arc per segment,
       * which it must — its bonus views live inside the same Pixi scene as
       * the reels. Ours is an HTML overlay already, so a canvas here would
       * add a second rendering surface to maintain, and one that `jsdom`
       * cannot exercise: `getContext` returns null, so every wedge would be
       * untestable. A gradient is CSS, and CSS is inspectable.
       *
       * The wheel and the pointer are separate elements because only the
       * wheel rotates — the pointer is fixed at 12 o'clock, which is the
       * artist contract `wheelGeometry.ts` documents.
       */
      this.wheelFace = document.createElement("div");
      this.wheelFace.className = "wheel-face";
      const pointer = document.createElement("div");
      pointer.className = "wheel-pointer";
      pointer.setAttribute("aria-hidden", "true");

      const stage = document.createElement("div");
      stage.className = "wheel-stage";
      stage.append(this.wheelFace, pointer);
      this.panel.append(stage);
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

      case "wheel": {
        this.setText(this.heading, "Bonus wheel");
        // The prize is deliberately NOT announced yet — saying it here would
        // spoil the reveal the animation exists for. `revealWheel` fills it
        // in when the wheel stops.
        this.setText(this.detail, "");
        this.revealWheel(model);
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
   * Paints the wheel and runs its reveal.
   *
   * **A CSS transition rather than a `requestAnimationFrame` loop, and that
   * is a fix inherited rather than rediscovered.** The reel reveal learned
   * this the hard way: browsers throttle rAF to *zero* in a hidden tab, so a
   * player switching away mid-spin stranded the round permanently and
   * `shouldForceSettle` exists to recover it. A transition is driven by the
   * compositor, so a hidden tab simply arrives at the finished state — there
   * is nothing to strand and no recovery path to get wrong.
   *
   * The trade is that the exact rotation mid-flight is not readable from a
   * test. That is acceptable *here specifically* because the number that
   * matters is the final one, and `wheelGeometry.ts` pins that arithmetic
   * without a DOM at all: 19 tests, including a round trip proving the
   * settled rotation points at the segment the server chose.
   */
  private revealWheel(model: Extract<BonusPanel, { kind: "wheel" }>): void {
    const face = this.wheelFace;
    if (!face) return;

    // A re-render for the same round must not leave two reveals driving one
    // element. Cleared before anything is scheduled, not after.
    if (this.wheelAnimation !== null) {
      clearTimeout(this.wheelAnimation);
      this.wheelAnimation = null;
    }

    const segments = model.segments.length > 0 ? model.segments : [model.multiplier];
    face.style.background = wheelGradient(segments);
    face.replaceChildren(...wheelLabels(segments));

    const finalRotation = wheelFinalRotation(model.segmentIndex, segments.length);

    // Snapped back to 0 with no transition first, so a second round does not
    // animate from wherever the previous one stopped — which would travel a
    // different distance and, worse, briefly sweep past several wrong
    // prizes on its way.
    face.style.transition = "none";
    face.style.transform = "rotate(0rad)";
    // Reading a layout property forces the reset to be committed before the
    // transition is re-enabled. Without it the browser coalesces both writes
    // and the wheel jumps straight to its answer.
    void face.offsetHeight;

    face.style.transition = `transform ${WHEEL_SPIN_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    face.style.transform = `rotate(${finalRotation}rad)`;

    this.wheelAnimation = setTimeout(() => {
      this.wheelAnimation = null;
      // The prize is announced only now. Saying it up front would spoil the
      // reveal this whole method exists for.
      this.setText(
        this.detail,
        `×${model.multiplier} · ${formatMoney(model.totalWinMinor, this.currency)}`,
      );
      if (this.dismissTimer) clearTimeout(this.dismissTimer);
      this.dismissTimer = setTimeout(() => {
        this.hide();
        this.callbacks.onResolvedDismissed();
      }, RESOLVED_DWELL_MS);
    }, WHEEL_SPIN_MS);
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
