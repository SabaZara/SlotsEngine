/**
 * The core "config over code" contract: a game's entire math lives in one
 * of these documents (the `games` collection), never in service code. One
 * generic evaluator plays any of them, so shipping a new game is publishing
 * a document — not deploying a service.
 */

import type { CurrencyCode } from "./money.js";

export type BonusModuleId = string;

export interface GridSize {
  reels: number;
  rows: number;
}

export interface ReelStrip {
  reelIndex: number;
  /** Ordered strip; the RNG picks a stop index and wraps at the end. */
  symbols: string[];
}

/**
 * One row index per reel, left to right — e.g. [0, 0, 0, 0, 0]. A reel's
 * entry may be `null`, meaning that reel isn't part of this line's pattern.
 * Evaluation already pays correctly on a shorter run (it stops at the first
 * mismatch and looks up the paytable by however many consecutive symbols
 * matched), so a trailing `null` is functionally inert — this just makes
 * "this reel doesn't matter for this line" an explicit designer choice.
 */
export type PaylinePath = (number | null)[];

export interface SymbolWeight {
  symbol: string;
  weight: number;
}

/** count-of-a-kind -> payout multiplier, e.g. { 3: 10, 4: 33, 5: 50 }. */
export type PaytableEntry = Record<number, number>;

export type SymbolRole = "regular" | "wild" | "scatter" | "bonusTrigger";

export interface SymbolRule {
  symbol: string;
  /** Which reels this symbol may land on. A coarse static fact, safe to
   * expose to the client (unlike reel strips / weights — see publicView). */
  allowedReels: number[];
  role: SymbolRole;
  paytable?: PaytableEntry;
  wildConfig?: {
    /** "all-regular" or an explicit symbol-id allowlist. Never substitutes
     * a scatter unless that scatter's id is explicitly listed here. */
    substitutesFor: "all-regular" | string[];
    expanding?: boolean;
    /** Multiplies any payline win this wild instance participates in.
     * Absent or `1` means no multiplier. */
    multiplier?: number;
  };
  scatterConfig?: {
    multiplierOf: "totalBet";
    payout?: PaytableEntry;
    /** When true, a wild that explicitly lists this scatter's id also counts
     * toward its appearance count. Off by default — most real games'
     * scatters are wild-immune. */
    wildCountsToward?: boolean;
  };
  bonusTriggerConfig?: {
    module: BonusModuleId;
    minCount: number;
    wildCountsToward?: boolean;
  };
}

export interface BonusModuleConfig {
  moduleId: BonusModuleId;
  /** Module-specific parameters, validated by the module itself, not here. */
  params: Record<string, unknown>;
  /**
   * An optional flat, symbol-independent trigger — an alternative to (never
   * combined with) a `SymbolRule.bonusTriggerConfig` pointing at this
   * moduleId. Only rolled if no symbol-based trigger already fired this
   * spin. Drawn from the SAME seeded RNG stream as the rest of the spin, so
   * it stays deterministic and replayable for audit rather than being a
   * second, unaudited randomness source.
   */
  probabilityTrigger?: { chancePerSpin: number };
}

export type ReelGenerationMode = "reel-strip" | "weighted-symbol";

export type GameStatus = "draft" | "published" | "archived";

/**
 * Sum-all-winning-lines is the default convention (each payline is
 * independently staked); highest-win-only is an explicit per-game opt-in,
 * never a silent platform-wide assumption.
 */
export type PaylineWinRule = "sum" | "highestOnly";
export const DEFAULT_PAYLINE_WIN_RULE: PaylineWinRule = "sum";

/**
 * Which registered evaluator plays this game's spins. The generic evaluator
 * is registered under this id as the reference implementation — this field
 * is what makes swapping the algorithm a real per-game config choice rather
 * than a theoretical one.
 */
export const DEFAULT_MATH_ENGINE_ID = "generic-v1";

/**
 * Artwork for a game, keyed by symbol id.
 *
 * **Presentation only, and the separation is load-bearing rather than
 * tidy.** Nothing here reaches the evaluator, the RTP simulation or the
 * publish gate: a game's mathematics is its reel strips, weights, paytable
 * and bonus params, and none of those can be changed by uploading a picture.
 * That is what makes artwork safe to edit on a published game without
 * re-running the gate, and it is why this is a separate field rather than
 * another property on `SymbolRule` — a symbol's *rule* is maths, and mixing
 * the two invites a change to one being reviewed as though it were the
 * other.
 *
 * Every field is optional and every consumer must fall back. A game with no
 * artwork renders derived placeholders and plays identically; a broken URL
 * renders the placeholder for that one symbol rather than blanking it. A
 * missing picture must never be able to hide a symbol a player is being paid
 * on.
 */
