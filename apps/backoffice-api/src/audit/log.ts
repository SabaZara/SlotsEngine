import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { AuditLogEntry } from "@slots-engine/shared-types";

/**
 * Appends one audit entry. There is deliberately no update or delete
 * anywhere in this module: a log its own users can rewrite answers no
 * question worth asking.
 *
 * Never throws into the caller's path. An audit write failing must not roll
 * back a publish that already succeeded — losing the record of a change is
 * bad, but losing the change itself because we couldn't describe it is
 * worse. The failure is surfaced to the caller's logger instead.
 */
export async function writeAuditLog(
  db: Db,
  entry: Omit<AuditLogEntry, "entryId" | "timestamp">,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await db.collection("auditLogs").insertOne({
      // The caller's fields are spread FIRST so the generated identity and
      // timestamp overwrite anything supplied, rather than being overwritten
      // by it. `Omit<..., "entryId" | "timestamp">` already forbids passing
      // them, so this only matters where the type has been cast around — but
      // this is the one record whose value is that its writers cannot shape
      // it, and "a caller could backdate an entry if it lied about its type"
      // is not a sentence that should be true of an audit log. Same shape as
      // F18: the ordering was the only thing standing between a safe-looking
      // function and a forgeable one.
      ...entry,
      entryId: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    onError?.(err);
  }
}

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
