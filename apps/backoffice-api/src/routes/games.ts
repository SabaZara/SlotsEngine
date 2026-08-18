import { randomUUID } from "node:crypto";
import {
  EXTENSION_FOR_TYPE,
  buildAssetKey,
  isAllowedForSlot,
  isStorageConfigured,
  isStorageKey,
  isUploadSlot,
  signAssetUrl,
  uploadAsset,
  type UploadSlot,
} from "@slots-engine/asset-storage";
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

/**
 * The largest asset accepted, in bytes.
 *
 * A ceiling rather than a considered limit: a slot machine symbol is a few
 * kilobytes and a music loop a few megabytes, so 8MB is generous for
 * everything legitimate while stopping a single request from buffering an
 * arbitrary amount into memory. Base64 inflates the wire size by about a
 * third, so the request body may reach ~11MB.
 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Puts a storage key into the right field of `assets`, or removes it.
 *
 * `null` clears. Kept as one function so the upload and clear routes cannot
 * disagree about where a slot lives — two mappings would be the F24 shape
 * again, and the symptom would be an upload that appears to work and a
 * clear that misses.
 *
 * Returns `undefined` when nothing is left, matching every other consumer:
 * absence is how "no artwork" is expressed, and an empty object claims
 * artwork that resolves to nothing.
 */
