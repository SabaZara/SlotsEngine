import type { PaylinePath } from "@slots-engine/shared-types";

/**
 * Payline editing, as pure functions.
 *
 * Separated from the component for the same reason the player client's spin
 * timing is: this is the part that can be wrong without looking wrong. An
 * off-by-one when resizing a grid, or a `null` mishandled as a zero, produces
 * a payline that publishes cleanly and then pays the wrong positions — which
 * nobody notices until a player is paid incorrectly.
 */

/**
 * Cycles a cell through: not-on-this-line → row 0 → row 1 → … → back to off.
 *
 * A single click target with a cycle, rather than a dropdown per reel,
 * because a designer builds a line by tracing its shape across the grid.
 * `null` (this reel isn't part of the line) is a real, deliberate state in
 * the schema, so it is part of the cycle rather than a separate control.
 */
export function cycleCell(path: PaylinePath, reel: number, row: number, rows: number): PaylinePath {
  const next = [...path];
  const current = next[reel];
  // Clicking the row that is already selected clears the reel; clicking a
  // different row moves the line to it.
  next[reel] = current === row ? null : row;
  // `rows` is unused in the simple case but keeps the signature honest for
  // callers that resize; guard against a row that no longer exists.
  if (next[reel] !== null && (next[reel] as number) >= rows) next[reel] = null;
  return next;
}

/**
 * Reshapes every payline to a new grid.
 *
 * Called whenever the grid changes, because a stale-shaped payline is the
 * single most common way a draft becomes unpublishable — the API rejects a
 * payline whose length no longer matches `grid.reels`, and without this the
 * designer would have to fix each line by hand after every resize.
 *
 * Added reels start as `null` (not part of the line) rather than row 0: a
 * guess that silently extends a line changes what the game pays, whereas
 * `null` is visibly incomplete and asks to be filled in.
 */
export function reshapePaylines(paylines: PaylinePath[], reels: number, rows: number): PaylinePath[] {
  return paylines.map((path) => {
    const next: PaylinePath = [];
    for (let reel = 0; reel < reels; reel++) {
      const existing = path[reel];
      // Clamp a row that no longer exists after a shrink, rather than
      // dropping the whole line.
      next.push(existing === undefined || existing === null || existing >= rows ? null : existing);
    }
    return next;
  });
}

/** A straight line across the middle row — the sane default for a new line. */
export function defaultPayline(reels: number, rows: number): PaylinePath {
  const middle = Math.floor(rows / 2);
  return Array.from({ length: reels }, () => middle);
}

/**
 * Whether a line would actually pay.
 *
 * Evaluation walks left to right from reel 0 and stops at the first gap, so
 * a line that doesn't start at reel 0, or that has a hole in the middle,
 * silently pays less than its author intended — or nothing at all. That is
 * legal config, not a validation error, so the editor warns rather than
 * blocks.
 */
export function paylineWarning(path: PaylinePath): string | null {
  if (path.every((row) => row === null)) return "This line covers no reels and can never pay.";
  if (path[0] === null) return "Wins are counted from reel 1 rightwards, so this line can never pay.";

  const firstGap = path.indexOf(null);
  if (firstGap !== -1 && path.slice(firstGap).some((row) => row !== null)) {
    return `Only reels 1-${firstGap} count: a run stops at the first gap.`;
  }
  return null;
}

/** How many reels of a line actually participate — the effective length,
 * which is what the paytable is looked up against. */
export function effectiveLength(path: PaylinePath): number {
  const firstGap = path.indexOf(null);
  return firstGap === -1 ? path.length : firstGap;
}
