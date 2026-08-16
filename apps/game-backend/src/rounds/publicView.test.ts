import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REFERENCE_GAME } from "@slots-engine/math-engine";
import { toPublicView } from "./publicView.js";

describe("toPublicView", () => {
  const view = toPublicView(REFERENCE_GAME) as unknown as Record<string, unknown>;

  it("never exposes reel strips — the game's frequency data", () => {
    // With the strips, a player can compute exactly how often each symbol
    // lands and size their bets accordingly.
    assert.ok(!("reelStrips" in view), "reelStrips must never reach a browser");
  });

  it("never exposes symbol weights", () => {
    assert.ok(!("symbolWeights" in view), "symbolWeights must never reach a browser");
  });

  it("never exposes the RTP target or the engine id", () => {
    assert.ok(!("rtpTarget" in view));
    assert.ok(!("mathEngineId" in view));
  });

  it("does expose allowedReels — where a symbol may land, not how often", () => {
    // A coarse static fact a player infers by watching anyway, and the
    // client needs it to avoid rendering symbols on reels they can never
    // stop on.
    const wild = view.symbols as Array<{ symbol: string; allowedReels: number[] }>;
    assert.deepEqual(wild.find((s) => s.symbol === "wild")?.allowedReels, [1, 2, 3]);
  });

  it("exposes what a client needs to draw the game", () => {
    assert.equal(view.gameId, REFERENCE_GAME.gameId);
    assert.deepEqual(view.grid, REFERENCE_GAME.grid);
    assert.deepEqual(view.paylines, REFERENCE_GAME.paylines);
    assert.deepEqual(view.betOptions, REFERENCE_GAME.betOptions);
    assert.equal((view.symbols as unknown[]).length, REFERENCE_GAME.symbols.length);
  });

  it("is an allowlist — a new secret field is withheld by default", () => {
    // This is the property that makes the projection safe over time: the
    // failure mode of a blocklist is that tomorrow's field leaks silently.
    const withSecret = toPublicView({
      ...REFERENCE_GAME,
      // @ts-expect-error deliberately modelling a future field
      houseEdgeSchedule: { secret: true },
    }) as unknown as Record<string, unknown>;
    assert.ok(!("houseEdgeSchedule" in withSecret));
  });

  it("carries the paytable, which a player is entitled to see", () => {
    const symbols = view.symbols as Array<{ symbol: string; paytable?: Record<number, number> }>;
    assert.deepEqual(symbols.find((s) => s.symbol === "seven")?.paytable, REFERENCE_GAME.symbols.find((s) => s.symbol === "seven")?.paytable);
  });
});
