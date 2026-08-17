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

  describe("artwork", () => {
    /**
     * Assets are public by nature — every player sees these images, and a
     * URL a browser cannot fetch is useless. So the interesting property is
     * not secrecy but that this stays an **allowlist**: a field added to
     * `GameAssets` later must be a decision someone makes in this file
     * rather than something that publishes itself.
     */
    it("omits the assets key entirely for a game with no artwork", () => {
      /**
       * Every fixture in this repo. An empty object would be a different
       * document from one that never had assets, and the client's own
       * fallback keys off absence.
       *
       * Worth recording how this behaves under mutation, because the result
       * is unusual: forcing the key to be emitted unconditionally does not
       * *survive*, it **crashes** — `gameDef.assets` is undefined for every
       * shipped game, so reading `.symbolImageUrls` off it throws before a
       * single test runs. The guard is load-bearing at runtime rather than
       * merely observed by an assertion, which is a stronger position than
       * a caught mutation.
       */
      assert.ok(!("assets" in view), "a game with no artwork should not carry an assets key");
    });

    it("carries configured symbol images and a background", () => {
      const withArt = toPublicView({
        ...REFERENCE_GAME,
        assets: { symbolImageUrls: { seven: "https://cdn.example.com/seven.png" }, backgroundUrl: "https://cdn.example.com/bg.jpg" },
      }) as unknown as Record<string, unknown>;

      assert.deepEqual(withArt.assets, {
        symbolImageUrls: { seven: "https://cdn.example.com/seven.png" },
        backgroundUrl: "https://cdn.example.com/bg.jpg",
      });
    });

    it("is an allowlist within assets too — a new asset field is withheld", () => {
      // The same property as the outer projection, one level down. Spreading
      // `gameDef.assets` would have published this automatically, which is
      // the failure this file exists to prevent.
      const withExtra = toPublicView({
        ...REFERENCE_GAME,
        assets: {
          symbolImageUrls: { seven: "https://cdn.example.com/seven.png" },
          // @ts-expect-error deliberately modelling a future field
          internalUploadPath: "/var/uploads/secret",
        },
      }) as unknown as { assets: Record<string, unknown> };

      assert.ok(!("internalUploadPath" in withExtra.assets), "a new asset field must not publish itself");
      assert.ok("symbolImageUrls" in withExtra.assets);
    });

    it("publishes a game's sound alongside its artwork", () => {
      // The projection is an explicit allowlist, so a new asset field that
      // nobody adds here is simply never served — F26's shape, and the
      // reason each key is named rather than the object spread.
      const view = toPublicView({
        ...REFERENCE_GAME,
        assets: { musicUrl: "https://cdn.example.com/bg.mp3", spinSoundUrl: "https://cdn.example.com/spin.mp3" },
      } as never) as unknown as { assets: Record<string, unknown> };

      assert.equal(view.assets.musicUrl, "https://cdn.example.com/bg.mp3");
      assert.equal(view.assets.spinSoundUrl, "https://cdn.example.com/spin.mp3");
    });

    it("publishes a game's theme, sanitized rather than passed through", () => {
      /*
       * Sanitized HERE rather than trusted, and that is the point. A colour
       * the client would refuse is worse than no colour: the client falls
       * back silently, so a designer sees their choice "saved" and never
       * applied. Dropping it at the boundary means the projection only ever
       * carries colours that will actually render.
       *
       * It also matters as a security boundary — these values become CSS
       * custom properties on every player's page, so a value carrying `;`
       * or `url(...)` must not reach a browser at all.
       */
      const view = toPublicView({
        ...REFERENCE_GAME,
        theme: { accent: "#4fd1ff", win: "url(https://evil.example/pixel.png)" },
      } as never) as unknown as { theme: Record<string, unknown> };

      assert.deepEqual(view.theme, { accent: "#4fd1ff" }, "only renderable colours may be published");
    });

    it("omits the theme key entirely for a game with no colours", () => {
      const view = toPublicView(REFERENCE_GAME) as unknown as Record<string, unknown>;

      assert.ok(!("theme" in view), "a game with no theme must not carry a theme key");
    });

    it("withholds a non-colour key smuggled into the theme", () => {
      // The reason the projection can type this field as `GameTheme` rather
      // than re-listing each colour: anything outside THEME_COLOUR_KEYS is
      // dropped, so a key added to the interface still cannot publish
      // itself.
      const view = toPublicView({
        ...REFERENCE_GAME,
        theme: { accent: "#4fd1ff", internalNote: "do not ship" },
      } as never) as unknown as { theme: Record<string, unknown> };

      assert.ok(!("internalNote" in view.theme));
    });

    it("omits an asset key the game did not set, rather than sending undefined", () => {
      const partial = toPublicView({
        ...REFERENCE_GAME,
        assets: { symbolImageUrls: { seven: "https://cdn.example.com/seven.png" } },
      }) as unknown as { assets: Record<string, unknown> };

      assert.ok(!("backgroundUrl" in partial.assets));
    });

    it("does not let artwork reach anything the evaluator reads", () => {
      /**
       * The separation that makes artwork safe to change on a published
       * game without re-running the publish gate: assets are presentation,
       * and the game's mathematics is its strips, weights, paytable and
       * bonus params. Asserted by comparing the whole projection with and
       * without artwork — only the `assets` key may differ.
       */
      const withArt = toPublicView({
        ...REFERENCE_GAME,
        assets: { symbolImageUrls: { seven: "https://cdn.example.com/seven.png" } },
      }) as unknown as Record<string, unknown>;

      const { assets: _added, ...rest } = withArt;
      assert.deepEqual(rest, view, "adding artwork changed something other than the assets key");
    });
  });
});