export interface GameAssets {
  /** Symbol id → image URL. A symbol absent from this map, or whose URL
   * fails to load, falls back to a generated placeholder. */
  symbolImageUrls?: Record<string, string>;
  /** Drawn behind the reels. Absent means the built-in gradient. */
  backgroundUrl?: string;
}

/**
 * The optional draft fields a save may *remove*, as opposed to leave alone.
 *
 * **Shared because the two ends must agree exactly, and nothing would fail
 * if they stopped.** Saving a draft is a patch — an absent key means "leave
 * unchanged" — but `undefined` does not survive `JSON.stringify`, so a
 * cleared field and an untouched one reach the server as the same bytes. The
 * client therefore converts a removal to an explicit `null`, and the server
 * turns that back into a `$unset`.
 *
 * A field the client can null but the server will not unset stores a literal
 * `null`; one the server will unset but the client never nulls simply cannot
 * be cleared, which is the bug this list was written for. Neither shows up
 * as an error, which is why this is one list rather than two.
 */
export const REMOVABLE_DRAFT_FIELDS = [
  "assets",
  "theme",
  "reelStrips",
  "symbolWeights",
  "currency",
  "mathEngineId",
  "paylineWinRule",
] as const;

/**
 * A game's colour identity.
 *
 * **Presentation only, exactly like `GameAssets`, and for the same
 * load-bearing reason**: nothing here reaches the evaluator, the RTP
 * simulation or the publish gate. A game's mathematics is its strips,
 * weights, paytable and bonus params, and none of those can be changed by
 * picking a colour — which is what makes a theme safe to edit on a
 * published game without re-running the gate.
 *
 * **Hex strings rather than the reference's numeric `0x4fd1ff`.** Theirs is
 * a Pixi scene where colours are numbers; this client is DOM, these values
 * become CSS custom properties, and `#4fd1ff` is what a designer types and
 * what every colour picker on earth emits. Storing numbers would mean
 * converting at both ends and inventing a format nobody else uses.
 *
 * **Deliberately far smaller than the reference's `VisualTheme`.** Theirs
 * carries radii, spacing scales, glow alphas, particle density and type
 * roles — a design system for a renderer that draws its own chrome. Ours
 * draws chrome with CSS, so radii and spacing already live in a stylesheet
 * where they belong, and duplicating them into game data would create two
 * sources for one fact. What genuinely varies per game is colour, so that
 * is what this holds. `winCelebration` thresholds are excluded on the same
 * grounds and a stronger one: they are already derived from the bet in
 * `winPresentation.ts`, and a per-game override there would change what
 * counts as a big win without touching the maths that pays it.
 *
 * Every field is optional and every consumer falls back to the built-in
 * palette. A game with no theme looks exactly as it does today.
 */
export interface GameTheme {
  /** Page background, behind everything. */
  background?: string;
  /** Panels and raised surfaces. */
  panel?: string;
  /** Hairlines and outlines. */
  border?: string;
  /** Body text. */
  text?: string;
  /** Secondary text — labels, status lines. */
  muted?: string;
  /** The interactive colour: spin button, focus rings, selected chips. */
  accent?: string;
  /** Reserved for winning outcomes, and never reused for anything else —
   * a player learns this colour means money. */
  win?: string;
}

/**
 * Whether a theme colour is one the client will actually apply.
 *
 * **Restricted to hex, and that is a security decision rather than a
 * stylistic one.** These values become CSS custom properties, so they are
 * interpolated into a stylesheet — and CSS accepts far more than colours.
 * `url(...)` fetches a resource; a value containing `;` or `}` escapes the
 * declaration it was meant to sit in and can rewrite rules further down. A
 * game definition is data a designer edits, so treating it as trusted CSS
 * would make the theme editor an injection point into every player's page.
 *
 * Named colours (`red`) and functional forms (`rgb(...)`, `color-mix(...)`)
 * are refused too. They are individually harmless, but allowing them means
 * the check has to reason about CSS syntax rather than match a shape — and
 * a designer loses nothing, because every colour picker emits hex.
 *
 * **Shared here for the reason F24 records.** The backoffice writes this
 * field and the client reads it; a second copy of the rule in either place
 * would drift, and nothing would fail when it did — the client silently
 * falls back, so a refused colour looks like a designer's choice not having
 * been saved.
 */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isValidThemeColour(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOUR.test(value.trim());
}

