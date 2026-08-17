import type { GameDefinition } from "@slots-engine/shared-types";

/**
 * The projection a browser is allowed to see.
 *
 * **An allowlist, never a blocklist.** Every field is named explicitly, so
 * adding a field to `GameDefinition` cannot silently publish it to players
 * — the failure mode of a blocklist is that new secrets leak by default,
 * and that failure is invisible until someone exploits it.
 *
 * Withheld: `reelStrips` and `symbolWeights` — the game's mathematical DNA.
 * They determine how *often* each symbol appears, so a player who could
 * read them could compute when a game is due to pay and size their bets
 * accordingly.
 *
 * Exposed: `allowedReels`, which says *where* a symbol may land. The
 * distinction is deliberate and worth stating precisely, because it looks
 * inconsistent at first glance. "Where" is a coarse static fact a player
 * infers within minutes of watching the reels anyway, and the client needs
 * it to avoid rendering symbols spinning past on reels they can never stop
 * on. "How often" is the actual edge, and it never leaves the server.
 */
export interface PublicGameView {
  gameId: string;
  name: string;
  version: number;
  grid: GameDefinition["grid"];
  paylines: GameDefinition["paylines"];
  symbols: Array<{
    symbol: string;
    role: string;
    allowedReels: number[];
    paytable?: Record<number, number>;
    wildConfig?: GameDefinition["symbols"][number]["wildConfig"];
    scatterConfig?: GameDefinition["symbols"][number]["scatterConfig"];
    bonusTriggerConfig?: GameDefinition["symbols"][number]["bonusTriggerConfig"];
  }>;
  bonusModules: Array<{ moduleId: string; params: Record<string, unknown> }>;
  betOptions: number[];
  currency?: string;
  paylineWinRule?: string;
  /**
   * Artwork. Public by nature — every player sees these images, so there is
   * nothing to withhold, and a URL a browser cannot fetch is useless anyway.
   *
   * Named explicitly here rather than spread from `gameDef.assets`, which is
   * the whole point of this file being an allowlist: a field added to
   * `GameAssets` later must be a decision someone makes here, not something
   * that publishes itself.
   */
  assets?: { symbolImageUrls?: Record<string, string>; backgroundUrl?: string };
}

export function toPublicView(gameDef: GameDefinition): PublicGameView {
  return {
    gameId: gameDef.gameId,
    name: gameDef.name,
    version: gameDef.version,
    grid: gameDef.grid,
    paylines: gameDef.paylines,
    symbols: gameDef.symbols.map((symbol) => ({
      symbol: symbol.symbol,
      role: symbol.role,
      allowedReels: symbol.allowedReels,
      ...(symbol.paytable !== undefined ? { paytable: symbol.paytable } : {}),
      ...(symbol.wildConfig !== undefined ? { wildConfig: symbol.wildConfig } : {}),
      ...(symbol.scatterConfig !== undefined ? { scatterConfig: symbol.scatterConfig } : {}),
      ...(symbol.bonusTriggerConfig !== undefined ? { bonusTriggerConfig: symbol.bonusTriggerConfig } : {}),
    })),
    // A module's params are the prize table a client must draw (wheel
    // segments, tile counts). They are not odds: which segment comes up is
    // decided server-side from a seed the client never sees.
    bonusModules: gameDef.bonusModules.map((m) => ({ moduleId: m.moduleId, params: m.params })),
    betOptions: gameDef.betOptions,
    ...(gameDef.currency !== undefined ? { currency: gameDef.currency } : {}),
    ...(gameDef.paylineWinRule !== undefined ? { paylineWinRule: gameDef.paylineWinRule } : {}),
    // Each key named rather than the object spread, so a field added to
    // `GameAssets` cannot reach a browser without someone editing this line.
    ...(gameDef.assets !== undefined
      ? {
          assets: {
            ...(gameDef.assets.symbolImageUrls !== undefined
              ? { symbolImageUrls: gameDef.assets.symbolImageUrls }
              : {}),
            ...(gameDef.assets.backgroundUrl !== undefined ? { backgroundUrl: gameDef.assets.backgroundUrl } : {}),
          },
        }
      : {}),
  };
}
