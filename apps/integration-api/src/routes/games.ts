import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";

/**
 * The catalogue an operator's lobby reads to build its own game list,
 * instead of hardcoding gameIds and discovering at launch time which of
 * them work.
 *
 * The entitlement check is intentionally identical to the one
 * `/v1/launch` performs — enabled for this operator *and* currently
 * published — so that **a game listed here is always a game `/v1/launch`
 * would accept**. Two checks that are meant to agree but are written
 * differently will eventually disagree; keeping them the same query shape
 * is what makes that property hold rather than merely be intended.
 */
export function registerGamesRoute(app: FastifyInstance, db: Db): void {
  app.get("/v1/games", async (request, reply) => {
    const operatorId = request.operatorId!;

    const operator = await db
      .collection("operators")
      .findOne({ operatorId }, { projection: { enabledGameIds: 1 } });
    const enabledGameIds = (operator?.enabledGameIds as string[] | undefined) ?? [];

    // An empty entitlement list short-circuits. Not just an optimisation:
    // `$in: []` matches nothing, so this is the same answer, but it also
    // means a newly created operator with no games gets an empty list
    // rather than a query that reads as though it were asking for
    // everything.
    if (enabledGameIds.length === 0) {
      return reply.send({ games: [] });
    }

    const games = await db
      .collection("games")
      .find({ gameId: { $in: enabledGameIds }, status: "published" }, { projection: { _id: 0, gameId: 1, name: 1 } })
      .sort({ name: 1 })
      .toArray();

    return reply.send({ games });
  });
}
