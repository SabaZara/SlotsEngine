import type { GameDraft } from "./drafts.js";

export class DraftValidationError extends Error {}

const VALID_PAYLINE_WIN_RULES = new Set(["sum", "highestOnly"]);
const VALID_SYMBOL_ROLES = new Set(["regular", "wild", "scatter", "bonusTrigger"]);
const VALID_REEL_MODES = new Set(["reel-strip", "weighted-symbol"]);

/**
 * Publish-time correctness gate.
 *
 * The posture throughout is **cheap, high-value guards** — presence, shape,
 * enum membership, and cross-reference consistency. It deliberately does
 * NOT judge whether the maths is *good*: whether weights actually hit
 * `rtpTarget` is a tuning question answered by simulation, not a
 * correctness question answerable by inspection.
 *
 * What it does catch is the class of error that would otherwise surface at
 * *spin time*, as an opaque failure in front of a real player — a payline
 * pointing at a row that no longer exists after a grid resize, a reel strip
 * naming a symbol somebody deleted, a bonus trigger referencing a module
 * that was never configured. Each of those is silent until it isn't.
 *
 * Synchronous and database-free by design. Anything needing a lookup (does
 * this referenced thing exist?) belongs in `publishDraft`, so this stays
 * trivially testable.
 */
export function validateDraft(draft: GameDraft): void {
  // --- presence -----------------------------------------------------------
  if (!draft.name?.trim()) throw new DraftValidationError("name is required");
  if (!draft.grid?.reels || !draft.grid?.rows) {
    throw new DraftValidationError("grid.reels and grid.rows are required");
  }
  if (!Number.isInteger(draft.grid.reels) || draft.grid.reels < 1) {
    throw new DraftValidationError("grid.reels must be a positive integer");
  }
  if (!Number.isInteger(draft.grid.rows) || draft.grid.rows < 1) {
    throw new DraftValidationError("grid.rows must be a positive integer");
  }
  if (!draft.paylines?.length) throw new DraftValidationError("at least one payline is required");
  if (!draft.symbols?.length) throw new DraftValidationError("at least one symbol is required");
  if (!draft.betOptions?.length) throw new DraftValidationError("at least one bet option is required");

  if (!VALID_REEL_MODES.has(draft.reelGenerationMode)) {
    throw new DraftValidationError(`reelGenerationMode '${draft.reelGenerationMode}' is not valid`);
  }
  if (draft.reelGenerationMode === "reel-strip" && !draft.reelStrips?.length) {
    throw new DraftValidationError("reelGenerationMode is 'reel-strip' but reelStrips is empty");
  }
  if (draft.reelGenerationMode === "weighted-symbol" && !draft.symbolWeights?.length) {
    throw new DraftValidationError("reelGenerationMode is 'weighted-symbol' but symbolWeights is empty");
  }

  // --- money --------------------------------------------------------------
  // betOptions are integer minor units. A float here would not merely look
  // wrong — it would flow into the ledger's `$inc` and corrupt a balance
  // with no error raised anywhere downstream.
  for (const bet of draft.betOptions) {
    if (!Number.isInteger(bet) || bet <= 0) {
      throw new DraftValidationError(`betOptions entry ${bet} must be a positive integer (minor units)`);
    }
  }

  if (!(draft.rtpTarget > 0 && draft.rtpTarget < 1.5)) {
    throw new DraftValidationError("rtpTarget should be a fraction like 0.95, not a percentage");
  }

  // An absent `currency` is fine — consumers fall back to the platform
  // default. A field that is *present but empty or null* is not: it means a
  // client tried to set something and produced nothing, and silently
  // defaulting it would hide a real client bug. The `in` check
  // distinguishes "never provided" from "provided as null", which `!= null`
  // alone cannot, and reaching `.trim()` on a null would surface as an
  // unhandled 500 rather than a clean validation error.
  if ("currency" in draft && (draft.currency === null || !draft.currency?.trim())) {
    throw new DraftValidationError("currency, if provided, must be a non-empty ISO 4217 code");
  }
  if (draft.paylineWinRule !== undefined && !VALID_PAYLINE_WIN_RULES.has(draft.paylineWinRule)) {
    throw new DraftValidationError(`paylineWinRule '${draft.paylineWinRule}' must be 'sum' or 'highestOnly'`);
  }

  // --- shape consistency --------------------------------------------------
  // Closes the "stale-shape draft publishes fine" gap: a grid resize that
  // left paylines or strips at the old dimensions passes every individual
  // presence check above, then fails at spin time with an opaque error.
  for (const [i, path] of draft.paylines.entries()) {
    if (path.length !== draft.grid.reels) {
      throw new DraftValidationError(`payline ${i} has ${path.length} entries, but grid.reels is ${draft.grid.reels}`);
    }
    // `null` means "this reel isn't part of this line" and is a real,
    // intentional entry — checked explicitly rather than relying on JS
    // coercing `null < 0` and `null >= rows` both to false, which lets
    // nulls through by accident rather than by decision.
    if (path.some((row) => row !== null && (!Number.isInteger(row) || row < 0 || row >= draft.grid.rows))) {
      throw new DraftValidationError(`payline ${i} references a row outside 0-${draft.grid.rows - 1}`);
    }
  }

  const symbolIds = new Set(draft.symbols.map((s) => s.symbol));
  const bonusModuleIds = new Set((draft.bonusModules ?? []).map((m) => m.moduleId));

  if (symbolIds.size !== draft.symbols.length) {
    throw new DraftValidationError("two symbols share the same id — symbol ids must be unique");
  }

  if (draft.reelGenerationMode === "reel-strip") {
    const seenReels = new Set<number>();
    for (const strip of draft.reelStrips ?? []) {
      if (!Number.isInteger(strip.reelIndex) || strip.reelIndex < 0 || strip.reelIndex >= draft.grid.reels) {
        throw new DraftValidationError(
          `reelStrips has an entry for reel ${strip.reelIndex}, but grid.reels is ${draft.grid.reels}`,
        );
      }
      if (seenReels.has(strip.reelIndex)) {
        throw new DraftValidationError(`reelStrips has two entries for reel ${strip.reelIndex}`);
      }
      seenReels.add(strip.reelIndex);

      if (!strip.symbols?.length) {
        throw new DraftValidationError(`reel ${strip.reelIndex} has an empty strip`);
      }
      // A strip shorter than the visible grid would wrap within a single
      // spin, showing the same symbol more than once in one column.
      if (strip.symbols.length < draft.grid.rows) {
        throw new DraftValidationError(
          `reel ${strip.reelIndex} has ${strip.symbols.length} symbols, fewer than the ${draft.grid.rows} visible rows`,
        );
      }
      for (const symbol of strip.symbols) {
        if (!symbolIds.has(symbol)) {
          throw new DraftValidationError(`reel ${strip.reelIndex} references undefined symbol '${symbol}'`);
        }
      }
    }
    // Every reel needs a strip. Without this, a game publishes fine and
    // then throws on the first spin that reaches the missing reel.
    for (let reel = 0; reel < draft.grid.reels; reel++) {
      if (!seenReels.has(reel)) throw new DraftValidationError(`no reel strip defined for reel ${reel}`);
    }
  } else {
    const pools = draft.symbolWeights ?? [];
    if (pools.length !== draft.grid.reels) {
      throw new DraftValidationError(`symbolWeights has ${pools.length} pools, but grid.reels is ${draft.grid.reels}`);
    }
    for (const [reelIndex, pool] of pools.entries()) {
      if (!pool?.length) throw new DraftValidationError(`reel ${reelIndex} has an empty weighted pool`);
      let total = 0;
      for (const entry of pool) {
        if (!symbolIds.has(entry.symbol)) {
          throw new DraftValidationError(`reel ${reelIndex}'s weighted pool references undefined symbol '${entry.symbol}'`);
        }
        if (!(entry.weight >= 0)) {
          throw new DraftValidationError(`reel ${reelIndex}: symbol '${entry.symbol}' has a negative weight`);
        }
        total += entry.weight;
      }
      // A pool summing to zero makes every draw fall through to the last
      // entry — a silently rigged reel, not an error anywhere downstream.
      if (total <= 0) {
        throw new DraftValidationError(`reel ${reelIndex}'s weights total ${total} — at least one symbol must have weight`);
      }
    }
  }

  // --- per-symbol consistency --------------------------------------------
  for (const symbol of draft.symbols) {
    if (!VALID_SYMBOL_ROLES.has(symbol.role)) {
      throw new DraftValidationError(`symbol '${symbol.symbol}': role '${symbol.role}' is not valid`);
    }
    if (symbol.allowedReels?.some((r) => !Number.isInteger(r) || r < 0 || r >= draft.grid.reels)) {
      throw new DraftValidationError(
        `symbol '${symbol.symbol}': allowedReels references a reel outside 0-${draft.grid.reels - 1}`,
      );
    }

    if (symbol.role === "regular") {
      if (!symbol.paytable || Object.keys(symbol.paytable).length === 0) {
        throw new DraftValidationError(`symbol '${symbol.symbol}' is 'regular' but has no paytable`);
      }
      for (const [countKey, multiplier] of Object.entries(symbol.paytable)) {
        const count = Number(countKey);
        if (!Number.isInteger(count) || count < 1 || count > draft.grid.reels) {
          throw new DraftValidationError(
            `symbol '${symbol.symbol}': paytable count ${countKey} must be between 1 and grid.reels (${draft.grid.reels})`,
          );
        }
        if (!(multiplier > 0)) {
          throw new DraftValidationError(`symbol '${symbol.symbol}': paytable[${countKey}] must be a positive multiplier`);
        }
      }
    }

    if (symbol.role === "wild") {
      if (!symbol.wildConfig) {
        throw new DraftValidationError(`symbol '${symbol.symbol}' is 'wild' but has no wildConfig`);
      }
      if (Array.isArray(symbol.wildConfig.substitutesFor)) {
        for (const target of symbol.wildConfig.substitutesFor) {
          if (!symbolIds.has(target)) {
            throw new DraftValidationError(
              `symbol '${symbol.symbol}': wildConfig.substitutesFor references undefined symbol '${target}'`,
            );
          }
        }
      } else if (symbol.wildConfig.substitutesFor !== "all-regular") {
        throw new DraftValidationError(
          `symbol '${symbol.symbol}': wildConfig.substitutesFor must be "all-regular" or a list of symbol ids`,
        );
      }
      if (symbol.wildConfig.multiplier !== undefined && !(symbol.wildConfig.multiplier > 0)) {
        throw new DraftValidationError(`symbol '${symbol.symbol}': wildConfig.multiplier must be a positive number`);
      }
    }

    if (symbol.role === "scatter" && symbol.scatterConfig?.payout) {
      for (const [countKey, multiplier] of Object.entries(symbol.scatterConfig.payout)) {
        const count = Number(countKey);
        if (!Number.isInteger(count) || count < 1) {
          throw new DraftValidationError(
            `symbol '${symbol.symbol}': scatterConfig.payout count ${countKey} must be a positive integer`,
          );
        }
        if (!(multiplier > 0)) {
          throw new DraftValidationError(
            `symbol '${symbol.symbol}': scatterConfig.payout[${countKey}] must be a positive multiplier`,
          );
        }
      }

      // The payout table must cover every count the grid can actually
      // produce, because `evaluateScatter` looks the count up EXACTLY —
      // `payout[count]`, not "the highest entry at or below count".
      //
      // So a table of {3,4,5} on a game where six scatters can land pays
      // 80x at five and *nothing at all* at six. The best outcome in the
      // game silently pays zero: no error, no warning, and a player who
      // hit the rarest screen possible is simply told they won nothing.
      //
      // Caught here rather than in the evaluator because this is a
      // definition mistake, and publish time is where a human can still
      // fix it. Making the evaluator fall back to the nearest lower tier
      // would instead invent a payout the designer never wrote down.
      const declared = Object.keys(symbol.scatterConfig.payout).map(Number);
      if (declared.length > 0) {
        const reachable = maxReachableCount(draft, symbol.symbol);
        const highestDeclared = Math.max(...declared);
        if (reachable > highestDeclared) {
          throw new DraftValidationError(
            `symbol '${symbol.symbol}': up to ${reachable} can land on this grid but scatterConfig.payout ` +
              `only defines up to ${highestDeclared} — counts above that pay nothing. ` +
              `Add an entry for every count up to ${reachable}.`,
          );
        }
      }
    }

    if (symbol.role === "bonusTrigger") {
      const config = symbol.bonusTriggerConfig;
      if (!config?.module) {
        throw new DraftValidationError(`symbol '${symbol.symbol}' is 'bonusTrigger' but has no bonusTriggerConfig.module`);
      }
      if (!bonusModuleIds.has(config.module)) {
        throw new DraftValidationError(
          `symbol '${symbol.symbol}': bonusTriggerConfig.module '${config.module}' has no matching entry in bonusModules`,
        );
      }
      if (!Number.isInteger(config.minCount) || config.minCount <= 0) {
        throw new DraftValidationError(`symbol '${symbol.symbol}': bonusTriggerConfig.minCount must be a positive integer`);
      }
      // A trigger needing more symbols than the grid can hold never fires —
      // the game silently has no bonus at all, and the RTP a designer
      // budgeted for the feature simply disappears.
      const maxPossible = draft.grid.reels * draft.grid.rows;
      if (config.minCount > maxPossible) {
        throw new DraftValidationError(
          `symbol '${symbol.symbol}': bonusTriggerConfig.minCount ${config.minCount} exceeds the ${maxPossible} positions on the grid — this bonus could never trigger`,
        );
      }
    }
  }

  // --- bonus modules ------------------------------------------------------
  const seenModules = new Set<string>();
  for (const module of draft.bonusModules ?? []) {
    if (!module.moduleId?.trim()) throw new DraftValidationError("a bonusModules entry has no moduleId");
    if (seenModules.has(module.moduleId)) {
      throw new DraftValidationError(`bonusModules has a duplicate entry for '${module.moduleId}'`);
    }
    seenModules.add(module.moduleId);

    const chance = module.probabilityTrigger?.chancePerSpin;
    if (chance !== undefined && !(chance > 0 && chance <= 1)) {
      throw new DraftValidationError(
        `bonusModules '${module.moduleId}': probabilityTrigger.chancePerSpin must be a fraction in (0, 1]`,
      );
    }
  }
}

