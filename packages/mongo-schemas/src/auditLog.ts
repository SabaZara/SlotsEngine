import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { AuditLogEntry } from "@slots-engine/shared-types";

/**
 * Appends one audit entry.
 *
 * **Here rather than in a service** because two of them now write to this
 * collection — the backoffice records what staff did, and the integration
 * API records what an operator did to a player's protection limits. A
 * second copy of "how an audit entry is written" is the drift F24 is
 * about, and here the two copies would disagree about the one record whose
 * value is that it cannot be shaped by its writers. This package already
 * owns the collection and its indexes, so it is where the write belongs.
 *
 * There is deliberately no update or delete anywhere near it: a log its own
 * users can rewrite answers no question worth asking.
 *
 * **Never throws into the caller's path.** An audit write failing must not
 * roll back a change that already succeeded — losing the record of a change
 * is bad, but losing the change itself because we could not describe it is
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
      // timestamp overwrite anything supplied, rather than being
      // overwritten by it. `Omit<..., "entryId" | "timestamp">` already
      // forbids passing them, so this only matters where the type has been
      // cast around — but this is the one record whose value is that its
      // writers cannot shape it, and "a caller could backdate an entry if
      // it lied about its type" is not a sentence that should be true of an
      // audit log. Same shape as F18: the ordering was the only thing
      // standing between a safe-looking function and a forgeable one.
      ...entry,
      entryId: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    onError?.(err);
  }
}
