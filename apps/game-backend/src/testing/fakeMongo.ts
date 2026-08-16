/**
 * A minimal in-memory stand-in for the pieces of Mongo this service
 * actually depends on.
 *
 * Deliberately models the two behaviors the money path's correctness rests
 * on, and little else:
 *
 *   1. **Unique indexes that throw code 11000.** Most of this system's
 *      exactly-once guarantees are index-enforced, so a fake without them
 *      would let a test pass while the real thing double-pays.
 *   2. **Atomic `findOneAndUpdate`.** The bonus-step claim depends on
 *      match-and-update being indivisible; a fake that split them would
 *      hide exactly the race the design exists to prevent.
 *
 * What it does NOT model is rollback: `withTransaction` here runs the
 * callback and lets a throw propagate without undoing writes. Tests that
 * depend on real rollback semantics need a live database — see the note in
 * ARCHITECTURE.md on the integration gap.
 */

interface Doc extends Record<string, unknown> {
  _id?: string;
}

interface UniqueIndex {
  keys: string[];
  sparse: boolean;
}

class DuplicateKeyError extends Error {
  readonly code = 11000;
  constructor(collection: string, keys: string[]) {
    super(`E11000 duplicate key error on ${collection} (${keys.join(", ")})`);
  }
}

function get(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], doc);
}

function matches(doc: Doc, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, expected]) => {
    const actual = get(doc, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      if ("$lt" in ops) return (actual as number | string) < (ops.$lt as number | string);
      if ("$gt" in ops) return (actual as number | string) > (ops.$gt as number | string);
      // Mongo's `$ne` matches documents where the field is absent, which is
      // load-bearing here: `active: { $ne: false }` is how "active unless
      // explicitly deactivated" is expressed, and a fake that required the
      // field to exist would silently count zero active administrators.
      if ("$ne" in ops) return actual !== ops.$ne;
    }
    // Matching a scalar against an array field tests membership — how
    // `roles: "super_admin"` finds a user whose `roles` array contains it.
    if (Array.isArray(actual) && !Array.isArray(expected)) return actual.includes(expected);
    return actual === expected;
  });
}

function applyUpdate(doc: Doc, update: Record<string, unknown>): Doc {
  const next: Doc = { ...doc };
  for (const [key, value] of Object.entries((update.$set as Record<string, unknown>) ?? {})) next[key] = value;
  for (const [key, value] of Object.entries((update.$inc as Record<string, number>) ?? {})) {
    next[key] = ((next[key] as number | undefined) ?? 0) + value;
  }
  return next;
}

class FakeCollection {
  private docs: Doc[] = [];
  private uniqueIndexes: UniqueIndex[] = [];
  private counter = 0;

  constructor(private readonly name: string) {}

  addUniqueIndex(keys: string[], sparse = false): void {
    this.uniqueIndexes.push({ keys, sparse });
  }

  private assertUnique(candidate: Doc, ignore?: Doc): void {
    for (const index of this.uniqueIndexes) {
      const values = index.keys.map((k) => get(candidate, k));
      if (index.sparse && values.some((v) => v === undefined)) continue;
      const clash = this.docs.some(
        (doc) => doc !== ignore && index.keys.every((k, i) => get(doc, k) === values[i]),
      );
      if (clash) throw new DuplicateKeyError(this.name, index.keys);
    }
  }

  async insertOne(doc: Doc): Promise<{ insertedId: string }> {
    this.assertUnique(doc);
    // Zero-padded so lexicographic ordering matches insertion order past
    // the tenth document — a real ObjectId is monotonic, and a fake that
    // sorted "10" before "9" would break the tie-break it exists to test.
    const _id = `${this.name}-${String(++this.counter).padStart(12, "0")}`;
    this.docs.push({ ...doc, _id });
    return { insertedId: _id };
  }

  async findOne(
    query: Record<string, unknown>,
    options: { projection?: Record<string, 0 | 1> } = {},
  ): Promise<Doc | null> {
    const doc = this.docs.find((d) => matches(d, query)) ?? null;
    if (!doc || options.projection?._id !== 0) return doc;
    const { _id, ...rest } = doc;
    return rest as Doc;
  }

