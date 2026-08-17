import type { BonusPublicState, Round } from "@slots-engine/shared-types";
import { GameClient, fetchGameView, type PublicGameView } from "./api.js";
import { PixiReelRenderer } from "./render/pixiRenderer.js";
import { applyGameTheme } from "./render/theme.js";
import { GameAudio } from "./ui/gameAudio.js";
import { RotateDeviceOverlay } from "./ui/rotateDevice.js";
import { GameStateMachine } from "./state/gameState.js";
import { AUTOPLAY_SPIN_COUNTS, AutoplayController, type AutoplayStopReason } from "./state/autoplay.js";
import { applyEnablement } from "./ui/controls.js";
import { formatMoney } from "./ui/formatMoney.js";
import { isTerminalCode, presentStatus } from "./ui/statusPresentation.js";
import { startWinCountUp, writeFinalWin } from "./ui/winCountUp.js";
import { BonusPanelView } from "./ui/bonusPanel.js";

const BACKEND_URL = import.meta.env?.VITE_GAME_BACKEND_URL ?? "http://localhost:9102";
const SOCKET_URL = import.meta.env?.VITE_GAME_SOCKET_URL ?? "ws://localhost:9103";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

/**
 * The player client.
 *
 * The one thing worth understanding here: **the outcome is already decided
 * before any reel moves.** `SPIN_RESULT` arrives with the full result and
 * the new balance; the animation that follows is a way of revealing a
 * settled fact. That is why the balance updates on arrival rather than
 * when the reels stop, and why skipping the animation is always safe.
 */
class GameApp {
  private renderer: PixiReelRenderer | null = null;
  private client: GameClient | null = null;
  private game: PublicGameView | null = null;

  private balance = 0;
  private betIndex = 0;
  private lastRound: Round | null = null;
  /** Cancels an in-flight count-up. A count-up that outlives its round
   * writes a stale figure over the next one, which is a wrong number
   * attached to a spin that did not produce it. */
  private cancelCountUp: (() => void) | null = null;
  /** Null until the game view has arrived, since the URLs come from it. */
  private audio: GameAudio | null = null;

  /**
   * The autoplay run, if any.
   *
   * Constructed unconditionally rather than lazily on first use, so the
   * subscription below always has something to notify — a controller
   * created on demand would miss the phase changes that happened before a
   * player first opened the panel, and could resume against a state it
   * never saw.
   */
  private readonly autoplay = new AutoplayController(
    { phase: "offline" },
    {
      requestSpin: () => this.spin(),
      onStopped: (reason) => this.handleAutoplayStopped(reason),
      onChanged: () => this.renderAutoplay(),
    },
  );

  /**
   * The single source for what the player may do.
   *
   * This replaced a `spinInFlight` boolean plus direct `disabled` writes
   * from five call sites. The problem with that shape is not verbosity: two
   * of those sites could disagree, and the one that lost re-enabled a
   * control during a round that had not finished paying. Enablement is now
   * derived, so there is nothing to keep in step.
   */
  private readonly state = new GameStateMachine();

  /**
   * The bonus panel, constructed once. Its callbacks are the only path from
   * a tile press to the socket, and `onResolvedDismissed` is what returns
   * the client to idle — kept here rather than inside the panel because a
   * phase change belongs with the phases.
   */
  private readonly bonusPanel = new BonusPanelView(
    { panel: el("bonus") },
    {
      onPick: (tileIndex) => this.client?.bonusStep("pick", { tileIndex }),
      onSpin: () => this.client?.bonusStep("spin", {}),
      onResolvedDismissed: () => this.state.transition({ phase: "idle" }),
    },
  );

