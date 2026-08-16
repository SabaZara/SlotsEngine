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

/**
 * Query operators this fake implements. Anything else throws rather than
 * being silently ignored.
 *
 * The same treatment F17 gave update operators, and for the same reason —
 * but the query side is worse, because the silent failure looks like data.
 * An unrecognised operator used to fall through to `actual === expected`,
 * comparing a document's value against the operator *object* itself, which
 * is never equal. So `{ n: { $gte: 5 } }` matched **nothing** while real
 * Mongo returned two documents (measured, not assumed). A test asserting
 * "no results" would pass, and a test asserting on results would fail
 * against correct code — F16's confusion and F17's silence at once.
 *
 * None of these are used in this codebase today, which is exactly the state
 * `$unset` was in before F17: latent until the first test needs one, and
 * then costing an afternoon. Adding an operator here should arrive with a
 * conformance test, per the practice in docs/TODO.md section D.
 */
const SUPPORTED_QUERY_OPERATORS = new Set(["$lt", "$gt", "$ne"]);

function matches(doc: Doc, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, expected]) => {
    const actual = get(doc, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      const ops = expected as Record<string, unknown>;
      const operators = Object.keys(ops).filter((k) => k.startsWith("$"));

      // Only refuse when the object actually looks like an operator
      // expression. A plain nested object is a legitimate equality match
      // against a subdocument, and must not be mistaken for a bad query.
      const unsupported = operators.filter((op) => !SUPPORTED_QUERY_OPERATORS.has(op));
      if (unsupported.length > 0) {
        throw new Error(
          `fakeMongo does not implement query operator(s) ${unsupported.join(", ")} on '${key}'. ` +
            `Implement it in matches() and pin it with a conformance test — do NOT let it match silently, ` +
            `which is how it would return zero documents where Mongo returns some.`,
        );
      }

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

    // Mongo compares a subdocument or array query value STRUCTURALLY, and
    // `===` compares references — so `{ grid: { reels: 5, rows: 3 } }`
    // matched nothing here while Mongo matched the document (measured).
    // Same family as F16/F21: the stand-in disagreeing with the database on
    // a query nothing happened to run yet.
    //
    // Mongo's real rule for subdocument equality is order-sensitive on keys,
    // which JSON.stringify happens to reproduce for documents built the same
    // way. That is a narrower guarantee than deep equality and it is the
    // right one to model — a fake that ignored key order would be MORE
    // permissive than Mongo, which is the direction that hides bugs.
    if (expected !== null && typeof expected === "object") {
      return JSON.stringify(actual) === JSON.stringify(expected);
    }

    return actual === expected;
  });
}

/**
 * Operators this fake implements. Anything else throws rather than being
 * ignored — see the check below.
 */
const SUPPORTED_UPDATE_OPERATORS = new Set(["$set", "$inc", "$unset", "$setOnInsert"]);

/**
 * Mongo's projection semantics, to the extent this codebase uses them.
 *
 * Two shapes, and they are not symmetric — which is the whole reason this
 * function exists rather than the `_id === 0` special case that used to be
 * inlined:
 *
 *   **Exclusion** (`{ _id: 0 }`) — keep everything except the named fields.
 *   **Inclusion** (`{ gameId: 1, name: 1 }`) — keep ONLY the named fields,
 *   plus `_id` unless it is explicitly excluded.
 *
 * The fake previously honoured only the first and ignored the second, so a
 * projected query returned whole documents in tests and three fields against
 * real Mongo. That is F16's family again: the stand-in more permissive than
 * the database, so a correct assertion fails against correct code.
 */
function applyProjection(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
  if (!projection) return doc;

  const includes = Object.entries(projection).filter(([key, value]) => value === 1 && key !== "_id");

  if (includes.length > 0) {
    const projected: Doc = {};
    for (const [key] of includes) {
      if (key in doc) projected[key] = doc[key];
    }
    // `_id` rides along with an inclusion projection unless excluded.
    if (projection._id !== 0 && "_id" in doc) projected._id = doc._id;
    return projected;
  }

  const excluded = new Set(Object.entries(projection).filter(([, value]) => value === 0).map(([key]) => key));
  if (excluded.size === 0) return doc;

  const projected: Doc = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!excluded.has(key)) projected[key] = value;
  }
  return projected;
}

