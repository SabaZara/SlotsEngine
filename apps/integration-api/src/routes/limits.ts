import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import {
  LIMIT_PERIODS,
  LOOSENING_DELAY_MS,
  applyTighteningsOnly,
  diffLimits,
  effectiveLimits,
  type LimitPeriod,
  type PendingLimitChange,
  type PlayerLimit,
} from "@slots-engine/player-limits";
import { writeAuditLog } from "@slots-engine/mongo-schemas";


/** The stored shape: what is in force, plus any loosening still waiting. */
interface StoredLimits {
  limits?: PlayerLimit[];
  pending?: PendingLimitChange;
}

/**
 * Setting and reading a player's protection limits.
 *
 * **This is on the operator API rather than the backoffice on purpose.** In
 * a real deployment the casino owns the player relationship: the player
 * sets their own limits in the operator's account pages, and the operator
 * pushes them here. A backoffice screen where staff set a player's limits
 * would be the wrong primary interface — support reads these, it does not
 * author them — and building only that would leave the actual workflow
 * unreachable, which is F24's shape.
 *
 * **Every route is scoped to `request.operatorId`**, taken from the signed
 * request and never from the body, so one operator cannot read or change
 * another's players. Same rule as the wallet routes beside it.
 */

interface LimitBody {
  playerId?: string;
  limits?: unknown;
}

/** How the API names a rejected body. One code per distinguishable mistake,
 * because "invalid_limits" tells an integrator nothing about which field. */
type Rejection =
  | "invalid_player_id"
  | "invalid_limits"
  | "invalid_period"
  | "duplicate_period"
  | "invalid_amount"
  | "empty_limit";

/**
 * Validates a limits payload.
 *
 * Strict about amounts for the reason money is always strict here: a
 * fractional or negative ceiling is not a limit, and accepting one would
 * store a value that every comparison downstream reads as nonsense. A
 * `maxStake` of `-1` would refuse every bet the player ever makes, which
 * looks identical to a self-exclusion and is not one.
 */
function validate(raw: unknown): { ok: true; limits: PlayerLimit[] } | { ok: false; error: Rejection } {
  if (!Array.isArray(raw)) return { ok: false, error: "invalid_limits" };

  const limits: PlayerLimit[] = [];
  const seen = new Set<LimitPeriod>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "invalid_limits" };
    const { period, maxStake, maxLoss } = entry as Record<string, unknown>;

    if (typeof period !== "string" || !(LIMIT_PERIODS as readonly string[]).includes(period)) {
      return { ok: false, error: "invalid_period" };
    }
    // Refused rather than merged or last-one-wins: two entries for the same
    // period is a caller mistake with no correct interpretation, and
    // silently keeping one of them would apply a limit they did not intend.
    if (seen.has(period as LimitPeriod)) return { ok: false, error: "duplicate_period" };
    seen.add(period as LimitPeriod);

    const limit: PlayerLimit = { period: period as LimitPeriod };

    for (const [key, value] of [
      ["maxStake", maxStake],
      ["maxLoss", maxLoss],
    ] as const) {
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return { ok: false, error: "invalid_amount" };
      }
      limit[key] = value;
    }

    // A period naming neither ceiling is almost certainly a caller who
    // misspelled a field name. Storing it would be storing nothing while
    // reporting success.
    if (limit.maxStake === undefined && limit.maxLoss === undefined) {
      return { ok: false, error: "empty_limit" };
    }

    limits.push(limit);
  }

  return { ok: true, limits };
}

