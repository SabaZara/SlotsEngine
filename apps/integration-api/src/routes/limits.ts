import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { LIMIT_PERIODS, type LimitPeriod, type PlayerLimit } from "@slots-engine/player-limits";

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

    // `replaceOne`, not `$set`. `$set` leaves keys it was not given, so a
    // field dropped from the payload would survive on the stored document
    // indefinitely — F26 exactly, and on a document that decides whether
    // someone can bet.
    await db
      .collection("playerLimits")
      .replaceOne({ operatorId, playerId }, { operatorId, playerId, limits: validated.limits }, { upsert: true });

    return reply.send({ playerId, limits: validated.limits });
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
