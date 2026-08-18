import type { PlayerLimit } from "./decide.js";

/**
 * A loosening that has been asked for but is not yet in force.
 *
 * **Stored as the full set that will apply, not as a delta.** A delta would
 * have to be re-derived against whatever the limits are when it matures,
 * and the answer changes if the player tightened something in between —
 * which is precisely the sequence this feature invites. Storing the target
 * makes maturing a replacement rather than a re-computation, and makes the
 * audit record self-explanatory: it says what the player will end up with.
 */
export interface PendingLimitChange {
  /** Epoch milliseconds. The whole set applies at once when this passes. */
  effectiveAt: number;
  limits: PlayerLimit[];
  requestedAt: number;
}

/**
 * How long a loosening waits.
 *
 * 24 hours because it is the shortest period any of the mandating
 * regulators accept, and because the failure this guards against is
 * measured in a session rather than in days: the point is that the player
 * who raises a limit while chasing is not the person who receives it.
 *
 * A constant rather than an operator setting, deliberately. Making it
 * configurable invites an operator to configure it to zero, which is the
 * one value that makes the control meaningless while leaving every screen
 * and audit record looking as though it exists. If a market ever requires
 * longer, that is a change to this number with a migration for pending
 * rows, not a per-operator dial.
 */
export const LOOSENING_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a pending change is due.
 *
 * Takes `now` rather than reading the clock, so the boundary is testable
 * and so a caller that has already taken a clock reading uses the same one
 * throughout — the money path takes exactly one reading per round for this
 * reason.
 */
export function isDue(pending: PendingLimitChange | undefined, now: number): boolean {
  return pending !== undefined && now >= pending.effectiveAt;
}

/**
 * What is actually in force right now.
 *
 * The single place that answers "which ceilings apply", so the money path
 * and the screens cannot disagree. A due change is returned as though it
 * had already been written, which means enforcement is correct even before
 * anything persists it — the alternative would leave a window where a
 * matured loosening is not yet honoured because no write has happened
 * since, and the player would be held to a limit that expired.
 */
export function effectiveLimits(
  stored: PlayerLimit[],
  pending: PendingLimitChange | undefined,
  now: number,
): PlayerLimit[] {
  return isDue(pending, now) ? pending!.limits : stored;
}