/**
 * The most copies of `symbol` that can appear on screen at once.
 *
 * Computed from the draft's own reels rather than assumed to be one per
 * reel: a strip may carry the same symbol on adjacent positions, so a
 * 3-row window can show several at once, and a weighted pool can produce
 * the symbol in every visible cell.
 *
 * Deliberately an upper bound on what is POSSIBLE, not what is likely. A
 * payout table that fails to cover a reachable count is a definition bug
 * however rare the outcome — and the rarer it is, the worse the failure,
 * because it is the biggest win that silently pays nothing.
 */
function maxReachableCount(draft: GameDraft, symbol: string): number {
  const rows = draft.grid?.rows ?? 0;
  const reels = draft.grid?.reels ?? 0;

  if (draft.reelGenerationMode === "weighted-symbol") {
    // Every cell on a reel whose pool contains the symbol could be it.
    let total = 0;
    for (let reel = 0; reel < reels; reel++) {
      const pool = draft.symbolWeights?.[reel] ?? [];
      if (pool.some((entry) => entry.symbol === symbol && entry.weight > 0)) total += rows;
    }
    return total;
  }

  // Reel-strip mode: slide the visible window over each strip and take the
  // best it can show, since consecutive copies stack within one window.
  let total = 0;
  for (let reel = 0; reel < reels; reel++) {
    const strip = draft.reelStrips?.find((s) => s.reelIndex === reel);
    const symbols = strip?.symbols ?? [];
    if (symbols.length === 0) continue;

    let best = 0;
    for (let stop = 0; stop < symbols.length; stop++) {
      let visible = 0;
      for (let row = 0; row < rows; row++) {
        if (symbols[(stop + row) % symbols.length] === symbol) visible++;
      }
      best = Math.max(best, visible);
    }
    total += best;
  }
  return total;
}