  /** `matchedCount` is reported alongside `modifiedCount` because callers
   * distinguish them: "no such document" (404) is a different answer from
   * "found it, nothing changed". A fake that omitted it would make a
   * perfectly correct route look broken. */
  async updateOne(
    query: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }> {
    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index >= 0) {
      const updated = applyUpdate(this.docs[index], update);
      this.assertUnique(updated, this.docs[index]);
      this.docs[index] = updated;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (options.upsert) {
      const seed = { ...(update.$setOnInsert as Doc | undefined), ...query };
      const created = applyUpdate(seed as Doc, { $set: update.$set, $inc: update.$inc });
      await this.insertOne(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async countDocuments(query: Record<string, unknown> = {}, options: { limit?: number } = {}): Promise<number> {
    const matched = this.docs.filter((doc) => matches(doc, query)).length;
    return options.limit ? Math.min(matched, options.limit) : matched;
  }

  async updateMany(
    query: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }> {
    let modified = 0;
    this.docs = this.docs.map((doc) => {
      if (!matches(doc, query)) return doc;
      modified++;
      return applyUpdate(doc, update);
    });
    return { modifiedCount: modified };
  }

  /** Atomic by construction here — the match and the write happen in one
   * synchronous block, which is the property the bonus-step claim needs. */
  async findOneAndUpdate(
    query: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: "before" | "after"; upsert?: boolean } = {},
  ): Promise<Doc | null> {
    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index < 0) {
      if (!options.upsert) return null;
      const created = applyUpdate({ ...query } as Doc, update);
      await this.insertOne(created);
      return options.returnDocument === "before" ? null : created;
    }
    const before = this.docs[index];
    const after = applyUpdate(before, update);
    this.assertUnique(after, before);
    this.docs[index] = after;
    return options.returnDocument === "before" ? before : after;
  }

  /**
   * `projection` is honoured for the `_id: 0` case, which is the only form
   * this codebase uses and the one that matters: several routes exclude
   * `_id` so an internal id never reaches a client.
   *
   * Ignoring it made the fake *more permissive* than Mongo — `_id` survived
   * in tests while production correctly stripped it. That is the inverse of
   * the F1/F9 direction and just as misleading: a test asserting "no _id in
   * the response" failed against correct code.
   */
  find(query: Record<string, unknown>, options: { projection?: Record<string, 0 | 1> } = {}) {
    const stripId = options.projection?._id === 0;
    let results = this.docs
      .filter((doc) => matches(doc, query))
      .map((doc) => {
        if (!stripId) return doc;
        const { _id, ...rest } = doc;
        return rest as Doc;
      });
    const cursor = {
      /** Multi-key, in declaration order — needed because the round
       * recovery query breaks a `createdAt` tie with `_id`, and a
       * single-key fake would silently not exercise that. */
      sort(spec: Record<string, 1 | -1>) {
        const keys = Object.entries(spec);
        results = [...results].sort((a, b) => {
          for (const [key, direction] of keys) {
            const av = get(a, key) as string | number;
            const bv = get(b, key) as string | number;
            if (av !== bv) return (av > bv ? 1 : -1) * direction;
          }
          return 0;
        });
        return cursor;
      },
      limit(n: number) {
        results = results.slice(0, n);
        return cursor;
      },
      async next(): Promise<Doc | null> {
        return results[0] ?? null;
      },
      async toArray(): Promise<Doc[]> {
        return results;
      },
    };
    return cursor;
  }

  all(): Doc[] {
    return this.docs;
  }
}

export class FakeDb {
  private collections = new Map<string, FakeCollection>();

  constructor() {
    // Mirrors the real index definitions in @slots-engine/mongo-schemas.
    // These are what make the fake able to catch a double-pay.
    this.collection("transactions").addUniqueIndex(["operatorId", "transactionId"]);
    this.collection("rounds").addUniqueIndex(["roundId"]);
    this.collection("rounds").addUniqueIndex(["operatorId", "playerId", "clientRequestId"], true);
    this.collection("players").addUniqueIndex(["operatorId", "playerId"]);
    this.collection("bonusSessions").addUniqueIndex(["bonusSessionId"]);
    this.collection("bonusSessions").addUniqueIndex(["roundId"]);
    this.collection("usedLaunchTokens").addUniqueIndex(["jti"]);
    this.collection("games").addUniqueIndex(["gameId"]);
  }

  collection(name: string): FakeCollection {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new FakeCollection(name);
      this.collections.set(name, existing);
    }
    return existing;
  }

  async command(): Promise<{ ok: number }> {
    return { ok: 1 };
  }
}

export class FakeMongoClient {
  startSession() {
    return {
      async withTransaction(fn: () => Promise<unknown>): Promise<void> {
        await fn();
      },
      async endSession(): Promise<void> {},
    };
  }
}

/** Casts are confined here so the tests themselves stay readable. */
export function fakeMongo(): { db: any; client: any; raw: FakeDb } {
  const db = new FakeDb();
  return { db: db as any, client: new FakeMongoClient() as any, raw: db };
}
