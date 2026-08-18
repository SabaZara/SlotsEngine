import type { Db } from "mongodb";
import type { AuditLogEntry } from "@slots-engine/shared-types";

/**
 * The write moved to `@slots-engine/mongo-schemas`, which owns the
 * `auditLogs` collection and its indexes, once the integration API started
 * recording player-limit changes to the same collection. Two services
 * writing one audit record through two copies of the same function is the
 * drift F24 is about — and this is the record whose whole value is that its
 * writers cannot shape it.
 *
 * Re-exported rather than replaced at every call site: the callers here are
 * correct as written, and rewriting a dozen imports would be churn that
 * hides the one change that matters in a diff.
 */
export { writeAuditLog } from "@slots-engine/mongo-schemas";

export interface AuditQuery {
  entityId?: string;
  entityType?: string;
  actorUserId?: string;
  action?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Bounds a caller's requested page size into `[1, MAX_LIMIT]`.
 *
 * The `Number.isFinite` check is the whole point and is not defensive
 * padding (F22). `routes/audit.ts` produces this value with `Number(limit)`
 * straight off a query string, so `?limit=abc` arrives as `NaN` — and *no*
 * comparison with `NaN` is ever true, so `Math.min(Math.max(NaN, 1), 500)`
 * is `NaN`, not a clamped number. The driver then reads a `NaN` limit as
 * **no limit at all** and returns the entire collection, through the one
 * expression whose purpose is preventing exactly that.
 *
 * A rejected value falls back to the default rather than to the maximum:
 * the caller asked for something unintelligible, which is no reason to hand
 * them the largest possible scan.
 *
 * Rounding down matters too — the driver truncates a fractional limit, so
 * flooring here keeps this function's answer and the database's identical
 * rather than merely close.
 */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT);
}

/** Newest first — the read pattern is always "what happened recently", and
 * the `entity_timeline` index is declared to match. */
export async function readAuditLog(db: Db, query: AuditQuery): Promise<AuditLogEntry[]> {
  const filter: Record<string, unknown> = {};
  if (query.entityId) filter.entityId = query.entityId;
  if (query.entityType) filter.entityType = query.entityType;
  if (query.actorUserId) filter.actorUserId = query.actorUserId;
  if (query.action) filter.action = query.action;

  const limit = clampLimit(query.limit);
  const docs = await db.collection("auditLogs").find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
  return docs.map(({ _id, ...rest }) => rest as unknown as AuditLogEntry);
}
