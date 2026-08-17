import type { CreateIndexesOptions, Db, IndexDirection } from "mongodb";

/**
 * **The indexes in this file are the concurrency design.** Most of this
 * system's exactly-once guarantees are declared here, not in application
 * code: the house idiom throughout is "insert and let a unique index
 * arbitrate the race", because an application-level read-then-write cannot
 * survive two concurrent callers no matter how carefully it is written.
 *
 * Validators are deliberately loose (`additionalProperties: true`). They
 * pin down identity and idempotency fields — the ones a bug would corrupt
 * expensively — without becoming a second source of truth that drifts from
 * the TypeScript types.
 */
export interface IndexDefinition {
  keys: Record<string, IndexDirection>;
  options?: CreateIndexesOptions;
}

export interface CollectionDefinition {
  name: string;
  validator?: Record<string, unknown>;
  indexes: IndexDefinition[];
}

export const COLLECTIONS: CollectionDefinition[] = [
  {
    name: "games",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["gameId", "version", "status"],
        additionalProperties: true,
        properties: {
          gameId: { bsonType: "string" },
          version: { bsonType: "int" },
          status: { enum: ["draft", "published", "archived"] },
        },
      },
    },
    indexes: [{ keys: { gameId: 1 }, options: { unique: true, name: "gameId_unique" } }],
  },
  {
    // Append-only publish history. A round records the `gameVersion` it ran
    // under, so any historical round can be reconstructed against the exact
    // math in force at the time — which is precisely what a regulator asks
    // for, and impossible if published versions are ever overwritten.
    name: "gameVersions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["gameId", "version"],
        additionalProperties: true,
        properties: {
          gameId: { bsonType: "string" },
          version: { bsonType: "int" },
        },
      },
    },
    indexes: [{ keys: { gameId: 1, version: 1 }, options: { unique: true, name: "gameId_version_unique" } }],
  },
  {
    name: "rounds",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["roundId", "operatorId", "playerId", "gameId", "status"],
        additionalProperties: true,
        properties: {
          roundId: { bsonType: "string" },
          operatorId: { bsonType: "string" },
          playerId: { bsonType: "string" },
          gameId: { bsonType: "string" },
          status: { enum: ["open", "resolved", "recovered", "voided"] },
        },
      },
    },
    indexes: [
      { keys: { roundId: 1 }, options: { unique: true, name: "roundId_unique" } },
      { keys: { operatorId: 1, playerId: 1, createdAt: -1 }, options: { name: "operator_player_recent" } },
      // Only rounds actually created from a client request carry a
      // clientRequestId. This is what lets a retried spin short-circuit to
      // the original round instead of spinning — and charging — twice.
      //
      // partialFilterExpression, NOT sparse. On a COMPOUND index, sparse
      // only skips a document when every indexed field is missing — and
      // operatorId and playerId are always present. So a sparse index here
      // indexes every round, treating an absent clientRequestId as null,
      // and a player's second spin without one collides with their first:
      // E11000, surfaced as a 500. Under load that is nearly every spin.
      //
      // The partial filter is what actually expresses "index only the
      // rounds that carry a clientRequestId". Found by the load check —
      // no unit test could see it, because the in-memory stand-in models
      // the index we intended rather than the one Mongo builds.
      {
        keys: { operatorId: 1, playerId: 1, clientRequestId: 1 },
        options: {
          unique: true,
          partialFilterExpression: { clientRequestId: { $type: "string" } },
          name: "operator_player_clientRequest_idempotency",
        },
      },
    ],
  },
  {
    name: "players",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["operatorId", "playerId", "balance"],
        additionalProperties: true,
        properties: {
          operatorId: { bsonType: "string" },
          playerId: { bsonType: "string" },
          balance: { bsonType: "number" },
        },
      },
    },
    indexes: [{ keys: { operatorId: 1, playerId: 1 }, options: { unique: true, name: "operator_player_unique" } }],
  },
  {
    name: "transactions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["transactionId", "operatorId", "playerId", "type", "amount", "status"],
        additionalProperties: true,
        properties: {
          transactionId: { bsonType: "string" },
          operatorId: { bsonType: "string" },
          playerId: { bsonType: "string" },
          type: { enum: ["debit", "credit"] },
          amount: { bsonType: "number" },
          status: { enum: ["pending", "completed", "failed", "voided"] },
        },
      },
    },
    indexes: [
      // THE idempotency guarantee: a retry carrying the same transactionId
      // hits this index rather than creating a second movement of money.
      {
        keys: { operatorId: 1, transactionId: 1 },
        options: { unique: true, name: "operator_transaction_idempotency" },
      },
      { keys: { roundId: 1 }, options: { name: "roundId_lookup" } },
      { keys: { operatorId: 1, playerId: 1, createdAt: -1 }, options: { name: "operator_player_statement" } },
    ],
  },
  {
    name: "bonusSessions",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["bonusSessionId", "operatorId", "playerId", "gameId", "moduleId", "status"],
        additionalProperties: true,
        properties: {
          bonusSessionId: { bsonType: "string" },
          operatorId: { bsonType: "string" },
          playerId: { bsonType: "string" },
          gameId: { bsonType: "string" },
          moduleId: { bsonType: "string" },
          status: { enum: ["active", "resolved", "abandoned"] },
        },
      },
    },
    indexes: [
      { keys: { bonusSessionId: 1 }, options: { unique: true, name: "bonusSessionId_unique" } },
      { keys: { operatorId: 1, playerId: 1, status: 1 }, options: { name: "operator_player_active_lookup" } },
      // One bonus session per round, enforced rather than assumed: a
      // duplicated auto-start after a reconnect would otherwise be able to
      // open a second paying session for a single triggering spin.
      { keys: { roundId: 1 }, options: { unique: true, name: "roundId_unique" } },
      // Drives the abandonment sweep without a collection scan.
      { keys: { status: 1, createdAt: 1 }, options: { name: "status_age_sweep" } },
      // Archival, NOT expiry — the distinction is the whole of TODO item 5.
      //
      // A TTL keyed on the session's own deadline would delete a row the
      // moment it timed out, and `abandoned` is a meaningful state rather
      // than garbage: a player returning to a timed-out bonus gets a precise
      // 410 `bonus_session_abandoned` ("that bonus round timed out"). Delete
      // the row and they get "no such session" instead, which is strictly
      // worse information on a money path.
      //
      // So the TTL is driven by a SEPARATE field, `archiveAfter`, set far
      // beyond the session's lifetime — long enough to answer a player
      // dispute about a bonus that paid, or did not. `expireAfterSeconds: 0`
      // means "delete when the date in the field passes", so the retention
      // window is chosen where the row is written, not here.
      //
      // A session with no `archiveAfter` is never reaped, which is the safe
      // direction: rows predating this index keep accumulating rather than
      // vanishing on the deploy that adds it.
      { keys: { archiveAfter: 1 }, options: { expireAfterSeconds: 0, name: "archiveAfter_ttl" } },
    ],
  },
  {
    // Single-use enforcement for launch tokens. The token's own signature
    // and expiry check is stateless, but "this one has been used" needs
    // somewhere to live. TTL matches token expiry — nothing needs
    // remembering past the point the token would fail its own expiry check.
    name: "usedLaunchTokens",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["jti", "expireAt"],
        additionalProperties: true,
        properties: {
          jti: { bsonType: "string" },
          expireAt: { bsonType: "date" },
        },
      },
    },
    indexes: [
      { keys: { jti: 1 }, options: { unique: true, name: "jti_unique" } },
      { keys: { expireAt: 1 }, options: { expireAfterSeconds: 0, name: "expireAt_ttl" } },
    ],
  },
  {
    // Backoffice authoring state. A draft is freely editable and never
    // playable — publishing is what moves it into `games`.
    name: "gameDrafts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["gameId"],
        additionalProperties: true,
        properties: { gameId: { bsonType: "string" } },
      },
    },
    indexes: [{ keys: { gameId: 1 }, options: { unique: true, name: "gameId_unique" } }],
  },
  {
    name: "users",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["userId", "email", "roles"],
        additionalProperties: true,
        properties: {
          userId: { bsonType: "string" },
          email: { bsonType: "string" },
          roles: { bsonType: "array" },
        },
      },
    },
    indexes: [
      { keys: { userId: 1 }, options: { unique: true, name: "userId_unique" } },
      // Unique, because two accounts sharing an email is an ambiguity the
      // login path has no correct way to resolve.
      { keys: { email: 1 }, options: { unique: true, name: "email_unique" } },
    ],
  },
  {
    /**
     * Failed-login counters, keyed by the ATTEMPTED email rather than by a
     * user id — an attempt against an address that does not exist has to be
     * counted too, or the observable behaviour differs between a real and
     * an unknown address and the login route's anti-enumeration work is
     * undone. See `auth/loginThrottle.ts`.
     *
     * This is throttling state, not a record of anything: it is safe to
     * lose. A restart or an expiry granting an attacker a fresh allowance
     * is the same position the per-IP limiter is already in.
     */
    name: "loginAttempts",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["key"],
        additionalProperties: true,
        properties: {
          key: { bsonType: "string" },
          // `number` — the alias that accepts every numeric BSON type —
          // matching `balance` and `amount` above rather than inventing a
          // second convention.
          //
          // This is the fix for a bug, not a style preference. The first
          // version specified `["long", "int"]`, the types these values
          // conceptually *are*; but every JavaScript number serialises to
          // BSON `double`, including integers, so Mongo rejected all of
          // them with "Document failed validation" and each failed login
          // became a 500.
          //
          // No unit test could see it: the in-memory stand-in has no
          // validator, so it models the schema we intended rather than the
          // one Mongo enforces. Exactly the shape of bug F1 in
          // docs/TODO.md, and found the same way — by running it.
          attempts: { bsonType: "number" },
          // Millisecond epochs, matching the `Date.now()` the throttle
          // compares against. Deliberately not a BSON date: that would put
          // two time representations in one comparison, which is how
          // off-by-a-timezone bugs get in.
          lastAttemptAt: { bsonType: ["number", "null"] },
          lockedUntil: { bsonType: ["number", "null"] },
          // The one real date, because a TTL index requires one.
          expiresAt: { bsonType: ["date", "null"] },
        },
      },
    },
    indexes: [
      { keys: { key: 1 }, options: { unique: true, name: "login_key_unique" } },
      // Expiry as a property of the data rather than of a process being
      // alive. `expiresAt` is a real BSON date because a TTL index requires
      // one — the millisecond fields above are what the throttle compares,
      // this is only what Mongo reaps.
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: "attempt_ttl" } },
    ],
  },
  {
    /**
     * The operators this platform serves — the referent for the
     * `operatorId` that keys every round, transaction, player and bonus
     * session. Until this collection existed, that key pointed at nothing:
     * any string reaching the money path was accepted as an operator.
     *
     * `apiSecret` holds the `enc:` ciphertext from `@slots-engine/secrets`,
     * never plaintext. The validator cannot enforce that — a `pattern` here
     * would be a second place to change if the format ever moves, and
     * `additionalProperties: true` is the house convention — so it is
     * enforced at the one write path, in the backoffice's operator routes.
     */
    name: "operators",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["operatorId", "name", "integrationType", "apiKeyId", "apiSecret", "enabledGameIds"],
        additionalProperties: true,
        properties: {
          operatorId: { bsonType: "string" },
          name: { bsonType: "string" },
          integrationType: { enum: ["direct", "reverse"] },
          apiKeyId: { bsonType: "string" },
          apiSecret: { bsonType: "string" },
          enabledGameIds: { bsonType: "array" },
        },
      },
    },
    indexes: [
      { keys: { operatorId: 1 }, options: { unique: true, name: "operatorId_unique" } },
      // Unique because this is the lookup key on every authenticated
      // request: two operators sharing an `apiKeyId` would make
      // "which secret verifies this signature" ambiguous, and `findOne`
      // would resolve it by whichever document Mongo reached first. That
      // is an authentication bypass in the shape of a data-entry mistake,
      // so it is refused at write time rather than handled at read time.
      { keys: { apiKeyId: 1 }, options: { unique: true, name: "apiKeyId_unique" } },
    ],
  },
  {
    /**
     * Replay defence for the integration API.
     *
     * A signature covers the exact (timestamp, method, url, body) tuple, so
     * a byte-identical replay necessarily carries a byte-identical
     * signature. Recording each one and refusing a repeat is what makes a
     * captured request unusable a second time — without this, only the
     * money routes were replay-safe (via `transactionId` idempotency, which
     * is a different mechanism and covers a different thing), and a
     * captured GET could be replayed indefinitely inside the skew window.
     *
     * **The unique index is the mechanism, not a constraint on it.** The
     * check is an `insertOne` that either succeeds or raises 11000; there
     * is deliberately no find-then-insert, because two concurrent replays
     * of the same request would both find nothing and both proceed. Same
     * house idiom as the transactions idempotency index: let the index
     * arbitrate the race.
     *
     * Keyed on `(operatorId, signature)` rather than `signature` alone.
     * Two operators cannot realistically collide on an HMAC-SHA256 output,
     * so this is not about collisions — it is so that one operator's
     * traffic can never cause a refusal on another's, whatever ends up in
     * this collection.
     */
    name: "usedRequestSignatures",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["operatorId", "signature", "expireAt"],
        additionalProperties: true,
        properties: {
          operatorId: { bsonType: "string" },
          signature: { bsonType: "string" },
          expireAt: { bsonType: "date" },
        },
      },
    },
    indexes: [
      { keys: { operatorId: 1, signature: 1 }, options: { unique: true, name: "operator_signature_unique" } },
      // Nothing needs remembering past the point the timestamp check would
      // refuse the request anyway, so the TTL is the skew window plus a
      // margin — set where the row is written. Unbounded growth here would
      // otherwise be the cost of replay protection: this collection takes
      // one row per authenticated request, forever.
      { keys: { expireAt: 1 }, options: { expireAfterSeconds: 0, name: "expireAt_ttl" } },
    ],
  },
  {
    // Append-only. Nothing in this codebase updates or deletes from here.
    name: "auditLogs",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["entryId", "actorUserId", "action", "entityType", "entityId", "timestamp"],
        additionalProperties: true,
        properties: {
          entryId: { bsonType: "string" },
          actorUserId: { bsonType: "string" },
          action: { bsonType: "string" },
          entityType: { bsonType: "string" },
          entityId: { bsonType: "string" },
          timestamp: { bsonType: "string" },
        },
      },
    },
    indexes: [
      { keys: { entryId: 1 }, options: { unique: true, name: "entryId_unique" } },
      // The read is always "what happened to this thing recently".
      { keys: { entityId: 1, timestamp: -1 }, options: { name: "entity_timeline" } },
      { keys: { timestamp: -1 }, options: { name: "recent_activity" } },
    ],
  },
  {
    name: "rtpSimulationRuns",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["runId", "gameId", "gameVersion", "simCount", "resultRtp"],
        additionalProperties: true,
        properties: {
          runId: { bsonType: "string" },
          gameId: { bsonType: "string" },
          gameVersion: { bsonType: "int" },
          // "number", not "long" or "double": a plain JS number serializes
          // as whichever concrete BSON numeric type fits (int32 for a round
          // 200000, double otherwise), never reliably one specific type.
          // Requiring a specific one is a latent bug that only surfaces on
          // the first real insert.
          simCount: { bsonType: "number" },
          resultRtp: { bsonType: "number" },
          baseRtp: { bsonType: "number" },
          bonusRtp: { bsonType: "number" },
        },
      },
    },
    indexes: [
      { keys: { runId: 1 }, options: { unique: true, name: "runId_unique" } },
      { keys: { gameId: 1, gameVersion: 1 }, options: { name: "game_version_lookup" } },
    ],
  },
];

