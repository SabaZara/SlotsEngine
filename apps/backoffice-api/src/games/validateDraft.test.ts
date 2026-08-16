import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameDraft } from "./drafts.js";
import { blankDraft } from "./drafts.js";
import { DraftValidationError, validateDraft } from "./validateDraft.js";

const base = (): GameDraft => blankDraft("test-game", "Test Game", "user-1");

/** Asserts the draft is rejected, and that the message names the real
 * problem — an error a designer can't act on is barely better than none. */
function rejects(draft: GameDraft, matching: RegExp): void {
  assert.throws(() => validateDraft(draft), (err: Error) => {
    assert.ok(err instanceof DraftValidationError, `expected a DraftValidationError, got ${err.constructor.name}`);
    assert.match(err.message, matching);
    return true;
  });
}

describe("validateDraft", () => {
  it("accepts the starter draft a new game begins from", () => {
    // If this ever fails, every new game starts broken.
    assert.doesNotThrow(() => validateDraft(base()));
  });

  describe("presence", () => {
    it("requires a name", () => rejects({ ...base(), name: "  " }, /name is required/));
    it("requires at least one payline", () => rejects({ ...base(), paylines: [] }, /at least one payline/));
    it("requires at least one symbol", () => rejects({ ...base(), symbols: [] }, /at least one symbol/));
    it("requires at least one bet option", () => rejects({ ...base(), betOptions: [] }, /at least one bet option/));
  });

  describe("money", () => {
    it("rejects a fractional bet option", () => {
      // A float here reaches the ledger's $inc and corrupts a balance with
      // no error raised anywhere downstream.
      rejects({ ...base(), betOptions: [1.5] }, /positive integer \(minor units\)/);
    });

    it("rejects a zero or negative bet option", () => {
      rejects({ ...base(), betOptions: [0] }, /positive integer/);
      rejects({ ...base(), betOptions: [-100] }, /positive integer/);
    });

    it("rejects an RTP target expressed as a percentage", () => {
      // 95 instead of 0.95 is the single most likely data-entry slip here,
      // and it would sail through every other check.
      rejects({ ...base(), rtpTarget: 95 }, /fraction like 0\.95/);
    });
  });

  describe("shape consistency after a grid resize", () => {
    it("rejects a payline whose length no longer matches the grid", () => {
      // The classic stale-draft bug: the grid shrank, the paylines didn't.
      rejects({ ...base(), grid: { reels: 3, rows: 3 } }, /payline 0 has 5 entries, but grid\.reels is 3/);
    });

    it("rejects a payline referencing a row outside the grid", () => {
      rejects({ ...base(), paylines: [[0, 0, 0, 0, 9]] }, /references a row outside 0-2/);
    });

    it("accepts null as a deliberate 'this reel is not part of the line'", () => {
      assert.doesNotThrow(() => validateDraft({ ...base(), paylines: [[0, 0, 0, null, null]] }));
    });

    it("rejects a reel strip for a reel the grid does not have", () => {
      const draft = base();
      draft.reelStrips = [...draft.reelStrips!, { reelIndex: 9, symbols: ["ten", "jack", "queen"] }];
      rejects(draft, /entry for reel 9, but grid\.reels is 5/);
    });

    it("rejects a missing reel strip", () => {
      // Publishes fine, then throws on the first spin reaching that reel.
      const draft = base();
      draft.reelStrips = draft.reelStrips!.slice(0, 4);
      rejects(draft, /no reel strip defined for reel 4/);
    });

    it("rejects a strip shorter than the visible rows", () => {
      const draft = base();
      draft.reelStrips = draft.reelStrips!.map((s) => ({ ...s, symbols: ["ten", "jack"] }));
      rejects(draft, /fewer than the 3 visible rows/);
    });
  });

  describe("cross-references", () => {
    it("rejects a strip naming a symbol that does not exist", () => {
      // The usual cause: a symbol was deleted and the strips weren't updated.
      const draft = base();
      draft.reelStrips![0].symbols[0] = "ghost";
      rejects(draft, /references undefined symbol 'ghost'/);
    });

    it("rejects duplicate symbol ids", () => {
      const draft = base();
      draft.symbols = [...draft.symbols, { ...draft.symbols[0] }];
      rejects(draft, /symbol ids must be unique/);
    });

    it("rejects a wild substituting a symbol that does not exist", () => {
      const draft = base();
      draft.symbols.push({
        symbol: "wild",
        allowedReels: [1, 2, 3],
        role: "wild",
        wildConfig: { substitutesFor: ["nope"] },
      });
      rejects(draft, /substitutesFor references undefined symbol 'nope'/);
    });

    it("rejects a bonus trigger pointing at an unconfigured module", () => {
      const draft = base();
      draft.symbols.push({
        symbol: "star",
        allowedReels: [0, 1, 2, 3, 4],
        role: "bonusTrigger",
        bonusTriggerConfig: { module: "wheel", minCount: 3 },
      });
      rejects(draft, /has no matching entry in bonusModules/);
    });

    it("rejects a bonus that could never trigger", () => {
      // minCount above the number of grid positions means the feature
      // silently never fires, and its whole RTP budget vanishes.
      const draft = base();
      draft.bonusModules = [{ moduleId: "wheel", params: {} }];
      draft.symbols.push({
        symbol: "star",
        allowedReels: [0, 1, 2, 3, 4],
        role: "bonusTrigger",
        bonusTriggerConfig: { module: "wheel", minCount: 99 },
      });
      rejects(draft, /could never trigger/);
    });
  });

  describe("per-symbol rules", () => {
    it("rejects a regular symbol with no paytable", () => {
      const draft = base();
      draft.symbols[0] = { ...draft.symbols[0], paytable: undefined };
      rejects(draft, /is 'regular' but has no paytable/);
    });

    it("rejects a paytable count above the reel count", () => {
      const draft = base();
      draft.symbols[0] = { ...draft.symbols[0], paytable: { 9: 10 } };
      rejects(draft, /must be between 1 and grid\.reels/);
    });

    it("rejects a non-positive payout multiplier", () => {
      const draft = base();
      draft.symbols[0] = { ...draft.symbols[0], paytable: { 3: 0 } };
      rejects(draft, /must be a positive multiplier/);
    });

    it("rejects allowedReels pointing outside the grid", () => {
      const draft = base();
      draft.symbols[0] = { ...draft.symbols[0], allowedReels: [0, 7] };
      rejects(draft, /allowedReels references a reel outside 0-4/);
    });

    it("rejects a wild with no config at all", () => {
      const draft = base();
      draft.symbols.push({ symbol: "wild", allowedReels: [1], role: "wild" });
      rejects(draft, /is 'wild' but has no wildConfig/);
    });

    it("rejects a non-positive wild multiplier", () => {
      const draft = base();
      draft.symbols.push({
        symbol: "wild",
        allowedReels: [1],
        role: "wild",
        wildConfig: { substitutesFor: "all-regular", multiplier: 0 },
      });
      rejects(draft, /multiplier must be a positive number/);
    });
  });

  describe("weighted-symbol mode", () => {
    const weighted = (): GameDraft => ({
      ...base(),
      reelGenerationMode: "weighted-symbol",
      reelStrips: undefined,
      symbolWeights: Array.from({ length: 5 }, () => [
        { symbol: "ten", weight: 10 },
        { symbol: "jack", weight: 5 },
        { symbol: "queen", weight: 3 },
        { symbol: "king", weight: 2 },
        { symbol: "ace", weight: 1 },
      ]),
    });

    it("accepts a well-formed weighted game", () => {
      assert.doesNotThrow(() => validateDraft(weighted()));
    });

    it("rejects a pool count that does not match the reels", () => {
      const draft = weighted();
      draft.symbolWeights = draft.symbolWeights!.slice(0, 3);
      rejects(draft, /has 3 pools, but grid\.reels is 5/);
    });

    it("rejects a pool whose weights all sum to zero", () => {
      // Every draw would fall through to the last entry — a silently
      // rigged reel that raises no error anywhere downstream.
      const draft = weighted();
      draft.symbolWeights![0] = draft.symbolWeights![0].map((e) => ({ ...e, weight: 0 }));
      rejects(draft, /at least one symbol must have weight/);
    });

    it("rejects a pool naming an undefined symbol", () => {
      const draft = weighted();
      draft.symbolWeights![0][0] = { symbol: "ghost", weight: 5 };
      rejects(draft, /references undefined symbol 'ghost'/);
    });
  });

  describe("hand-crafted requests", () => {
    it("rejects an explicitly null currency without crashing", () => {
      // A null here would crash `.trim()` as an unhandled 500 rather than
      // producing a real validation error.
      rejects({ ...base(), currency: null as unknown as string }, /non-empty ISO 4217 code/);
    });

    it("rejects an unknown payline win rule", () => {
      rejects({ ...base(), paylineWinRule: "highest" as never }, /must be 'sum' or 'highestOnly'/);
    });

    it("rejects an unknown symbol role", () => {
      const draft = base();
      draft.symbols[0] = { ...draft.symbols[0], role: "bonus" as never };
      rejects(draft, /role 'bonus' is not valid/);
    });
  });
});
