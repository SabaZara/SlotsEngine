/**
 * How a symbol is drawn, given only its id.
 *
 * The rule worth testing is the fallback, not the table. A game is **data**
 * in this engine, so a symbol this build has never seen arrives by someone
 * publishing a game — not by deploying code. The failure mode is therefore
 * reachable in production without any release: an unstyled symbol that
 * renders as an empty cell, on reels a player is being paid on.
 *
 * The table's own entries are deliberately barely asserted. Restating that
 * `wild` is `0x4fd1ff` pins nothing — it passes whatever the value is, and
 * makes the palette harder to retune. What is asserted is the structural
 * promise: every entry is complete, and the two symbols that carry game
 * meaning are marked as such.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hslToRgb, styleFor } from "./symbolStyle.js";

describe("styleFor", () => {
  it("gives a known symbol its own look", () => {
    assert.equal(styleFor("wild").glyph, "★");
    assert.equal(styleFor("seven").glyph, "7");
  });

  it("marks wild and scatter as needing emphasis", () => {
    // These two carry the game's meaning; a player must find them at a
    // glance. Asserted as a property of the pair rather than as colours.
    assert.equal(styleFor("wild").emphasis, true);
    assert.equal(styleFor("scatter").emphasis, true);
    assert.equal(styleFor("ten").emphasis, false);
  });

  it("gives an unknown symbol a visible glyph rather than nothing", () => {
    // The case that reaches production through a publish rather than a
    // deploy. A blank cell on a paying reel is the failure being prevented.
    const style = styleFor("thunderbolt");
    assert.ok(style.glyph.length > 0, "an unknown symbol rendered no glyph");
    assert.equal(style.glyph, "TH");
  });

  it("gives an unknown symbol a colour inside the visible range", () => {
    const { color } = styleFor("thunderbolt");
    assert.ok(Number.isInteger(color), "colour must be a packed integer for a Pixi tint");
    assert.ok(color >= 0 && color <= 0xffffff, `colour ${color} is outside 24-bit RGB`);
  });

  it("gives the same unknown symbol the same colour every time", () => {
    // Stability across reloads. A symbol that changes colour between
    // sessions reads as a rendering fault.
    assert.equal(styleFor("thunderbolt").color, styleFor("thunderbolt").color);
  });

  it("gives different unknown symbols different colours", () => {
    // A hash that collapsed everything to one hue would satisfy stability
    // while making every new symbol identical.
    const colors = new Set(["alpha", "beta", "gamma", "delta", "epsilon"].map((s) => styleFor(s).color));
    assert.ok(colors.size > 1, "every unknown symbol was given the same colour");
  });

  it("never returns an empty glyph, even for an empty symbol id", () => {
    assert.equal(styleFor("").glyph, "?");
  });

  it("returns a complete style for every entry in the table", () => {
    // Structural rather than value-based: a half-filled entry would render
    // an undefined tint, which Pixi draws as white-on-white.
    for (const symbol of ["ten", "jack", "queen", "king", "ace", "cherry", "plum", "bell", "seven", "wild", "scatter", "star"]) {
      const style = styleFor(symbol);
      assert.ok(style.glyph.length > 0, `${symbol} has no glyph`);
      assert.ok(Number.isInteger(style.color), `${symbol} has a non-integer colour`);
      assert.equal(typeof style.emphasis, "boolean", `${symbol} has no emphasis flag`);
    }
  });
});

describe("hslToRgb", () => {
  it("converts the primaries", () => {
    // Checked against the closed form rather than against this
    // implementation's own output, which would pin it to itself.
    assert.equal(hslToRgb(0, 1, 0.5), 0xff0000);
    assert.equal(hslToRgb(120, 1, 0.5), 0x00ff00);
    assert.equal(hslToRgb(240, 1, 0.5), 0x0000ff);
  });

  it("produces greys at zero saturation", () => {
    assert.equal(hslToRgb(200, 0, 0), 0x000000);
    assert.equal(hslToRgb(200, 0, 1), 0xffffff);
  });

  it("wraps hue rather than clipping it", () => {
    // The caller passes `hash % 360`, but a negative or oversized hue must
    // still land somewhere sensible rather than at black.
    assert.equal(hslToRgb(360, 1, 0.5), hslToRgb(0, 1, 0.5));
    assert.equal(hslToRgb(-120, 1, 0.5), hslToRgb(240, 1, 0.5));
  });

  it("stays inside 24-bit range across the whole hue circle", () => {
    for (let hue = 0; hue < 360; hue += 7) {
      const color = hslToRgb(hue, 0.55, 0.62);
      assert.ok(color >= 0 && color <= 0xffffff, `hue ${hue} produced ${color}`);
    }
  });
});
