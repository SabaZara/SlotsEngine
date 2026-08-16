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
      entryId: randomUUID(),
      ...entry,
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

/** Newest first — the read pattern is always "what happened recently", and
 * the `entity_timeline` index is declared to match. */
export async function readAuditLog(db: Db, query: AuditQuery): Promise<AuditLogEntry[]> {
  const filter: Record<string, unknown> = {};
  if (query.entityId) filter.entityId = query.entityId;
  if (query.entityType) filter.entityType = query.entityType;
  if (query.actorUserId) filter.actorUserId = query.actorUserId;
  if (query.action) filter.action = query.action;

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const docs = await db.collection("auditLogs").find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
  return docs.map(({ _id, ...rest }) => rest as unknown as AuditLogEntry);
}
