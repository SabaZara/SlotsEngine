import type { PlayerLimit } from "./decide.js";
import { LIMIT_PERIODS, type LimitPeriod } from "./periods.js";

/**
 * Telling a loosening apart from a tightening.
 *
 * **The control this exists for.** A player who is chasing losses will
 * raise their own limit mid-session, and a limit that can be lifted in the
 * moment it starts to bind is not a limit — it is a speed bump. Every
 * regulator that mandates these controls therefore requires that
 * *loosening* take effect only after a delay, while *tightening* takes
 * effect at once. The asymmetry is the whole point: protecting someone
 * from a decision they make under pressure must never mean delaying their
 * decision to be safer.
 *
 * Pure, and separated from the route for the usual reason here — this is
 * the part that can be *wrong about what protects someone*, and it should
 * be decidable from its inputs alone.
 */

export type LimitChangeKind = "loosening" | "tightening" | "unchanged";

export interface LimitChange {
  period: LimitPeriod;
  /** Which ceiling moved. Both may change in one submission. */
  field: "maxStake" | "maxLoss";
  kind: LimitChangeKind;
  from?: number;
  to?: number;
}

function ceilingOf(limits: PlayerLimit[], period: LimitPeriod, field: "maxStake" | "maxLoss"): number | undefined {
  return limits.find((limit) => limit.period === period)?.[field];
}

/**
 * Compares two ceilings for one field.
 *
 * **An absent ceiling is unlimited, not zero**, and getting that backwards
 * inverts every judgement here: removing a limit would read as tightening
 * to nothing, which is the single most dangerous possible misreading — a
 * player could clear every protection they have and have it apply
 * instantly. So absent is treated as infinity, and going *to* absent is a
 * loosening while coming *from* absent is a tightening.
 */
function classify(from: number | undefined, to: number | undefined): LimitChangeKind {
  if (from === to) return "unchanged";

  const before = from ?? Number.POSITIVE_INFINITY;
  const after = to ?? Number.POSITIVE_INFINITY;

  if (after > before) return "loosening";
  if (after < before) return "tightening";
  return "unchanged";
}

/**
 * Every field that moved between two sets of limits.
 *
 * Returns changes for all periods and both fields rather than a single
 * verdict, because a submission can loosen one and tighten another in the
 * same call — and the two halves must then be treated differently rather
 * than the whole request being accepted or rejected together. A player
 * lowering their daily limit while raising their monthly one is doing
 * something reasonable, and refusing both would teach them not to tighten.
 */
export function diffLimits(current: PlayerLimit[], proposed: PlayerLimit[]): LimitChange[] {
  const changes: LimitChange[] = [];

  for (const period of LIMIT_PERIODS) {
    for (const field of ["maxStake", "maxLoss"] as const) {
      const from = ceilingOf(current, period, field);
      const to = ceilingOf(proposed, period, field);
      const kind = classify(from, to);
      if (kind === "unchanged") continue;

      changes.push({
        period,
        field,
        kind,
        // Spread conditionally rather than assigning `undefined`: these go
        // into an audit record, and `{ from: undefined }` survives as a
        // present-but-null key through some serialisers while genuinely
        // meaning "there was no ceiling". Same hazard as F25.
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
    }
  }

  return changes;
}

/**
 * The set that may apply immediately.
 *
 * Built by *starting from what is in force and applying only the
 * tightenings*, rather than by removing loosenings from the proposal. The
 * two are not the same when a period is absent from the proposal: dropping
 * a limit is itself a loosening, and rebuilding from the proposal would
 * silently honour it. Starting from the current state means anything not
 * explicitly tightened survives untouched, which is the safe direction.
 */
export function applyTighteningsOnly(current: PlayerLimit[], proposed: PlayerLimit[]): PlayerLimit[] {
  const byPeriod = new Map<LimitPeriod, PlayerLimit>();
  for (const limit of current) byPeriod.set(limit.period, { ...limit });

  for (const change of diffLimits(current, proposed)) {
    if (change.kind !== "tightening") continue;

    const existing = byPeriod.get(change.period) ?? { period: change.period };
    // `to` is always defined on a tightening — a move to unlimited is a
    // loosening by construction — but the compiler cannot see that.
    if (change.to !== undefined) existing[change.field] = change.to;
    byPeriod.set(change.period, existing);
  }

  // Ordered by the canonical period order rather than by insertion, so the
  // stored document is stable across submissions and a diff of two audit
  // records shows only what actually changed.
  return LIMIT_PERIODS.map((period) => byPeriod.get(period)).filter(
    (limit): limit is PlayerLimit => limit !== undefined,
  );
}
