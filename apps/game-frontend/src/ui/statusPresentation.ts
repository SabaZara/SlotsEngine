import type { GameState } from "../state/gameState.js";

/**
 * What the player is told, and whether they can do anything about it.
 *
 * Pulled out of `main.ts` because the mapping from a failure to a sentence
 * is a decision, and decisions in this repo get tests. The specific failure
 * this guards is one that happened during development and is worth
 * recording: the Pixi renderer's context acquisition can fail, and when it
 * did, the page showed a **blank canvas with a working Spin button**. The
 * player would have bet, been charged, and seen nothing move.
 *
 * So a message is not decoration here. It is the difference between "this
 * is broken, stop" and "keep pressing the button".
 */
export type StatusTone = "neutral" | "busy" | "good" | "bad";

export interface StatusPresentation {
  /** The short line. Always present — an empty status reads as a hung
   * client rather than as a quiet one. */
  headline: string;
  /** The longer explanation, when there is something useful to add.
   * Deliberately optional: padding every state with prose trains people to
   * stop reading the one that matters. */
  detail?: string;
  tone: StatusTone;
  /** Whether the player's own next action can change anything. False means
   * the client is waiting or finished; only a relaunch or a reconnect
   * helps. Drives whether a retry affordance is worth showing at all. */
  actionable: boolean;
}

/**
 * Error codes the server sends that mean the session is over.
 *
 * Kept as a set with an explicit comment rather than inline, because the
 * consequence of a code *missing* from here is a dead button the player
 * keeps pressing, and the consequence of one wrongly added is a session
 * abandoned that could have continued.
 */
const TERMINAL_CODES = new Set(["token_expired", "token_already_used", "invalid_token"]);

export function isTerminalCode(code: string): boolean {
  return TERMINAL_CODES.has(code);
}

/**
 * The player-facing wording for a terminal failure.
 *
 * Each says what happened *and* what to do, because "invalid token" alone
 * tells a player nothing they can act on. The instruction is always the
 * same — go back to the casino — and that is the point: it is the only
 * thing that helps, so it is stated rather than implied.
 */
const TERMINAL_MESSAGES: Record<string, { headline: string; detail: string }> = {
  token_expired: {
    headline: "This session has expired",
    detail: "Launch the game again from the casino to keep playing. Nothing has been charged for the expired session.",
  },
  token_already_used: {
    headline: "This link has already been used",
    detail: "A launch link works once. Open the game again from the casino to start a new session.",
  },
  invalid_token: {
    headline: "This link is not valid",
    detail: "Open the game from the casino rather than from a saved or shared link.",
  },
  launch_failed: {
    headline: "The game could not be started",
    detail: "Nothing has been charged. Try launching the game again from the casino.",
  },
  graphics_failed: {
    headline: "Graphics could not be started",
    detail:
      "This browser could not provide the graphics the game needs. Try a different browser, or enable hardware acceleration.",
  },
};

/**
 * Maps a phase to what the player sees.
 *
 * A pure function of state for the same reason enablement is: the status
 * line and the buttons must never disagree. A client that says "Ready"
 * while its spin button is disabled is worse than one that says nothing,
 * because the player concludes the button is broken.
 */
export function presentStatus(state: GameState): StatusPresentation {
  switch (state.phase) {
    case "idle":
      return { headline: "Ready", tone: "neutral", actionable: true };

    case "spinning":
      return { headline: "Spinning…", tone: "busy", actionable: false };

    case "revealing":
      return { headline: "Spinning…", tone: "busy", actionable: true };

    case "bonus":
      return { headline: "Bonus round", tone: "good", actionable: true };

    case "offline":
      return {
        headline: "Reconnecting…",
        // Says what is being preserved, because the player's real question
        // during a disconnect is whether their money is safe. It is: the
        // balance and any open round live on the server.
        detail: "Your balance and any round in progress are safe on the server.",
        tone: "bad",
        actionable: false,
      };

    case "unrecoverable": {
      const message = TERMINAL_MESSAGES[state.code];
      if (message) return { ...message, tone: "bad", actionable: false };
      // An unrecognised code still gets a usable sentence rather than the
      // raw code. The code is appended so support can act on a screenshot,
      // which is the only reason to show it at all.
      return {
        headline: "This session has ended",
        detail: `Launch the game again from the casino to keep playing. (${state.code})`,
        tone: "bad",
        actionable: false,
      };
    }
  }
}