  async start(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const gameId = params.get("gameId") ?? "reference-5x3";

    // Subscribed FIRST, before anything that can fail. Registering after
    // the guards below would mean an early failure transitions the phase
    // with nobody listening — the player would get a dead button and no
    // explanation, which is the exact failure this wiring exists to
    // prevent.
    this.state.subscribe((next) => {
      // Autoplay is told BEFORE the UI is updated, because it may stop
      // itself in response — and a UI painted from a run that is about to
      // end shows a "stop" button for a run that no longer exists.
      this.autoplay.handleStateChange(next);
      this.audio?.apply(next);
      this.applyEnablement();
      this.applyStatus();
    });

    if (!token) {
      this.fatal("invalid_token");
      return;
    }

    try {
      this.game = await fetchGameView(BACKEND_URL, gameId);
      // Applied before anything renders, so the player never sees a frame
      // in the default palette followed by a repaint into the game's own.
      applyGameTheme(document.documentElement, this.game.theme);
      this.audio = new GameAudio({
        ...(this.game.assets?.musicUrl !== undefined ? { musicUrl: this.game.assets.musicUrl } : {}),
        ...(this.game.assets?.spinSoundUrl !== undefined ? { spinSoundUrl: this.game.assets.spinSoundUrl } : {}),
      });
      this.buildMuteControl();
      // Constructed after the game view so it cannot flash before the page
      // has a name to show behind it. It listens for the rest of the
      // session; nothing else drives it.
      new RotateDeviceOverlay({ overlay: el("rotate-device") }, window);
    } catch {
      // The underlying message is deliberately not shown. "Failed to fetch"
      // tells a player nothing they can act on, and the phase's own wording
      // does. The error still reaches the console for a developer.
      this.fatal("launch_failed");
      return;
    }

    el("game-name").textContent = this.game.name;

    // Pixi 8 initialises asynchronously and acquires a WebGL context, which
    // genuinely can fail — an old browser, a blocked context, a GPU reset.
    // Awaited and caught rather than left floating, because the failure
    // mode otherwise is a blank canvas with working buttons: the player
    // spins, is charged, and sees nothing move. Observed during development,
    // which is why it is handled rather than assumed away.
    try {
      const renderer = new PixiReelRenderer(el<HTMLCanvasElement>("reels"), this.game);
      await renderer.init();
      this.renderer = renderer;
    } catch {
      this.fatal("graphics_failed");
      return;
    }

    this.buildBetControls();
    this.buildAutoplayControls();
    this.buildPaytable();

    this.client = new GameClient(SOCKET_URL, {
      onJoined: ({ balance }) => {
        this.balance = balance;
        this.updateBalance();
        this.state.transition({ phase: "idle" });
      },
      onSpinResult: (round) => this.handleSpinResult(round),
      onBalance: (balance) => {
        this.balance = balance;
        this.updateBalance();
      },
      onBonusState: (state) => this.handleBonusState(state),
      onError: (code, message) => this.handleError(code, message),
      onDisconnected: () => {
        // Deliberately not `unrecoverable`: a dropped socket is exactly the
        // case a reconnect fixes, and the two are told apart by whether
        // retrying could possibly help.
        this.state.transition({ phase: "offline" });
      },
    });

    this.client.connect(token);
    // Not a phase: `offline` is the initial state and its wording is about a
    // DROPPED connection, which is a different thing to say than a first
    // attempt that has not resolved yet.
    this.setTransientStatus("Connecting…");

    el("spin").addEventListener("click", () => this.spinOrSkip());
    el("reels").addEventListener("click", () => this.skip());
    // Space is the conventional spin key; it also skips a reveal in
    // progress, so an impatient player never has to wait out the animation.
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      this.spinOrSkip();
    });
  }

  /**
   * One entry point for both the button and the spacebar.
   *
   * Which of the two actions this is depends on the phase rather than on
   * asking the renderer whether it happens to be moving. That mattered: the
   * previous form read `renderer.isSpinning`, so between sending a spin and
   * the result arriving the reels were still — and a second press started a
   * second round.
   */
  private spinOrSkip(): void {
    // The browser refuses `play()` until a real gesture has happened, and
    // this is the gesture every player makes. Safe to call on every press:
    // priming is a no-op once the loop is already running.
    this.audio?.prime();
    if (this.state.enablement.skipAffordance) {
      this.skip();
      return;
    }
    if (this.state.enablement.spinEnabled) this.spin();
  }

  private skip(): void {
    if (!this.state.enablement.skipAffordance) return;
    this.state.requestSkip();
    this.renderer?.skipToResult();
    // The count-up is part of the reveal, so a skip must finish it too —
    // otherwise the reels land instantly and the number keeps ticking
    // afterwards, which reads as the result still being decided.
    this.cancelCountUp?.();
    this.cancelCountUp = null;
    const win = this.lastRound?.evaluation?.totalWin ?? 0;
    if (win > 0) writeFinalWin({ amount: el("win") }, win, this.game?.currency);
  }

  /** Pushes derived enablement onto the DOM. The only place that writes
   * `disabled`, so no other path can contradict it. The work itself lives in
   * `ui/controls.ts` so it is reachable by a test without a socket and a
   * canvas — this method is the wiring, not the rule. */
  private applyEnablement(): void {
    applyEnablement(
      { spin: el<HTMLButtonElement>("spin"), bets: el("bets") },
      this.state.current,
    );
  }

  /**
   * Returns whether a spin was actually sent.
   *
   * The boolean exists for autoplay. Every early return here is a real
   * reason a run must stop rather than continue: no game loaded, the phase
   * refusing, or a stake the balance cannot cover. A run that kept counting
   * down through any of those would look busy while sending nothing — the
   * failure `spinRefused` exists to prevent.
   */
  private spin(): boolean {
    if (!this.game || !this.state.enablement.spinEnabled) return false;

    const bet = this.game.betOptions[this.betIndex];
    if (bet > this.balance) {
      this.setTransientStatus("Not enough balance for that bet");
      return false;
    }

    this.state.transition({ phase: "spinning" });
    el("win").textContent = "";
    this.client?.spin(bet);
    return true;
  }

  private handleSpinResult(round: Round): void {
    this.lastRound = round;
    // Told the BASE game's win, deliberately. A spin that triggers a bonus
    // has already halted the run until the bonus resolves; stopping on the
    // bonus credit as well would end it at a moment the player never chose.
    this.autoplay.notifySpinResult(round.evaluation?.totalWin ?? 0);
    const matrix = round.resultMatrix;
    if (!matrix) return;

    // The result is settled from here on, so the reveal becomes skippable.
    this.state.transition({ phase: "revealing", stopRequested: false });

    // Reveal, then report. The balance has already moved server-side; the
    // win figure is held back only so it doesn't spoil the animation.
    this.renderer?.spinTo(matrix, () => {
      const win = round.evaluation?.totalWin ?? 0;
      // Counted up rather than printed, and the tier it reaches scales the
      // pacing. The value written is always an integer count of minor units
      // — see `winCountUp.ts` for the money bug that guards against.
      this.cancelCountUp?.();
      this.cancelCountUp = startWinCountUp(
        { amount: el("win") },
        {
          winMinor: win,
          totalBetMinor: round.totalBet ?? 0,
          currency: this.game?.currency,
          onTier: (tier) => el("win").setAttribute("data-tier", tier),
        },
      );

      if (win > 0) {
        this.renderer?.showWinLines(
          (round.evaluation?.winLines ?? []).map((line) => ({ positions: line.positions, symbol: line.symbol })),
        );
      }

      const triggered = round.evaluation?.bonusTriggered ?? false;
      // The round is not over until the module resolves, so a triggered
      // bonus goes to its own phase rather than back to idle — betting into
      // a round that has not finished paying is the thing being prevented.
      this.state.transition(triggered ? { phase: "bonus" } : { phase: "idle" });
    });
  }

  /**
   * Draws a bonus round.
   *
   * The panel owns its own elements and updates them in place — see
   * `bonusPanel.ts` for why an `innerHTML` rebuild per step was wrong. What
   * stays here is the wiring: sending steps, and replaying a free spin onto
   * the real reels.
   */
  private handleBonusState(state: BonusPublicState): void {
    this.bonusPanel.setCurrency(this.game?.currency);

    // Replay the spin onto the reels the player already knows, rather than a
    // separate bonus display — a free spin IS a real spin, and showing it
    // any other way would teach the player it is something else. Guarded on
    // `matrix` because the first view, from `start`, has no spin yet.
    const lastSpin = state.view?.lastSpin as { matrix?: string[][] } | undefined;
    if (lastSpin?.matrix) this.renderer?.spinTo(lastSpin.matrix);

    this.bonusPanel.render(state);
  }

  private handleError(code: string, message: string): void {
    // A spent or expired token cannot be recovered from in the client — the
    // player has to be launched again by the casino. The phase records that
    // distinction rather than only disabling a button, so nothing later
    // re-enables it on the assumption the error was transient. The phase's
    // own wording is used rather than the server's `message`, since the
    // latter is written for a developer.
    if (isTerminalCode(code)) {
      this.state.transition({ phase: "unrecoverable", code });
      return;
    }

    // Any other error ends the round it interrupted. Returning to idle
    // rather than to the phase it came from is deliberate: a failed spin has
    // no result to reveal, so `revealing` would offer a skip over nothing.
    this.state.transition({ phase: "idle" });
    // Written *after* the transition, which would otherwise overwrite it
    // with "Ready". A transient error is the one thing the phase model
    // genuinely cannot express — it says what the client may do, and this
    // says what just went wrong.
    this.setTransientStatus(message);
  }

  /**
   * A message that outlives no phase change.
   *
   * Deliberately separate from `applyStatus`, and always applied after a
   * transition rather than before one. Two writers of the same element is
   * the drift this repo keeps finding; naming the exception is what keeps
   * it an exception rather than a second source.
   */
  private setTransientStatus(text: string): void {
    el("status").textContent = text;
    el("status").dataset.tone = "bad";
  }

  /**
   * Builds the autoplay controls once, then leaves them alone.
   *
   * Built rather than rebuilt for the reason `bonusPanel.ts` records: a
   * rebuild replaces the element a player is interacting with, which throws
   * away focus and makes a checkbox impossible to reach by keyboard.
   * `renderAutoplay` only ever writes text and `disabled` onto these.
   */
  /**
   * The mute button, built only when the game has sound.
   *
   * Hidden rather than disabled for a game with no audio, which is the
   * opposite of the rule the autoplay panel follows — and deliberately so.
   * A disabled control says "this exists and is unavailable right now"; a
   * mute button on a silent game is not unavailable, it is meaningless, and
   * offering it invites a player to press it wondering what broke. Every
   * game in this repo ships no audio today, so this is the common path.
   */
  private buildMuteControl(): void {
    const button = el<HTMLButtonElement>("mute");
    if (!this.audio?.hasAudio) {
      button.hidden = true;
      return;
    }

    button.hidden = false;
    const render = () => {
      const muted = this.audio?.isMuted ?? false;
      button.textContent = muted ? "🔇" : "🔊";
      // The label states the ACTION, not the state — a screen reader
      // announcing "muted" on a button that unmutes is ambiguous about
      // which of the two it is describing.
      button.setAttribute("aria-label", muted ? "Unmute" : "Mute");
      button.setAttribute("aria-pressed", String(muted));
    };

    button.addEventListener("click", () => {
      // Also a genuine gesture, so it can unlock audio for a player who
      // reaches for the speaker icon before they spin.
      this.audio?.prime();
      this.audio?.setMuted(!this.audio.isMuted);
      render();
    });
    render();
  }

  private buildAutoplayControls(): void {
    const counts = el("autoplay-counts");
    counts.innerHTML = "";
    for (const count of AUTOPLAY_SPIN_COUNTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "autoplay-count";
      button.textContent = String(count);
      button.addEventListener("click", () => this.autoplay.setCount(count));
      counts.append(button);
    }

    const stopOnWin = el("autoplay-stop-on-win") as HTMLInputElement;
    stopOnWin.addEventListener("change", () => this.autoplay.setStopOnWin(stopOnWin.checked));

    el("autoplay-toggle").addEventListener("click", () => this.autoplay.toggle());

    this.renderAutoplay();
  }

  /** Pushes the controller's state onto the controls. The controller is the
   * only source — no element here decides anything for itself. */
  private renderAutoplay(): void {
    const status = this.autoplay.status;
    const settings = this.autoplay.currentSettings;

    for (const button of el("autoplay-counts").querySelectorAll("button")) {
      const isSelected = button.textContent === String(settings.count);
      button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = !status.settingsEnabled;
    }

    const stopOnWin = el("autoplay-stop-on-win") as HTMLInputElement;
    stopOnWin.checked = settings.stopOnWin;
    stopOnWin.disabled = !status.settingsEnabled;

    const toggle = el("autoplay-toggle") as HTMLButtonElement;
    toggle.textContent = status.running ? "Stop" : "Start";
    toggle.disabled = !status.toggleEnabled;

    el("autoplay-remaining").textContent = status.running ? `${status.remaining} left` : "";
  }

  /**
   * Says why a run ended, when the reason is not self-evident.
   *
   * A run that simply finished needs no announcement — the reels stopping
   * is the message. The others do: a player watching a run halt with spins
   * apparently remaining has no way to tell a deliberate stop-on-win from a
   * dropped connection, and those call for opposite reactions.
   */
  private handleAutoplayStopped(reason: AutoplayStopReason): void {
    this.renderAutoplay();
    if (reason === "wonWhileStopOnWin") this.setTransientStatus("Autoplay stopped — you won");
    else if (reason === "spinRefused") this.setTransientStatus("Autoplay stopped — the spin could not be placed");
    // `sessionEnded` is deliberately silent: the phase change that caused it
    // already writes its own status, and a second message would overwrite a
    // more specific one with a vaguer one.
  }

  private buildBetControls(): void {
    if (!this.game) return;
    const container = el("bets");
    container.innerHTML = "";

    this.game.betOptions.forEach((bet, index) => {
      const button = document.createElement("button");
      button.className = "bet";
      button.textContent = formatMoney(bet, this.game?.currency);
      button.addEventListener("click", () => {
        this.betIndex = index;
        container.querySelectorAll(".bet").forEach((b, i) => b.classList.toggle("selected", i === index));
      });
      if (index === 0) button.classList.add("selected");
      container.appendChild(button);
    });
  }

  /** The paytable is public information a player is entitled to — what is
   * withheld is how *often* symbols land, never what they pay. */
  private buildPaytable(): void {
    if (!this.game) return;
    const rows = this.game.symbols
      .filter((s) => s.paytable && Object.keys(s.paytable).length > 0)
      .map((s) => {
        const entries = Object.entries(s.paytable!)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([count, mult]) => `${count}× → ${mult}`)
          .join("  ·  ");
        return `<tr><td>${s.symbol}</td><td>${entries}</td></tr>`;
      })
      .join("");
    el("paytable").innerHTML = `<table>${rows}</table>`;
  }

  private updateBalance(): void {
    el("balance").textContent = formatMoney(this.balance, this.game?.currency);
  }

  /**
   * Writes the phase's own wording, so the status line and the buttons
   * cannot disagree. A client reading "Ready" beside a disabled spin button
   * is worse than a silent one — the player concludes the button is broken
   * rather than that the round is not over.
   */
  private applyStatus(): void {
    const { headline, detail, tone } = presentStatus(this.state.current);
    el("status").textContent = headline;
    el("status").dataset.tone = tone;
    // The detail shares the win line, which is empty whenever there is
    // something to explain — a win and a failure never coexist.
    if (detail) el("win").textContent = detail;
  }

  /**
   * A failure the player cannot act on — no launch token, no graphics, or a
   * game that would not load. Distinct from `handleError`'s transient case,
   * and the phase records which: nothing here is retried by reconnecting.
   */
  private fatal(code: string): void {
    this.state.transition({ phase: "unrecoverable", code });
  }
}

void new GameApp().start();