/** Every colour a theme may set. Exported so the editor renders exactly
 * these and cannot offer a field the client will ignore. */
export const THEME_COLOUR_KEYS = ["background", "panel", "border", "text", "muted", "accent", "win"] as const;

export type ThemeColourKey = (typeof THEME_COLOUR_KEYS)[number];

/**
 * The theme with every unusable value dropped.
 *
 * Returns `undefined` rather than an empty object when nothing survives,
 * matching `GameAssets`: absence is how every consumer decides "no theme",
 * and an empty object would claim a theme that styles nothing.
 *
 * Filtering rather than rejecting is deliberate. One malformed colour must
 * not cost a designer the other six — the client falls back per field, so a
 * partial theme is a working game with one wrong colour, not a broken page.
 */
export function sanitizeGameTheme(theme: unknown): GameTheme | undefined {
  if (typeof theme !== "object" || theme === null) return undefined;
  const source = theme as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const key of THEME_COLOUR_KEYS) {
    const value = source[key];
    if (isValidThemeColour(value)) clean[key] = value.trim();
  }
  return Object.keys(clean).length > 0 ? (clean as GameTheme) : undefined;
}

/**
 * Which URL schemes an asset may use.
 *
 * A game definition is **data a designer edits**, so its asset URLs are
 * attacker-adjacent in a way the rest of a game is not: the value reaches the
 * player client's loader directly. `javascript:` is the obvious one to
 * refuse; `data:` is refused as well, because an inline blob bypasses every
 * network control an operator has and no legitimate published game needs to
 * carry its art inline.
 *
 * Relative URLs are allowed — they resolve against the page's own origin,
 * which is where a self-hosted asset would live.
 */
const ALLOWED_ASSET_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Whether an asset URL is one the player client will actually load.
 *
 * **This lives here, in shared-types, for the reason F24 records rather than
 * for tidiness.** The player client refuses these URLs at load time and falls
 * back to a placeholder — so a backoffice that applied a *different* rule
 * would cheerfully store a URL that renders as nothing, and the designer
 * would see a saved field, a clean publish, and a blank symbol, with no
 * layer reporting a problem. A second copy of this rule would not stay equal
 * to this one, and nothing would fail when it stopped being.
 *
 * Refusing is always safe, because every consumer falls back to a
 * placeholder. So this errs toward refusal rather than trying to repair a
 * malformed value.
 */
export function isLoadableAssetUrl(url: unknown, pageOrigin = "http://localhost/"): url is string {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    // Parsed against a base so a relative path is resolved rather than
    // rejected. An absolute URL ignores the base.
    const parsed = new URL(url, pageOrigin);
    return ALLOWED_ASSET_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export interface GameDefinition {
  gameId: string;
  name: string;
  version: number;
  status: GameStatus;
  /** Presentation only — see `GameAssets`. Never reaches the evaluator or
   * the publish gate, so artwork can be changed without re-running either. */
  assets?: GameAssets;
  /** Colour identity — see `GameTheme`. Presentation only, on the same
   * terms as `assets`. */
  theme?: GameTheme;
  grid: GridSize;
  reelGenerationMode: ReelGenerationMode;
  /** Required when reelGenerationMode === "reel-strip". */
  reelStrips?: ReelStrip[];
  /** Per-reel weighted pools, required when mode === "weighted-symbol". */
  symbolWeights?: SymbolWeight[][];
  paylines: PaylinePath[];
  symbols: SymbolRule[];
  bonusModules: BonusModuleConfig[];
  /** Theoretical target, e.g. 0.96 — actual RTP is verified by simulation. */
  rtpTarget: number;
  /** Integer minor units of `currency` (e.g. `100` = $1.00) — never a
   * major-unit float. See money.ts. */
  betOptions: number[];
  /** ISO 4217 code the `betOptions` (and every amount a round against this
   * game produces) are denominated in. Optional — consumers fall back to
   * `DEFAULT_CURRENCY`. Display metadata only, not a wallet dimension. */
  currency?: CurrencyCode;
  /** Optional — consumers fall back to `DEFAULT_MATH_ENGINE_ID`. */
  mathEngineId?: string;
  /** Optional — consumers fall back to `DEFAULT_PAYLINE_WIN_RULE`. */
  paylineWinRule?: PaylineWinRule;
  publishedAt?: string;
  publishedByUserId?: string;
}