export function registerLimitRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Replaces a player's limits wholesale.
   *
   * A PUT rather than a PATCH, and the whole array rather than one period,
   * because a partial update has no safe reading: an absent `daily` could
   * mean "leave it alone" or "remove it", and F25 is this repo's record of
   * what that ambiguity costs. Sending the full set makes removal
   * expressible — an empty array clears every limit — with no sentinel
   * value to agree on.
   */
  app.put<{ Body: LimitBody }>("/v1/players/limits", async (request, reply) => {
    const operatorId = request.operatorId!;
    const { playerId, limits: raw } = request.body ?? {};

    if (typeof playerId !== "string" || playerId.length === 0) {
      return reply.code(400).send({ error: "invalid_player_id" });
    }

    const validated = validate(raw);
    if (!validated.ok) return reply.code(400).send({ error: validated.error });

    const now = Date.now();
    const existing = await db
      .collection("playerLimits")
      .findOne<StoredLimits>({ operatorId, playerId }, { projection: { _id: 0, limits: 1, pending: 1 } });

    // What the player is actually held to right now — which is not the
    // stored set if an earlier loosening has since matured. Comparing
    // against the stored set instead would classify a raise they have
    // already waited out as a *second* raise, and start the clock again on
    // a limit that is already in force.
    const current = effectiveLimits(existing?.limits ?? [], existing?.pending, now);

    const changes = diffLimits(current, validated.limits);
    const loosenings = changes.filter((change) => change.kind === "loosening");

    // Tightenings apply at once, always. Delaying someone's decision to be
    // safer would be the control working against the person it protects —
    // and it is applied even when the same call also loosens something,
    // because refusing both would teach a player not to tighten.
    const immediate = applyTighteningsOnly(current, validated.limits);

    const document: StoredLimits & { operatorId: string; playerId: string } = {
      operatorId,
      playerId,
      limits: immediate,
    };

    if (loosenings.length > 0) {
      document.pending = {
        // The whole target set, not a delta: re-deriving a delta when it
        // matures would give a different answer if the player tightened
        // something in the meantime, which is exactly the sequence this
        // feature invites.
        limits: validated.limits,
        effectiveAt: now + LOOSENING_DELAY_MS,
        requestedAt: now,
      };
    }

    // `replaceOne`, not `$set`. `$set` leaves keys it was not given, so a
    // field dropped from the payload would survive on the stored document
    // indefinitely — F26 exactly, and on a document that decides whether
    // someone can bet. It also means a submission with no loosening clears
    // any pending one, which is the correct reading: the player has just
    // told us what they want, and it is not the raise they asked for
    // yesterday.
    await db.collection("playerLimits").replaceOne({ operatorId, playerId }, document, { upsert: true });

    // Recorded whatever the outcome, because "who changed this player's
    // protection, when, and in which direction" is the question a
    // regulator asks and the one nothing else in this system can answer.
    // Never allowed to fail the request: losing the record of a change is
    // bad, losing the change because we could not describe it is worse.
    await writeAuditLog(
      db,
      {
        actorUserId: `operator:${operatorId}`,
        action: loosenings.length > 0 ? "player.limits.loosen" : "player.limits.tighten",
        entityType: "player",
        entityId: playerId,
        diff: { changes, applied: immediate, ...(document.pending ? { pending: document.pending } : {}) },
      },
      (err) => request.log.error({ err }, "failed to audit a player limit change"),
    );

    return reply.send({
      playerId,
      limits: immediate,
      // Present only when something is waiting, so a client can loop on its
      // presence rather than comparing sets — and so an integrator who
      // ignores it is not silently told their raise took effect.
      ...(document.pending ? { pending: document.pending } : {}),
    });
  });

  /**
   * Reads a player's limits back.
   *
   * Answers `200` with an empty array for a player who has none, rather
   * than `404`. Two reasons: a player with no limits is a normal state, not
   * a missing resource; and a 404 here would confirm which player ids exist
   * to a caller enumerating them — the same disclosure rule the wallet
   * balance route follows.
   */
  app.get<{ Querystring: { playerId?: string } }>("/v1/players/limits", async (request, reply) => {
    const operatorId = request.operatorId!;
    const playerId = request.query?.playerId;

    if (typeof playerId !== "string" || playerId.length === 0) {
      return reply.code(400).send({ error: "invalid_player_id" });
    }

    const doc = await db
      .collection("playerLimits")
      .findOne<{ limits?: PlayerLimit[] }>({ operatorId, playerId }, { projection: { _id: 0, limits: 1 } });

    return reply.send({ playerId, limits: doc?.limits ?? [] });
  });
}
