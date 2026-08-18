import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { requireRole } from "../auth/middleware.js";
import { effectiveLimits, type PendingLimitChange, type PlayerLimit } from "@slots-engine/player-limits";

/**
 * The one question support actually gets asked: *what happened to this
 * player?*
 *
 * Answering it today means three separate queries against three
 * collections, which is why it exists as one route rather than as advice to
 * combine `/v1/reports/transactions` with something else. Support work
 * happens while someone is waiting, and a lookup that takes three steps is
 * a lookup that gets done wrong under pressure.
 *
 * **Read-only, and deliberately so.** There is no adjustment endpoint here
 * and there should not be one: correcting a player's balance is a ledger
 * movement, and a ledger movement belongs on the money path with an
 * idempotency key and an audit trail, not on a support screen. This route
 * answers questions; it settles nothing.
 */
const CAN_LOOK_UP_PLAYERS = requireRole("operations", "viewer");

/** The stored shape: what is in force, plus any loosening still waiting. */
interface StoredLimits {
  limits?: PlayerLimit[];
  pending?: PendingLimitChange;
}

/**
 * How much recent history to return.
 *
 * Fixed rather than paged, because this is a "what just happened" view and
 * not a statement — a support agent scrolling past fifty rounds has a
 * different question, and `/v1/reports/transactions` is where that one is
 * answered. Keeping it unpaged also keeps the response one round trip.
 */
const RECENT_LIMIT = 50;

export function registerSupportRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { operatorId: string; playerId: string } }>(
    "/v1/support/players/:operatorId/:playerId",
    { preHandler: [CAN_LOOK_UP_PLAYERS] },
    async (request, reply) => {
      const { operatorId, playerId } = request.params;

      const player = await db.collection("players").findOne({ operatorId, playerId }, { projection: { _id: 0 } });

      // A 404 here is safe in a way it would not be on the operator-facing
      // API: this route is behind an authenticated backoffice session, so
      // "no such player" is information the caller is entitled to. The
      // integration API deliberately answers 0 instead, because there it
      // would confirm which of an operator's player ids exist.
      if (!player) {
        return reply.code(404).send({ error: "player_not_found" });
      }

      // Issued together rather than sequentially. Round trips in series is
      // multiplied latency for data that has no ordering dependency, and
      // this is a route someone runs while a customer is on the phone.
      // One reading for the whole response. Two `Date.now()` calls could
      // straddle the instant a change matures and report it as both in
      // force and still waiting — a millisecond-wide window, which is
      // exactly the kind that shows up once and is never reproducible.
      const now = Date.now();

      const [recentTransactions, recentRounds, storedLimits, limitUsage] = await Promise.all([
        db
          .collection("transactions")
          .find({ operatorId, playerId }, { projection: { _id: 0 } })
          .sort({ createdAt: -1 })
          .limit(RECENT_LIMIT)
          .toArray(),
        db
          .collection("rounds")
          .find({ operatorId, playerId }, { projection: { _id: 0 } })
          // `seed` and `rngAlgorithm` come back deliberately: "was this
          // spin fair" is the second question support gets, and the round
          // is replayable from exactly those two fields. Withholding them
          // would mean the answer requires a developer.
          .sort({ createdAt: -1 })
          .limit(RECENT_LIMIT)
          .toArray(),
        // "Why was I refused?" is the third question support gets, and
        // without these two it cannot be answered from this screen at all
        // — the agent would see a healthy balance and no reason for a
        // refusal, which is precisely the case that becomes a complaint.
        db
          .collection("playerLimits")
          .findOne<StoredLimits>({ operatorId, playerId }, { projection: { _id: 0, limits: 1, pending: 1 } }),
        db
          .collection("playerLimitUsage")
          .find({ operatorId, playerId }, { projection: { _id: 0, period: 1, periodKey: 1, staked: 1, won: 1 } })
          // Newest period first per kind. Keyed strings sort
          // chronologically because they are zero-padded, which is what
          // that padding is for.
          .sort({ periodKey: -1 })
          .limit(RECENT_LIMIT)
          .toArray(),
      ]);

      return reply.send({
        player,
        recentTransactions,
        recentRounds,
        // Read through `effectiveLimits`, the same function the money path
        // uses, rather than off the stored field. A raise matures with
        // nothing running, so the stored set can lag what is actually
        // enforced — and an agent quoting a ceiling the engine no longer
        // applies is telling a customer something untrue while every
        // screen looks correct.
        limits: effectiveLimits(storedLimits?.limits ?? [], storedLimits?.pending, now),
        // Only when it is still waiting, so an agent can say "their new
        // limit starts tomorrow" instead of being surprised by a change
        // they cannot see coming.
        ...(storedLimits?.pending && storedLimits.pending.effectiveAt > now
          ? { pendingLimitChange: storedLimits.pending }
          : {}),
        limitUsage,
        // Stated rather than left for the caller to infer from the array
        // length: a list of exactly 50 is ambiguous between "that is all of
        // them" and "there are more", and a support agent reading the
        // second as the first would tell a customer something untrue.
        truncated: {
          transactions: recentTransactions.length === RECENT_LIMIT,
          rounds: recentRounds.length === RECENT_LIMIT,
        },
        limit: RECENT_LIMIT,
      });
    },
  );
}