function withUploadedAsset(
  assets: GameDraft["assets"],
  slot: UploadSlot,
  symbol: string | undefined,
  key: string | null,
): GameDraft["assets"] {
  const next = {
    ...(assets?.symbolImageUrls !== undefined ? { symbolImageUrls: { ...assets.symbolImageUrls } } : {}),
    ...(assets?.backgroundUrl !== undefined ? { backgroundUrl: assets.backgroundUrl } : {}),
    ...(assets?.musicUrl !== undefined ? { musicUrl: assets.musicUrl } : {}),
    ...(assets?.spinSoundUrl !== undefined ? { spinSoundUrl: assets.spinSoundUrl } : {}),
  };

  const field = { background: "backgroundUrl", music: "musicUrl", spinSound: "spinSoundUrl" } as const;

  if (slot === "symbol") {
    const symbols = { ...next.symbolImageUrls };
    if (key === null) delete symbols[symbol ?? ""];
    else symbols[symbol ?? ""] = key;
    if (Object.keys(symbols).length === 0) delete next.symbolImageUrls;
    else next.symbolImageUrls = symbols;
  } else if (key === null) {
    delete next[field[slot]];
  } else {
    next[field[slot]] = key;
  }

  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Swaps stored keys for freshly signed URLs, for display only.
 *
 * **Never persisted, and that is the whole discipline.** The result of this
 * function must not travel back into a write — the draft PUT strips
 * `assets` precisely so it cannot. A value that is already a URL rather
 * than a key is left alone and flagged by `isStorageKey`, so a legacy
 * hand-entered URL keeps working while an accidentally-stored signed URL
 * is visible as such rather than being re-signed.
 */
async function withSignedAssets(draft: GameDraft): Promise<GameDraft> {
  const assets = draft.assets;
  if (!assets) return draft;

  const sign = async (value: string | undefined): Promise<string | undefined> =>
    value !== undefined && isStorageKey(value) ? signAssetUrl(value) : value;

  const symbolEntries = await Promise.all(
    Object.entries(assets.symbolImageUrls ?? {}).map(async ([symbol, value]) => [symbol, await sign(value)] as const),
  );

  return {
    ...draft,
    assets: {
      ...(symbolEntries.length > 0
        ? { symbolImageUrls: Object.fromEntries(symbolEntries.filter(([, v]) => v !== undefined) as [string, string][]) }
        : {}),
      ...((await sign(assets.backgroundUrl)) !== undefined ? { backgroundUrl: await sign(assets.backgroundUrl) } : {}),
      ...((await sign(assets.musicUrl)) !== undefined ? { musicUrl: await sign(assets.musicUrl) } : {}),
      ...((await sign(assets.spinSoundUrl)) !== undefined ? { spinSoundUrl: await sign(assets.spinSoundUrl) } : {}),
    },
  };
}

/**
 * `publishRunSeed` pins the simulation seed, and exists for tests only.
 *
 * It is a parameter rather than a request field on purpose. A seed a client
 * could send is a seed a designer could shop for — re-rolling until a
 * paytable draws a flattering 100k spins is precisely the gate this route
 * exists to close. Production never passes it, so `publishDraft` generates a
 * fresh one per publish and records it on the report.
 */
export function registerGameRoutes(app: FastifyInstance, db: Db, publishRunSeed?: string): void {
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
    // Signed for display on the way out. The editor never sends these back
    // — the PUT strips `assets` — so the read shape differing from the
    // stored shape is safe here in a way it was not for the reference.
    return reply.send({ draft: draft ? await withSignedAssets(draft) : draft, published });
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

      /*
       * `assets` is stripped from the generic patch, and this is the single
       * most important line in this file once object storage exists.
       *
       * Uploaded assets are stored as **keys** and served as short-lived
       * **signed URLs**, so what a client reads is not what the server
       * stores. The reference repo had exactly this design and merged the
       * client's `assets` object straight in — so every "Save draft" wrote
       * the signed URL the editor had been shown back over the raw key, and
       * the next read signed the already-corrupted value. It compounded one
       * nesting level per save and needed a repair script with a recursive
       * unwinder to undo.
       *
       * So the draft PUT does not accept `assets` at all. The dedicated
       * upload and clear routes below are the only writers, and they write
       * keys they generated themselves. `isStorageKey` is the second line
       * of defence if this one is ever undone.
       */
      const { assets: _rejected, ...patch } = request.body ?? {};

      // gameId comes from the URL, never the body: a body-supplied id could
      // rename a game into another game's identity.
      const next: GameDraft = {
        ...existing,
        ...patch,
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

  /**
   * Uploads one asset and records its **key** on the draft.
   *
   * The only writer of `assets` besides the clear route below — see the
   * PUT above for why that matters. The body carries base64 rather than
   * `multipart/form-data` deliberately: multipart needs a Fastify plugin
   * and a second parser, and the whole benefit would be avoiding a ~33%
   * encoding overhead on files a designer uploads a handful of times.
   * Base64 keeps the route testable with `inject` and adds no dependency.
   *
   * The key is generated here, never accepted from the client. A caller
   * who could name their own key could write to another game's prefix.
   */
  app.post<{
    Params: { gameId: string };
    Body: { slot?: string; symbol?: string; contentType?: string; data?: string };
  }>("/v1/games/:gameId/assets", designer, async (request, reply) => {
    const draft = await getDraft(db, request.params.gameId);
    if (!draft) return reply.code(404).send({ error: "draft_not_found" });

    /*
     * The request is validated BEFORE storage is consulted, deliberately.
     * A malformed upload is malformed whether or not a bucket exists, and
     * answering 503 to a request that names an unknown slot tells the
     * caller to go and fix their infrastructure over a typo in their own
     * payload.
     */
    const { slot, symbol, contentType, data } = request.body ?? {};
    if (!isUploadSlot(slot)) return reply.code(400).send({ error: "unknown_slot" });
    if (slot === "symbol" && !symbol?.trim()) return reply.code(400).send({ error: "symbol_required" });
    if (typeof contentType !== "string" || !isAllowedForSlot(slot, contentType)) {
      return reply.code(415).send({ error: "unsupported_content_type" });
    }
    if (typeof data !== "string" || data === "") return reply.code(400).send({ error: "no_data" });

    const body = Buffer.from(data, "base64");
    if (body.length === 0) return reply.code(400).send({ error: "no_data" });
    if (body.length > MAX_ASSET_BYTES) return reply.code(413).send({ error: "asset_too_large" });

    if (!isStorageConfigured()) {
      // Said plainly rather than failing at the SDK, which would surface as
      // a 500 and read as a bug rather than as configuration.
      return reply.code(503).send({ error: "storage_not_configured" });
    }

    const normalisedType = contentType.split(";")[0].trim().toLowerCase();
    const key = buildAssetKey(
      draft.gameId,
      slot === "symbol" ? `symbol-${symbol!.trim()}` : slot,
      EXTENSION_FOR_TYPE[normalisedType] ?? "",
      randomUUID(),
    );
    await uploadAsset(key, body, normalisedType);

    const assets = withUploadedAsset(draft.assets, slot, symbol?.trim(), key);
    const saved = await saveDraft(db, { ...draft, assets, updatedByUserId: request.user!.userId });

    await writeAuditLog(db, {
      actorUserId: request.user!.userId,
      action: "game.asset.upload",
      entityType: "game",
      entityId: draft.gameId,
      diff: { slot, ...(symbol ? { symbol: symbol.trim() } : {}), key, bytes: body.length },
    });

    // The signed URL is returned for display and deliberately NOT stored.
    return reply.send({ key, url: await signAssetUrl(key), draft: await withSignedAssets(saved) });
  });

  /**
   * Clears one asset slot.
   *
   * The object itself is left in storage. A published game may still
   * reference the key, and a draft edit must never break a live game —
   * the document is what says whether an asset is in use, and this route
   * cannot know. Orphans are a storage-cost problem for a later sweep,
   * not a correctness one.
   */
  app.delete<{ Params: { gameId: string }; Querystring: { slot?: string; symbol?: string } }>(
    "/v1/games/:gameId/assets",
    designer,
    async (request, reply) => {
      const draft = await getDraft(db, request.params.gameId);
      if (!draft) return reply.code(404).send({ error: "draft_not_found" });

      const { slot, symbol } = request.query ?? {};
      if (!isUploadSlot(slot)) return reply.code(400).send({ error: "unknown_slot" });

      const assets = withUploadedAsset(draft.assets, slot, symbol?.trim(), null);
      const saved = await saveDraft(db, { ...draft, assets, updatedByUserId: request.user!.userId });
      return reply.send({ draft: await withSignedAssets(saved) });
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
        const result = await publishDraft(db, draft, request.user!.userId, { force: request.body?.force === true, runSeed: publishRunSeed });
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
