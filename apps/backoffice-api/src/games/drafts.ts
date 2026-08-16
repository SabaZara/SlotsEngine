import type { Db } from "mongodb";
import {
  DEFAULT_CURRENCY,
  DEFAULT_MATH_ENGINE_ID,
  DEFAULT_PAYLINE_WIN_RULE,
  type BonusModuleConfig,
  type GameDefinition,
  type GridSize,
  type PaylinePath,
  type PaylineWinRule,
  type ReelGenerationMode,
  type ReelStrip,
  type SymbolRule,
  type SymbolWeight,
} from "@slots-engine/shared-types";

/**
 * A draft is the editable state of a game. It is deliberately NOT a
 * `GameDefinition`: it has no `version` and no `status`, because those are
 * facts about a *publish*, not about an edit. Keeping them off the draft
 * makes it structurally impossible to edit a version number.
 *
 * **Editing a draft never changes what players see.** Publishing is the
 * only thing that does. That separation is what lets a designer leave a
 * half-finished game sitting for a week without anyone playing it.
 */
export interface GameDraft {
  gameId: string;
  name: string;
  grid: GridSize;
  reelGenerationMode: ReelGenerationMode;
  reelStrips?: ReelStrip[];
  symbolWeights?: SymbolWeight[][];
  paylines: PaylinePath[];
  symbols: SymbolRule[];
  bonusModules: BonusModuleConfig[];
  rtpTarget: number;
  betOptions: number[];
  currency?: string;
  mathEngineId?: string;
  paylineWinRule?: PaylineWinRule;
  updatedAt: string;
  updatedByUserId: string;
}

/** A new game starts from a small, *valid* skeleton rather than an empty
 * object — a designer's first action should be editing something that
 * already works, not discovering which twelve fields are mandatory. */
export function blankDraft(gameId: string, name: string, userId: string): GameDraft {
  return {
    gameId,
    name,
    grid: { reels: 5, rows: 3 },
    reelGenerationMode: "reel-strip",
    reelStrips: Array.from({ length: 5 }, (_, reelIndex) => ({
      reelIndex,
      symbols: ["ten", "jack", "queen", "king", "ace", "ten", "jack", "queen"],
    })),
    paylines: [
      [1, 1, 1, 1, 1],
      [0, 0, 0, 0, 0],
      [2, 2, 2, 2, 2],
    ],
    symbols: [
      { symbol: "ten", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 5, 4: 15, 5: 50 } },
      { symbol: "jack", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 6, 4: 18, 5: 60 } },
      { symbol: "queen", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 8, 4: 24, 5: 80 } },
      { symbol: "king", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 30, 5: 100 } },
      { symbol: "ace", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 12, 4: 40, 5: 140 } },
    ],
    bonusModules: [],
    rtpTarget: 0.95,
    // Integer minor units: 100 = 1.00.
    betOptions: [100, 200, 500, 1000],
    currency: DEFAULT_CURRENCY,
    mathEngineId: DEFAULT_MATH_ENGINE_ID,
    paylineWinRule: DEFAULT_PAYLINE_WIN_RULE,
    updatedAt: new Date().toISOString(),
    updatedByUserId: userId,
  };
}

export async function getDraft(db: Db, gameId: string): Promise<GameDraft | null> {
  const doc = await db.collection("gameDrafts").findOne({ gameId });
  if (!doc) return null;
  const { _id, ...draft } = doc;
  return draft as unknown as GameDraft;
}

export async function listDrafts(db: Db): Promise<Array<{ gameId: string; name: string; updatedAt: string }>> {
  const docs = await db
    .collection("gameDrafts")
    .find({}, { projection: { _id: 0, gameId: 1, name: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .toArray();
  return docs as unknown as Array<{ gameId: string; name: string; updatedAt: string }>;
}

export async function saveDraft(db: Db, draft: GameDraft): Promise<GameDraft> {
  const next = { ...draft, updatedAt: new Date().toISOString() };
  await db.collection("gameDrafts").updateOne({ gameId: draft.gameId }, { $set: next }, { upsert: true });
  return next;
}

/**
 * Seeds a draft from whatever is currently published.
 *
 * The natural way to edit a live game is to start from what is actually
 * live, not from a blank. Version and status are dropped deliberately —
 * see `GameDraft`'s doc comment.
 */
export function draftFromPublished(gameDef: GameDefinition, userId: string): GameDraft {
  return {
    gameId: gameDef.gameId,
    name: gameDef.name,
    grid: gameDef.grid,
    reelGenerationMode: gameDef.reelGenerationMode,
    ...(gameDef.reelStrips !== undefined ? { reelStrips: gameDef.reelStrips } : {}),
    ...(gameDef.symbolWeights !== undefined ? { symbolWeights: gameDef.symbolWeights } : {}),
    paylines: gameDef.paylines,
    symbols: gameDef.symbols,
    bonusModules: gameDef.bonusModules,
    rtpTarget: gameDef.rtpTarget,
    betOptions: gameDef.betOptions,
    ...(gameDef.currency !== undefined ? { currency: gameDef.currency } : {}),
    ...(gameDef.mathEngineId !== undefined ? { mathEngineId: gameDef.mathEngineId } : {}),
    ...(gameDef.paylineWinRule !== undefined ? { paylineWinRule: gameDef.paylineWinRule } : {}),
    updatedAt: new Date().toISOString(),
    updatedByUserId: userId,
  };
}
