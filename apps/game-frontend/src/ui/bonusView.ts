/**
 * What a bonus round's public state means for the screen.
 *
 * Pure, and separated from the DOM for the usual reason in this repo: the
 * *decisions* here can be wrong in ways a screenshot will not reveal — a
 * tile that stays clickable after it was picked, a spin button live while
 * the reels are still moving, a resolved round that never hands control
 * back. Those are testable; drawing them is not.
 *
 * **Dispatch is on the shape of the view, never on a module id.** The server
 * decides which module is running and sends only what the player is allowed
 * to see; a view carrying `remaining` is a free-spins round whatever it is
 * called. Keying off the id would mean the client holds a second copy of the
 * module list — F24's exact failure, one layer over.
 */

/** What the panel should show. `null` means the panel is hidden entirely. */
export type BonusPanelKind = "pick" | "freeSpins" | "resolved" | "unknown";

export interface PickTile {
  index: number;
  /** Already revealed, so it must not be clickable again. The server refuses
   * a duplicate claim regardless — this is presentation, not the guarantee. */
  revealed: boolean;
  /** What to show on the face: a multiplier, a blank marker, or nothing yet. */
  label: string;
}

export interface PickPanel {
  kind: "pick";
  tiles: PickTile[];
  /** True once no tile can usefully be clicked, so the panel can say so
   * rather than leaving a player clicking a dead grid. */
  exhausted: boolean;
}

export interface FreeSpinsPanel {
  kind: "freeSpins";
  remaining: number;
  multiplier: number;
  accumulatedMinor: number;
  retriggers: number;
  /** Whether a spin can be requested right now. */
  canSpin: boolean;
}

export interface ResolvedPanel {
  kind: "resolved";
  totalWinMinor: number;
}

export interface UnknownPanel {
  kind: "unknown";
}

export type BonusPanel = PickPanel | FreeSpinsPanel | ResolvedPanel | UnknownPanel;

/** A tile whose prize is a blank — the pick round's stopping rule. */
export const BLANK_LABEL = "✕";
/** A tile not yet revealed. */
export const HIDDEN_LABEL = "?";

interface RawState {
  status?: string;
  totalWin?: number;
  view?: Record<string, unknown>;
}

/**
 * Reads a number out of a view that is typed `Record<string, unknown>`.
 *
 * Defaults rather than throwing, because this data crosses a socket and a
 * malformed field must not take the panel down mid-round — the player would
 * lose access to a bonus they are owed. A wrong number renders a wrong
 * panel; an exception renders none.
 */
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Turns a bonus session's public state into what the panel should draw.
 *
 * `resolved` is checked first and unconditionally: a resolved round is over
 * whatever else its view happens to carry, and treating it as still playable
 * would leave a player clicking at a settled result.
 */
export function readBonusPanel(state: RawState | null | undefined): BonusPanel {
  if (!state) return { kind: "unknown" };

  if (state.status === "resolved") {
    return { kind: "resolved", totalWinMinor: num(state.totalWin) };
  }

  const view = state.view ?? {};

  // Shape, not id. A view carrying `remaining` is a free-spins round.
  if ("remaining" in view) {
    const remaining = num(view.remaining);
    return {
      kind: "freeSpins",
      remaining,
      multiplier: num(view.winMultiplier, 1),
      accumulatedMinor: num(view.accumulatedWin),
      retriggers: num(view.retriggers),
      // No spins left means the round is finishing; offering the button
      // would send a step the server must refuse.
      canSpin: remaining > 0,
    };
  }

  if ("tileCount" in view) return readPickPanel(view);

  // A module this build's client does not know how to draw. Reported rather
  // than rendered as an empty panel, so the caller can say something honest
  // instead of showing a blank overlay the player cannot dismiss.
  return { kind: "unknown" };
}

function readPickPanel(view: Record<string, unknown>): PickPanel {
  const tileCount = Math.max(0, Math.floor(num(view.tileCount)));
  const revealed = Array.isArray(view.revealed) ? (view.revealed as unknown[]).map((v) => num(v, -1)) : [];
  const picks = Array.isArray(view.picks)
    ? (view.picks as Array<{ tileIndex?: unknown; multiplier?: unknown }>)
    : [];

  const tiles: PickTile[] = [];
  for (let index = 0; index < tileCount; index++) {
    const pick = picks.find((p) => num(p.tileIndex, -1) === index);
    const isRevealed = revealed.includes(index) || pick !== undefined;
    tiles.push({
      index,
      revealed: isRevealed,
      // `multiplier: null` is the blank that ends the round — distinct from
      // an absent pick, which is simply a tile nobody has touched.
      label: pick ? (pick.multiplier === null ? BLANK_LABEL : `×${num(pick.multiplier)}`) : HIDDEN_LABEL,
    });
  }

  return { kind: "pick", tiles, exhausted: tiles.length > 0 && tiles.every((t) => t.revealed) };
}

/**
 * Whether a tile may be clicked.
 *
 * Separate from `revealed` because the two differ in one case that matters:
 * while a step is in flight, no tile is clickable even though none has been
 * revealed yet. Queuing a second pick before the first resolves is how a
 * player ends up having claimed a tile they never saw.
 */
export function tileClickable(tile: PickTile, stepInFlight: boolean): boolean {
  return !tile.revealed && !stepInFlight;
}
