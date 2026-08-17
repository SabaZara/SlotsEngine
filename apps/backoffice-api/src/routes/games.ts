import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { REMOVABLE_DRAFT_FIELDS, type GameDefinition } from "@slots-engine/shared-types";
import { listBonusModuleSchemas, listBonusModules } from "@slots-engine/math-engine";
import { requireRole } from "../auth/middleware.js";
import { blankDraft, draftFromPublished, getDraft, listDrafts, saveDraft, type GameDraft } from "../games/drafts.js";
import { DraftValidationError, validateDraft } from "../games/validateDraft.js";
import { PublishBlockedError, publishDraft } from "../games/publish.js";
import { requestSimulation } from "../games/simulateClient.js";
import { writeAuditLog } from "../audit/log.js";

/** Preview runs are smaller than the official pre-publish run — a designer
 * tuning a paytable wants an answer in a second, not a precise one. */
const PREVIEW_SIM_COUNT = 20_000;

export function registerGameRoutes(app: FastifyInstance, db: Db): void {
  const designer = { preHandler: [requireRole("game_designer")] };

  /**
   * Which bonus modules this build can actually play.
   *
   * Served from `listBonusModules()` — the engine registry itself — rather
   * than from a list maintained anywhere else. The backoffice used to
   * hardcode its own copy, and it drifted the moment a third module shipped:
   * `freeSpins` was registered in the engine and **could not be selected by a
   * designer at all**, because the editor's array still named two.
   *
   * The drift is silent in both directions, which is why it has to be
   * derived. A list that is short refuses a module that works; a list that is
   * long offers one that does not exist, which publishes cleanly (the API
   * cannot see the client's array) and then fails at spin time, in front of a
   * player, on the money path.
   */
  app.get("/v1/bonus-modules", async (_request, reply) => {
    // `schemas` carries the parameters each module reads. Served from the
    // same route as the id list, and from the same registry, because they
    // are the same fact at two levels of detail — a second endpoint could
    // answer them inconsistently, and this route exists precisely because a
    // second copy of this information drifted once already.
    //
    // `modules` is kept alongside it rather than derived by the client, so
    // an older backoffice build reading only that field keeps working.
    return reply.send({ modules: listBonusModules(), schemas: listBonusModuleSchemas() });
  });

  /** Every game, published or draft, with the live version alongside — the
   * one screen a designer opens first. */
  app.get("/v1/games", async (_request, reply) => {
    const [drafts, published] = await Promise.all([
      listDrafts(db),
      db
        .collection("games")
        .find({}, { projection: { _id: 0, gameId: 1, name: 1, version: 1, status: 1, rtpTarget: 1 } })
        .toArray(),
    ]);

    const publishedById = new Map(published.map((g) => [g.gameId as string, g]));
    const ids = new Set([...drafts.map((d) => d.gameId), ...publishedById.keys()]);

    return reply.send({
      games: [...ids].map((gameId) => {
        const draft = drafts.find((d) => d.gameId === gameId);
        const live = publishedById.get(gameId);
        return {
          gameId,
          name: (draft?.name ?? live?.name) as string,
          publishedVersion: (live?.version as number | undefined) ?? null,
          hasDraft: draft !== undefined,
          draftUpdatedAt: draft?.updatedAt ?? null,
        };
      }),
    });
  });

  app.post<{ Body: { gameId?: string; name?: string } }>("/v1/games", designer, async (request, reply) => {
    const { gameId, name } = request.body ?? {};
    if (!gameId?.trim() || !name?.trim()) {
      return reply.code(400).send({ error: "gameId and name are required" });
    }
    // A gameId is referenced by every round ever played under it, so it is
    // permanent. Rejecting a collision here is far cheaper than discovering
    // two games share an identity after rounds exist for both.
    if (await db.collection("gameDrafts").findOne({ gameId })) {
      return reply.code(409).send({ error: "game_already_exists" });
    }

    const draft = await saveDraft(db, blankDraft(gameId.trim(), name.trim(), request.user!.userId));
    await writeAuditLog(db, {
      actorUserId: request.user!.userId,
      action: "game.create",
      entityType: "game",
      entityId: draft.gameId,
    });
    return reply.code(201).send({ draft });
  });

  app.get<{ Params: { gameId: string } }>("/v1/games/:gameId", async (request, reply) => {
    const draft = await getDraft(db, request.params.gameId);
    const published = await db.collection("games").findOne({ gameId: request.params.gameId }, { projection: { _id: 0 } });
    if (!draft && !published) return reply.code(404).send({ error: "game_not_found" });
    return reply.send({ draft, published });
  });

  /**
   * Starts a draft from whatever is currently live — the normal way to edit
   * a published game. Refuses to clobber an existing draft, since that
   * draft may hold hours of unpublished work.
   */
  app.post<{ Params: { gameId: string } }>("/v1/games/:gameId/draft-from-published", designer, async (request, reply) => {
    if (await getDraft(db, request.params.gameId)) {
      return reply.code(409).send({ error: "draft_already_exists" });
    }
    const published = await db.collection("games").findOne({ gameId: request.params.gameId });
    if (!published) return reply.code(404).send({ error: "game_not_found" });

    const { _id, ...gameDef } = published;
    const draft = await saveDraft(db, draftFromPublished(gameDef as unknown as GameDefinition, request.user!.userId));
    return reply.send({ draft });
  });

  app.put<{ Params: { gameId: string }; Body: Partial<GameDraft> }>(
    "/v1/games/:gameId",
    designer,
    async (request, reply) => {
      const existing = await getDraft(db, request.params.gameId);
      if (!existing) return reply.code(404).send({ error: "draft_not_found" });

      // gameId comes from the URL, never the body: a body-supplied id could
      // rename a game into another game's identity.
      const next: GameDraft = {
        ...existing,
        ...request.body,
        gameId: existing.gameId,
        updatedAt: new Date().toISOString(),
        updatedByUserId: request.user!.userId,
      };

      /*
       * An explicit `null` removes an optional field. Found by running the
       * live stack, and not reachable from any test that used this route
       * the way the editor does.
       *
       * The merge above is a patch: an absent key means "leave unchanged",
       * which is what lets the editor save one field at a time. But
       * `undefined` does not survive `JSON.stringify` — `{assets:
       * undefined}` goes on the wire as `{}` — so "remove this field" and
       * "do not touch this field" arrive here **identical**, and `saveDraft`
       * uses `$set`, which never unsets. The result was that artwork could
       * be added through the API and then never cleared: the editor's own
       * clear-the-last-symbol path returns `undefined`, which the network
       * silently converted into a no-op. The screen showed the field
       * emptied, the next reload brought the artwork back.
       *
       * `null` is used rather than a separate endpoint or a `$unset` list
       * because it is the one value that both survives JSON and cannot be
       * confused with a legitimate one — no field here is meaningfully
       * null.
       */
      // Restricted to the known-removable fields rather than "any null in
      // the body", so a stray null cannot delete something required and
      // leave an unpublishable draft behind.
      const body = (request.body ?? {}) as Record<string, unknown>;
      for (const field of REMOVABLE_DRAFT_FIELDS) {
        if (body[field] === null) delete next[field];
      }

      // A draft is saved even when invalid — a designer must be able to
      // leave work half-finished. Validity is a publish-time gate, and the
      // errors are returned so the UI can show them live.
      const errors: string[] = [];
      try {
        validateDraft(next);
      } catch (err) {
        if (err instanceof DraftValidationError) errors.push(err.message);
        else throw err;
      }

      return reply.send({ draft: await saveDraft(db, next), valid: errors.length === 0, errors });
    },
  );

  /** A fast RTP estimate for the draft as it currently stands, without
   * publishing anything. The tuning loop this whole screen exists for. */
  app.post<{ Params: { gameId: string }; Body: { simCount?: number } }>(
    "/v1/games/:gameId/simulate",
    designer,
    async (request, reply) => {
      const draft = await getDraft(db, request.params.gameId);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });

      try {
        validateDraft(draft);
      } catch (err) {
        if (err instanceof DraftValidationError) {
          return reply.code(400).send({ error: "draft_invalid", message: err.message });
        }
        throw err;
      }

      const simCount = Math.min(Math.max(request.body?.simCount ?? PREVIEW_SIM_COUNT, 1000), 100_000);
      const gameDef = { ...draft, version: 0, status: "draft" } as unknown as GameDefinition;
      return reply.send({ simulation: await requestSimulation(gameDef, simCount, Math.min(...draft.betOptions)) });
    },
  );

  app.post<{ Params: { gameId: string }; Body: { force?: boolean } }>(
    "/v1/games/:gameId/publish",
    designer,
    async (request, reply) => {
      const draft = await getDraft(db, request.params.gameId);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });

      try {
        const result = await publishDraft(db, draft, request.user!.userId, { force: request.body?.force === true });
        return reply.send(result);
      } catch (err) {
        if (err instanceof DraftValidationError) {
          return reply.code(400).send({ error: "draft_invalid", message: err.message });
        }
        // 422, not 400: the request was well-formed and the draft is
        // structurally valid — it was refused on measured behaviour.
        if (err instanceof PublishBlockedError) {
          return reply.code(422).send({ error: "rtp_out_of_tolerance", message: err.message, simulation: err.report });
        }
        throw err;
      }
    },
  );

  /** Every published version, newest first. This is the audit trail for
   * "what maths was this round actually played under". */
  app.get<{ Params: { gameId: string } }>("/v1/games/:gameId/versions", async (request, reply) => {
    const versions = await db
      .collection("gameVersions")
      .find({ gameId: request.params.gameId }, { projection: { _id: 0 } })
      .sort({ version: -1 })
      .toArray();
    return reply.send({ versions });
  });
}
