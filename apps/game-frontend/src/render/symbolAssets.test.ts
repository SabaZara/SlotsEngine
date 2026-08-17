/**
 * Which artwork a symbol gets, and which URLs are refused.
 *
 * Two rules are being pinned, and they pull in opposite directions, which is
 * why both need tests:
 *
 * 1. **A missing picture must never hide a symbol.** Artwork is optional at
 *    every level — no assets, a symbol absent from the map, a URL that 404s
 *    — and every one of those falls back to a placeholder. A blank cell on a
 *    reel a player is being paid on is a worse failure than an ugly one,
 *    because the player cannot tell what they won.
 * 2. **Not every configured URL should be fetched.** A game definition is
 *    data a designer edits, so its URLs reach the loader directly. Refusing
 *    is always safe here precisely because of rule 1 — a refused URL is a
 *    placeholder, not a broken game.
 *
 * What these cannot establish: that `Assets.load` succeeds, or that the
 * renderer draws the texture it was handed. `jsdom` provides no WebGL
 * context, so that half is verified by running the client — stated rather
 * than implied, per the file headers elsewhere in this repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backgroundImageUrl,
  isLoadableAssetUrl,
  shouldWarnAboutAssets,
  summariseLoad,
  symbolImageUrl,
} from "./symbolAssets.js";

describe("isLoadableAssetUrl", () => {
  it("accepts ordinary http and https URLs", () => {
    assert.equal(isLoadableAssetUrl("https://cdn.example.com/seven.png"), true);
    assert.equal(isLoadableAssetUrl("http://cdn.example.com/seven.png"), true);
  });

  it("accepts a relative path, which is where a self-hosted asset lives", () => {
    assert.equal(isLoadableAssetUrl("/assets/seven.png"), true);
    assert.equal(isLoadableAssetUrl("assets/seven.png"), true);
  });

  it("refuses a javascript: URL", () => {
    // A game definition is data a designer edits, and this value reaches
    // the asset loader directly. Refusing costs a placeholder.
    assert.equal(isLoadableAssetUrl("javascript:alert(1)"), false);
    assert.equal(isLoadableAssetUrl("JavaScript:alert(1)"), false);
  });

  it("refuses a data: URL", () => {
    // No legitimate reason for a published game to carry its art inline,
    // and an inline blob bypasses every network control an operator has.
    assert.equal(isLoadableAssetUrl("data:image/png;base64,iVBORw0KGgo="), false);
  });

  it("refuses a blob: URL", () => {
    assert.equal(isLoadableAssetUrl("blob:http://localhost/abc"), false);
  });

  it("refuses an empty or whitespace-only value", () => {
    // A field a designer cleared. Treating it as a URL would produce a
    // request to the page's own origin for nothing.
    assert.equal(isLoadableAssetUrl(""), false);
    assert.equal(isLoadableAssetUrl("   "), false);
  });

  it("refuses a non-string, since a definition is JSON a designer edits", () => {
    assert.equal(isLoadableAssetUrl(undefined), false);
    assert.equal(isLoadableAssetUrl(null), false);
    assert.equal(isLoadableAssetUrl(42), false);
    assert.equal(isLoadableAssetUrl({ url: "https://x/y.png" }), false);
  });
});

describe("symbolImageUrl", () => {
  const assets = { symbolImageUrls: { seven: "https://cdn.example.com/seven.png", bad: "javascript:alert(1)" } };

  it("returns the configured URL for a symbol that has one", () => {
    assert.equal(symbolImageUrl(assets, "seven"), "https://cdn.example.com/seven.png");
  });

  it("returns null for a symbol with no artwork, rather than throwing", () => {
    // The ordinary case: every fixture in this repo ships no assets at all,
    // so an exception here would make the common path the error path.
    assert.equal(symbolImageUrl(assets, "cherry"), null);
  });

  it("returns null when the game has no assets at all", () => {
    assert.equal(symbolImageUrl(undefined, "seven"), null);
    assert.equal(symbolImageUrl({}, "seven"), null);
  });

  it("returns null for a symbol whose URL is refused", () => {
    // Refusal and absence must be indistinguishable to the caller, so a
    // hostile URL degrades to exactly the same placeholder as no URL.
    assert.equal(symbolImageUrl(assets, "bad"), null);
  });
});

describe("backgroundImageUrl", () => {
  it("returns a configured background", () => {
    assert.equal(backgroundImageUrl({ backgroundUrl: "https://cdn.example.com/bg.jpg" }), "https://cdn.example.com/bg.jpg");
  });

  it("returns null when absent or refused", () => {
    assert.equal(backgroundImageUrl(undefined), null);
    assert.equal(backgroundImageUrl({}), null);
    assert.equal(backgroundImageUrl({ backgroundUrl: "data:image/png;base64,x" }), null);
  });
});

describe("summariseLoad", () => {
  const symbols = ["seven", "bell", "cherry", "wild"];
  // seven and bell have artwork; seven loads, bell fails.
  const configured = (s: string) => s === "seven" || s === "bell";
  const succeeded = (s: string) => s === "seven";

  it("separates a failure from a symbol that never asked for artwork", () => {
    /**
     * The distinction the whole report exists for. A game with no artwork
     * is not a problem — it is every game in this repo today. A game that
     * asked and got nothing is an outage, and conflating the two means
     * either warning constantly or never.
     */
    const report = summariseLoad(symbols, configured, succeeded);

    assert.equal(report.requested, 2);
    assert.equal(report.loaded, 1);
    assert.deepEqual(report.failed, ["bell"]);
    assert.deepEqual(report.unconfigured, ["cherry", "wild"]);
  });

  it("counts a game with no artwork as nothing requested", () => {
    const report = summariseLoad(symbols, () => false, () => false);

    assert.equal(report.requested, 0);
    assert.deepEqual(report.failed, []);
    assert.equal(report.unconfigured.length, 4);
  });

  it("names every symbol that fell back, not just how many", () => {
    // A count tells someone there is a problem; the names tell them which
    // asset to go and look at.
    const report = summariseLoad(symbols, () => true, () => false);
    assert.deepEqual(report.failed, symbols);
  });
});

describe("shouldWarnAboutAssets", () => {
  it("stays quiet for a game that ships no artwork", () => {
    // Every fixture here. A warning on the normal case is a warning nobody
    // reads by the second day.
    const report = summariseLoad(["seven"], () => false, () => false);
    assert.equal(shouldWarnAboutAssets(report), false);
  });

  it("warns when artwork was configured and did not arrive", () => {
    // The outage case. Silently rendering placeholders for every symbol
    // looks like a styling choice rather than a dead asset host, which is
    // exactly the kind of thing nobody notices for a week.
    const report = summariseLoad(["seven"], () => true, () => false);
    assert.equal(shouldWarnAboutAssets(report), true);
  });

  it("stays quiet when everything configured loaded", () => {
    const report = summariseLoad(["seven"], () => true, () => true);
    assert.equal(shouldWarnAboutAssets(report), false);
  });
});
