import type { BonusPublicState, GameTheme, Round, ServerToClientMessage } from "@slots-engine/shared-types";

/**
 * What the server is willing to tell a browser. Mirrors game-backend's
 * `publicView` projection — notably WITHOUT reel strips or symbol weights,
 * so there is nothing here a player could use to work out when a game is
 * due to pay.
 */
export interface PublicGameView {
  gameId: string;
  name: string;
  version: number;
  grid: { reels: number; rows: number };
  paylines: Array<Array<number | null>>;
  symbols: Array<{
    symbol: string;
    role: string;
    allowedReels: number[];
    paytable?: Record<number, number>;
  }>;
  bonusModules: Array<{ moduleId: string; params: Record<string, unknown> }>;
  betOptions: number[];
  currency?: string;
  /** Artwork, presentation only. Optional at every level — a game with
   * none renders derived glyphs and plays identically. */
  assets?: { symbolImageUrls?: Record<string, string>; backgroundUrl?: string };
  /** Colour identity. Already sanitized by the projection, and re-checked
   * client-side before it reaches a stylesheet. */
  theme?: GameTheme;
}

export async function fetchGameView(backendUrl: string, gameId: string): Promise<PublicGameView> {
  const response = await fetch(`${backendUrl}/public/games/${encodeURIComponent(gameId)}`);
  if (!response.ok) throw new Error(`could not load game '${gameId}' (${response.status})`);
  return (await response.json()) as PublicGameView;
}

export interface GameClientEvents {
  onJoined: (payload: { playerId: string; balance: number }) => void;
  onSpinResult: (round: Round) => void;
  onBalance: (balance: number) => void;
  onBonusState: (state: BonusPublicState) => void;
  onError: (code: string, message: string) => void;
  onDisconnected: () => void;
}

/**
 * The socket client.
 *
 * Notice what it never sends: no player id, no operator id, no game id on
 * any message after JOIN. Identity lives server-side, keyed to this socket
 * and derived from the signed token. The only value this client contributes
 * to the money path is a bet amount, which the server validates against the
 * game's own options before anything is debited.
 */
export class GameClient {
  private socket: WebSocket | null = null;
  private sessionToken: string | null = null;

  constructor(
    private readonly socketUrl: string,
    private readonly events: GameClientEvents,
  ) {}

  connect(token: string): void {
    // Prefer a session token from a previous connection. A launch token is
    // single-use, so reusing one after a reconnect would be refused —
    // reconnecting must not send the player back to the casino lobby.
    const joinToken = this.sessionToken ?? token;

    const socket = new WebSocket(this.socketUrl);
    this.socket = socket;

    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "JOIN", token: joinToken })));
    socket.addEventListener("close", () => this.events.onDisconnected());
    socket.addEventListener("error", () => this.events.onError("connection_failed", "Lost contact with the server."));

    socket.addEventListener("message", (event) => {
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (message.type) {
        case "JOINED":
          // Kept for reconnects, and deliberately only in memory: writing a
          // bearer token to storage leaves it readable by anything else
          // running on the page.
          if (message.sessionToken) this.sessionToken = message.sessionToken;
          this.events.onJoined({ playerId: message.playerId, balance: message.balance });
          break;
        case "SPIN_RESULT":
          this.events.onSpinResult(message.round);
          break;
        case "BALANCE_UPDATE":
          this.events.onBalance(message.balance);
          break;
        case "BONUS_STEP_RESULT":
          this.events.onBonusState(message.bonusState);
          break;
        case "ERROR":
          this.events.onError(message.code, message.message);
          break;
        default:
          break;
      }
    });
  }

  spin(betAmount: number): void {
    // A fresh id per attempt. If the connection drops mid-spin and the
    // client retries, the server recognises the repeat and returns the
    // original round rather than spinning and charging again.
    this.send({ type: "SPIN_REQUEST", betAmount, clientRequestId: crypto.randomUUID() });
  }

  bonusStep(action: string, payload?: Record<string, unknown>): void {
    this.send({ type: "BONUS_STEP", action, ...(payload ? { payload } : {}) });
  }

  recoverRound(): void {
    this.send({ type: "ROUND_RECOVER" });
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.events.onError("not_connected", "Not connected to the server.");
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
  }
}
