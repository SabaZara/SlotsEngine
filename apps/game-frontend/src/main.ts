import type { BonusPublicState, Round } from "@slots-engine/shared-types";
import { GameClient, fetchGameView, type PublicGameView } from "./api.js";
import { GameRenderer } from "./render/renderer.js";
import { formatMoney } from "./ui/formatMoney.js";

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
  private renderer: GameRenderer | null = null;
  private client: GameClient | null = null;
  private game: PublicGameView | null = null;

  private balance = 0;
  private betIndex = 0;
  private lastRound: Round | null = null;
  private spinInFlight = false;

  async start(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const gameId = params.get("gameId") ?? "reference-5x3";

    if (!token) {
      this.fatal(
        "No launch token",
        "A player normally arrives here through a casino, which supplies a signed one-time token. Open this page with ?token=… to play.",
      );
      return;
    }

    try {
      this.game = await fetchGameView(BACKEND_URL, gameId);
    } catch (err) {
      this.fatal("Could not load the game", err instanceof Error ? err.message : String(err));
      return;
    }

    el("game-name").textContent = this.game.name;
    this.renderer = new GameRenderer(el<HTMLCanvasElement>("reels"), this.game);
    this.buildBetControls();
    this.buildPaytable();

    this.client = new GameClient(SOCKET_URL, {
      onJoined: ({ balance }) => {
        this.balance = balance;
        this.setStatus("Ready");
        this.updateBalance();
        this.setControlsEnabled(true);
      },
      onSpinResult: (round) => this.handleSpinResult(round),
      onBalance: (balance) => {
        this.balance = balance;
        this.updateBalance();
      },
      onBonusState: (state) => this.handleBonusState(state),
      onError: (code, message) => this.handleError(code, message),
      onDisconnected: () => {
        this.setStatus("Disconnected");
        this.setControlsEnabled(false);
      },
    });

    this.client.connect(token);
    this.setStatus("Connecting…");

    el("spin").addEventListener("click", () => this.spin());
    el("reels").addEventListener("click", () => this.renderer?.skipToResult());
    // Space is the conventional spin key; it also skips a spin in progress,
    // so an impatient player never has to wait out the animation.
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      if (this.renderer?.isSpinning) this.renderer.skipToResult();
      else this.spin();
    });
  }

  private spin(): void {
    if (!this.game || this.spinInFlight) return;

    const bet = this.game.betOptions[this.betIndex];
    if (bet > this.balance) {
      this.setStatus("Not enough balance for that bet");
      return;
    }

    this.spinInFlight = true;
    this.setControlsEnabled(false);
    this.setStatus("Spinning…");
    el("win").textContent = "";
    this.client?.spin(bet);
  }

  private handleSpinResult(round: Round): void {
    this.lastRound = round;
    const matrix = round.resultMatrix;
    if (!matrix) return;

    // Reveal, then report. The balance has already moved server-side; the
    // win figure is held back only so it doesn't spoil the animation.
    this.renderer?.spinTo(matrix, () => {
      const win = round.evaluation?.totalWin ?? 0;
      if (win > 0) {
        el("win").textContent = `Win ${formatMoney(win, this.game?.currency)}`;
        this.renderer?.showWinLines(
          (round.evaluation?.winLines ?? []).map((line) => ({ positions: line.positions, symbol: line.symbol })),
        );
      }

      this.setStatus(round.evaluation?.bonusTriggered ? "Bonus round!" : "Ready");
      this.spinInFlight = false;
      // Stay disabled through a bonus: the round isn't over until the
      // module resolves, and spinning again mid-bonus would be confusing.
      this.setControlsEnabled(!round.evaluation?.bonusTriggered);
    });
  }

  private handleBonusState(state: BonusPublicState): void {
    const panel = el("bonus");
    panel.hidden = false;

    if (state.status === "resolved") {
      const win = state.totalWin ?? 0;
      panel.innerHTML = `<strong>Bonus complete</strong><span>${formatMoney(win, this.game?.currency)}</span>`;
      setTimeout(() => {
        panel.hidden = true;
        this.setStatus("Ready");
        this.setControlsEnabled(true);
      }, 2600);
      return;
    }

    // A multi-step module. The view carries only what the player is allowed
    // to see — never the unrevealed remainder of the layout.
    const tileCount = Number(state.view.tileCount ?? 0);
    const revealed = (state.view.revealed as number[] | undefined) ?? [];
    panel.innerHTML = `<strong>Pick a prize</strong><div class="tiles"></div>`;
    const tiles = panel.querySelector(".tiles")!;

    for (let i = 0; i < tileCount; i++) {
      const button = document.createElement("button");
      button.className = "tile";
      button.disabled = revealed.includes(i);
      const picks = (state.view.picks as Array<{ tileIndex: number; multiplier: number | null }> | undefined) ?? [];
      const pick = picks.find((p) => p.tileIndex === i);
      button.textContent = pick ? (pick.multiplier === null ? "✕" : `×${pick.multiplier}`) : "?";
      button.addEventListener("click", () => this.client?.bonusStep("pick", { tileIndex: i }));
      tiles.appendChild(button);
    }
  }

  private handleError(code: string, message: string): void {
    this.spinInFlight = false;
    this.setStatus(message);

    // A spent or expired token cannot be recovered from in the client — the
    // player has to be launched again by the casino, so say so plainly
    // rather than leaving a dead button.
    if (code === "token_expired" || code === "token_already_used" || code === "invalid_token") {
      this.setControlsEnabled(false);
      return;
    }
    this.setControlsEnabled(true);
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

  private setStatus(text: string): void {
    el("status").textContent = text;
  }

  private setControlsEnabled(enabled: boolean): void {
    el<HTMLButtonElement>("spin").disabled = !enabled;
  }

  private fatal(title: string, detail: string): void {
    el("status").textContent = title;
    el("win").textContent = detail;
    this.setControlsEnabled(false);
  }
}

void new GameApp().start();
