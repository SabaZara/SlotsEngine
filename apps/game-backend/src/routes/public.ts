import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { isStorageConfigured, isStorageKey, signAssetUrl } from "@slots-engine/asset-storage";
import { GameNotFoundError, loadGameDefinition } from "../rounds/games.js";
import { toPublicView, type PublicGameView } from "../rounds/publicView.js";

/**
 * Turns stored asset **keys** into short-lived signed URLs a browser can
 * actually fetch.
 *
 * **Without this the artwork is unreachable.** Assets are stored as keys
 * (`games/x/symbol-ten/….svg`) and the bucket is private, so a key handed
 * to a browser is not a URL — it is a relative path that resolves against
 * the game frontend and 404s. The backoffice signs on read for exactly this
 * reason; this route did not, so every image a designer uploaded failed to
 * load for players. It failed *quietly*, too: the client falls back to its
 * generated glyphs and logs a warning, so the game looked fine and the
 * artwork simply never appeared.
 *
 * Signed here rather than inside `toPublicView` deliberately. That function
 * is the disclosure allowlist and is deliberately synchronous and pure —
 * making it async to await a signature would put an I/O call inside the one
 * place whose job is deciding what a browser may see.
 *
 * A value that is not a storage key is passed through untouched: `assets`
 * also accepts plain external URLs, and signing one would corrupt it.
 */
async function withSignedAssets(view: PublicGameView): Promise<PublicGameView> {
  // Nothing to sign against, so hand back what is there rather than
  // failing the whole game load over presentation.
  if (!view.assets || !isStorageConfigured()) return view;

  const sign = async (value: string | undefined): Promise<string | undefined> =>
    value !== undefined && isStorageKey(value) ? await signAssetUrl(value) : value;

  const { symbolImageUrls, backgroundUrl, musicUrl, spinSoundUrl } = view.assets;

  const signedSymbols = symbolImageUrls
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(symbolImageUrls).map(async ([symbol, value]) => [symbol, await sign(value)] as const),
        ),
      )
    : undefined;

  // Signed once each and held, rather than re-signed inside the spread. A
  // second call would mint a second signature for the same object — wasted
  // work, and two URLs for one asset that expire at different moments.
  const [signedBackground, signedMusic, signedSpin] = await Promise.all([
    sign(backgroundUrl),
    sign(musicUrl),
    sign(spinSoundUrl),
  ]);

  return {
    ...view,
    assets: {
      ...(signedSymbols !== undefined ? { symbolImageUrls: signedSymbols as Record<string, string> } : {}),
      ...(signedBackground !== undefined ? { backgroundUrl: signedBackground } : {}),
      ...(signedMusic !== undefined ? { musicUrl: signedMusic } : {}),
      ...(signedSpin !== undefined ? { spinSoundUrl: signedSpin } : {}),
    },
  };
}

/**
 * The only route a browser hits directly, and therefore the only place an
 * information-disclosure mistake reaches a player. Everything it returns
 * goes through `toPublicView`'s explicit allowlist — see that file for what
 * is withheld and why.
 */
export function registerPublicRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { gameId: string } }>("/public/games/:gameId", async (request, reply) => {
    try {
      const gameDef = await loadGameDefinition(db, request.params.gameId);
      return reply.send(await withSignedAssets(toPublicView(gameDef)));
    } catch (err) {
      if (err instanceof GameNotFoundError) return reply.code(404).send({ error: "game_not_found" });
      throw err;
    }
  });
}
