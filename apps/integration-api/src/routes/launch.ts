import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { signLaunchToken } from "@slots-engine/launch-token";

interface LaunchBody {
  playerId?: string;
  gameId?: string;
}

export interface LaunchRouteOptions {
  /** Where the player's browser is sent. Configurable because it differs
   * per environment, and a hardcoded value that merely *looks* configurable
   * is the exact shape of F27. */
  gameFrontendUrl: string;
}

/**
 * The handoff: an operator names a player and a game, and gets back a URL
 * to put their player in front of.
 *
 * **This route is the reason `signLaunchToken` exists.** Until it was
 * built, the whole token lifecycle — signing, single-use consumption, the
 * session token minted on JOIN — was reachable only from an end-to-end
 * script. The verifying half was complete and tested; nothing minted a
 * token in production.
 *
 * Entitlement is checked *here*, at issuance, rather than left for
 * game-socket or game-backend to re-derive at play time. One place to get
 * right, and it makes a stronger guarantee downstream: a token that exists
 * at all is one already known-valid for its operator/game pair.
 */
export function registerLaunchRoute(app: FastifyInstance, db: Db, options: LaunchRouteOptions): void {
  app.post<{ Body: LaunchBody }>("/v1/launch", async (request, reply) => {
    const { playerId, gameId } = request.body ?? {};
    if (typeof playerId !== "string" || !playerId || typeof gameId !== "string" || !gameId) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const operatorId = request.operatorId!;

    const operator = await db
      .collection("operators")
      .findOne({ operatorId }, { projection: { enabledGameIds: 1 } });

    // Checked before the game exists check, and the order is deliberate: a
    // 404 on a game this operator is not entitled to would confirm which
    // gameIds exist on the platform to anyone with any valid credential.
    // Answering "not enabled for you" first means an operator learns only
    // about their own catalogue.
    const enabledGameIds = (operator?.enabledGameIds as string[] | undefined) ?? [];
    if (!enabledGameIds.includes(gameId)) {
      return reply.code(403).send({ error: "game_not_enabled_for_operator" });
    }

    // `status: "published"` is part of the query rather than checked after,
    // so a draft or archived game cannot be launched even by an operator
    // entitled to it. A draft is explicitly not playable — publishing is
    // what makes it so — and this is the boundary where that is enforced
    // for a real player.
    const game = await db.collection("games").findOne({ gameId, status: "published" }, { projection: { _id: 1 } });
    if (!game) {
      return reply.code(404).send({ error: "game_not_found" });
    }

    const { token, expiresAt } = signLaunchToken({ operatorId, playerId, gameId });

    // `encodeURIComponent` even though the token is base64url (which has no
    // characters needing escaping): the encoding is a property of the token
    // format, and a format change that introduced a `+` or `/` would
    // otherwise silently corrupt every launch URL.
    const launchUrl = `${options.gameFrontendUrl}/?token=${encodeURIComponent(token)}`;

    // The token is returned alongside the URL so an operator embedding the
    // game in an iframe can build their own URL, and `expiresAt` so they
    // can tell a stale handoff from a rejected one. It is a 60-second,
    // single-use credential — see the launch-token package for why it is
    // this short given it travels in a query string.
    return reply.send({ token, expiresAt, launchUrl });
  });
}