/**
 * Idempotently creates every collection's validator and indexes. Safe to
 * run on every boot: `collMod` on an already-conformant collection is a
 * no-op, and `createIndexes` ignores an index that already exists with the
 * same spec.
 *
 * An index whose *definition changed* is the case that needs care. Mongo
 * does not update one in place — `createIndexes` fails with
 * IndexOptionsConflict (85) when the name already exists with different
 * options. Left unhandled that turns a corrected index into a service that
 * will not boot on any database created before the correction, which is
 * how a schema fix becomes an outage. So a conflict is resolved by
 * dropping the old index and rebuilding it to the current definition.
 */
export async function applySchemas(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const def of COLLECTIONS) {
    if (!existing.has(def.name)) {
      await db.createCollection(def.name, def.validator ? { validator: def.validator } : undefined);
    } else if (def.validator) {
      await db.command({ collMod: def.name, validator: def.validator, validationLevel: "moderate" });
    }

    for (const ix of def.indexes) {
      const spec = { key: ix.keys, ...ix.options };
      try {
        await db.collection(def.name).createIndexes([spec]);
      } catch (err) {
        // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict: same name,
        // different definition. Rebuilding is safe here because every index
        // in this file is derived from the documents themselves.
        const code = (err as { code?: number }).code;
        if ((code !== 85 && code !== 86) || !ix.options?.name) throw err;
        await db.collection(def.name).dropIndex(ix.options.name);
        await db.collection(def.name).createIndexes([spec]);
      }
    }
  }
}