function applyUpdate(doc: Doc, update: Record<string, unknown>): Doc {
  // An unrecognised operator used to be dropped in silence, which is the
  // F16 failure mode again: the fake being *more permissive* than Mongo, so
  // a test asking for something unimplemented passes for the wrong reason.
  // Found when a `$unset` in a middleware test quietly did nothing and the
  // test still went green — it was asserting on a field it had not removed.
  // Refusing loudly means the next unsupported operator is a failing test
  // naming itself, not a false pass.
  for (const key of Object.keys(update)) {
    if (key.startsWith("$") && !SUPPORTED_UPDATE_OPERATORS.has(key)) {
      throw new Error(
        `fakeMongo does not implement the update operator ${key}. ` +
          `Add it to applyUpdate rather than working around it — a stand-in that ignores an operator ` +
          `silently makes any test using it meaningless.`,
      );
    }
  }

  const next: Doc = { ...doc };
  for (const [key, value] of Object.entries((update.$set as Record<string, unknown>) ?? {})) setPath(next, key, value);
  for (const [key, value] of Object.entries((update.$inc as Record<string, number>) ?? {})) {
    setPath(next, key, ((get(next, key) as number | undefined) ?? 0) + value);
  }
  // Mongo ignores the value entirely; only the key matters.
  for (const key of Object.keys((update.$unset as Record<string, unknown>) ?? {})) unsetPath(next, key);
  return next;
}

/**
 * Writes `value` at a possibly-dotted path, the way Mongo's update
 * operators address nested fields.
 *
 * A plain `doc[key] = value` created a literal `"grid.rows"` property
 * instead of nesting, so `$set: { "grid.rows": 3 }` left the real
 * `grid.rows` untouched — the fake reporting success while changing nothing
 * the reader would find. `matches()` already resolved dotted paths on the
 * *query* side, which made the asymmetry worse: a test could filter on a
 * nested field and then fail to update it.
 *
 * Copies each level on the way down rather than mutating in place. The
 * caller has spread only the TOP level of the document, so writing straight
 * into a nested object would edit the original — and `findOneAndUpdate`
 * returns the "before" document, which would then show the update it is
 * supposed to predate.
 */
function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = cursor[part];
    cursor[part] = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** The `$unset` counterpart. A path whose parent does not exist is a no-op,
 * as it is in Mongo — not an error. */
function unsetPath(doc: Doc, path: string): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = cursor[parts[i]];
    if (!existing || typeof existing !== "object") return;
    cursor[parts[i]] = { ...(existing as Record<string, unknown>) };
    cursor = cursor[parts[i]] as Record<string, unknown>;
  }
  delete cursor[parts[parts.length - 1]];
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
    return doc ? applyProjection(doc, options.projection) : null;
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
    // Mongo's default is "before", not "after" — the fake used to default
    // the other way. Latent rather than live, because every caller in this
    // codebase passes `returnDocument: "after"` explicitly (the ledger's
    // debit and the bonus-step claim both need the post-update state to
    // decide what happened). But a future caller omitting it would get the
    // updated document in tests and the ORIGINAL one in production — and on
    // the money path that is a balance read from the wrong side of a write.
    const returnAfter = options.returnDocument === "after";

    const index = this.docs.findIndex((doc) => matches(doc, query));
    if (index < 0) {
      if (!options.upsert) return null;
      const created = applyUpdate({ ...query } as Doc, update);
      await this.insertOne(created);
      // An upsert that created the document has no "before" state, and
      // Mongo returns null for it rather than the new document.
      return returnAfter ? created : null;
    }
    const before = this.docs[index];
    const after = applyUpdate(before, update);
    this.assertUnique(after, before);
    this.docs[index] = after;
    return returnAfter ? after : before;
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
    // Projection is applied at the END of the chain, not here, because
    // Mongo sorts before it projects: `.find({}, { projection: { name: 1 } })
    // .sort({ createdAt: -1 })` is a legal query that sorts on a field the
    // caller never receives. Projecting up front would silently make that
    // sort a no-op — the fake agreeing on the documents but not on their
    // order.
    let results = this.docs.filter((doc) => matches(doc, query));
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
        const doc = results[0] ?? null;
        return doc ? applyProjection(doc, options.projection) : null;
      },
      async toArray(): Promise<Doc[]> {
        return results.map((doc) => applyProjection(doc, options.projection));
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
