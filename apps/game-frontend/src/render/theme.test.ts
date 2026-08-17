/**
 * Mapping a game's theme onto CSS variables.
 *
 * The interesting failure here is not "the colour is wrong" but "the colour
 * landed on the wrong variable" — a game whose panel colour was written to
 * `--border` renders perfectly and renders wrong, and no error is raised
 * anywhere. So the mapping itself is asserted key by key rather than
 * spot-checked.
 *
 * The validity check is duplicated from `sanitizeGameTheme` deliberately,
 * and the duplication is tested here too: this module is reachable from a
 * cached or hand-edited payload that never passed through the projection,
 * and the cost of being wrong is CSS injection rather than an odd colour.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { themeCssVariables } from "./theme.js";

describe("themeCssVariables", () => {
  it("maps every key to the variable the stylesheet actually uses", () => {
    /*
     * Asserted exhaustively because an off-by-one row is invisible: the page
     * still renders, with two colours swapped, and nothing reports it.
     *
     * Note `background` -> `--bg`, which is why the mapping is a written
     * table rather than a `--${key}` template. A convention with one
     * exception cannot be relied on by the next key added.
     */
    const vars = themeCssVariables({
      background: "#010203",
      panel: "#040506",
      border: "#070809",
      text: "#0a0b0c",
      muted: "#0d0e0f",
      accent: "#101112",
      win: "#131415",
    });

    assert.deepEqual(vars, {
      "--bg": "#010203",
      "--panel": "#040506",
      "--border": "#070809",
      "--text": "#0a0b0c",
      "--muted": "#0d0e0f",
      "--accent": "#101112",
      "--win": "#131415",
    });
  });

  it("sets only what the theme names, leaving the rest to the stylesheet", () => {
    // What makes a theme additive rather than a replacement a designer must
    // complete before the page looks right.
    assert.deepEqual(themeCssVariables({ accent: "#4fd1ff" }), { "--accent": "#4fd1ff" });
  });

  it("writes nothing at all for a game with no theme", () => {
    assert.deepEqual(themeCssVariables(undefined), {});
    assert.deepEqual(themeCssVariables({}), {});
  });

  it("refuses a value that would escape into the stylesheet", () => {
    /*
     * The second guard, and not redundant with the projection's. This
     * module can be reached from a payload that never passed through it —
     * a cached response, a hand-edited document — and the failure mode is
     * arbitrary CSS on a player's page rather than a wrong colour.
     */
    const vars = themeCssVariables({
      accent: "red; } body { display: none }",
      win: "url(https://evil.example/pixel.png)",
      text: "#0a0b0c",
    });

    assert.deepEqual(vars, { "--text": "#0a0b0c" }, "only the valid colour may reach CSS");
  });

  it("trims a pasted value, since trailing space reaches the stylesheet verbatim", () => {
    assert.deepEqual(themeCssVariables({ accent: "  #4fd1ff  " }), { "--accent": "#4fd1ff" });
  });
});
