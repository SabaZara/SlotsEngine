/**
 * The theme colour rule.
 *
 * **This is a security boundary, not a formatting preference, and that is
 * why it is tested this hard.** A theme colour is written by a designer in
 * the backoffice and ends up interpolated into a CSS custom property on
 * every player's page. CSS accepts far more than colours: `url(...)`
 * fetches a resource, and a value carrying `;` or `}` escapes the
 * declaration it was meant to occupy and can rewrite rules below it. So the
 * question this file answers is not "is this a nice colour" but "can this
 * string do anything other than be a colour".
 *
 * The rule is deliberately narrow — hex only. Named colours and functional
 * forms are individually harmless and are still refused, because allowing
 * them means the check has to reason about CSS syntax rather than match a
 * shape, and every colour picker emits hex anyway.
 *
 * What these cannot establish: that the client actually applies the result,
 * or that the projection filters on the way out. Those are their own tests
 * — a validator can be perfect and uncalled.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { THEME_COLOUR_KEYS, isValidThemeColour, sanitizeGameTheme } from "./game-definition.js";

describe("isValidThemeColour", () => {
  it("accepts the three hex lengths a browser understands", () => {
    assert.equal(isValidThemeColour("#abc"), true, "three-digit shorthand");
    assert.equal(isValidThemeColour("#4fd1ff"), true, "six-digit");
    assert.equal(isValidThemeColour("#4fd1ff80"), true, "eight-digit with alpha");
  });

  it("is case-insensitive, since pickers disagree about which they emit", () => {
    assert.equal(isValidThemeColour("#4FD1FF"), true);
  });

  it("tolerates surrounding whitespace, which pasting reliably introduces", () => {
    assert.equal(isValidThemeColour("  #4fd1ff  "), true);
  });

  it("refuses a value that could fetch a resource", () => {
    // The reason this check exists. A themed page would make a request to
    // whoever the designer named, from every player's browser.
    assert.equal(isValidThemeColour("url(https://evil.example/pixel.png)"), false);
  });

  it("refuses a value that could escape its declaration", () => {
    /*
     * The other half. `--accent: red; } body { display: none } /*` closes
     * the rule it sits in and writes new ones — so a colour field becomes
     * arbitrary CSS on every player's page.
     */
    assert.equal(isValidThemeColour("red; } body { display: none }"), false);
    assert.equal(isValidThemeColour("#fff;"), false);
    assert.equal(isValidThemeColour("#fff}"), false);
  });

  it("refuses functional and named forms, which are harmless and still out of scope", () => {
    // Not dangerous in themselves. Refused because a check that accepts them
    // has to parse CSS rather than match a shape, and a designer loses
    // nothing — every colour picker emits hex.
    assert.equal(isValidThemeColour("red"), false);
    assert.equal(isValidThemeColour("rgb(255, 0, 0)"), false);
    assert.equal(isValidThemeColour("var(--accent)"), false);
    assert.equal(isValidThemeColour("color-mix(in srgb, red, blue)"), false);
  });

  it("refuses a malformed hex rather than guessing what was meant", () => {
    assert.equal(isValidThemeColour("#12"), false, "too short");
    assert.equal(isValidThemeColour("#12345"), false, "five digits is not a hex colour");
    assert.equal(isValidThemeColour("#gggggg"), false, "not hex digits");
    assert.equal(isValidThemeColour("4fd1ff"), false, "missing the hash");
  });

  it("refuses anything that is not a string", () => {
    // This crosses a socket and a database, so the type is a claim rather
    // than a guarantee.
    assert.equal(isValidThemeColour(undefined), false);
    assert.equal(isValidThemeColour(null), false);
    assert.equal(isValidThemeColour(0x4fd1ff), false, "the reference's numeric form is not ours");
    assert.equal(isValidThemeColour(["#fff"]), false);
  });
});

describe("sanitizeGameTheme", () => {
  it("keeps every valid colour", () => {
    const theme = sanitizeGameTheme({ accent: "#4fd1ff", win: "#ffd166" });

    assert.deepEqual(theme, { accent: "#4fd1ff", win: "#ffd166" });
  });

  it("drops one bad colour without costing the others", () => {
    /*
     * Filtering rather than rejecting, and it matters. The client falls back
     * per field, so a partial theme is a working game with one wrong colour
     * — whereas refusing the whole object would throw away six correct
     * choices because of one typo.
     */
    const theme = sanitizeGameTheme({ accent: "#4fd1ff", win: "url(https://evil.example)" });

    assert.deepEqual(theme, { accent: "#4fd1ff" });
  });

  it("drops keys that are not colours at all", () => {
    // The property that lets the public projection type this as `GameTheme`
    // rather than re-listing each field: a key added to the interface later
    // still cannot publish itself, because anything outside
    // THEME_COLOUR_KEYS is not copied.
    const theme = sanitizeGameTheme({ accent: "#4fd1ff", internalNote: "do not ship", __proto__: "x" });

    assert.deepEqual(theme, { accent: "#4fd1ff" });
  });

  it("returns undefined when nothing survives, rather than an empty theme", () => {
    // Absence is how every consumer decides "no theme". An empty object
    // claims a theme that styles nothing, which is a different statement.
    assert.equal(sanitizeGameTheme({ accent: "not-a-colour" }), undefined);
    assert.equal(sanitizeGameTheme({}), undefined);
  });

  it("returns undefined for a value that is not an object", () => {
    assert.equal(sanitizeGameTheme(undefined), undefined);
    assert.equal(sanitizeGameTheme(null), undefined);
    assert.equal(sanitizeGameTheme("#4fd1ff"), undefined);
  });

  it("trims what it keeps, so a pasted value reaches CSS clean", () => {
    assert.deepEqual(sanitizeGameTheme({ accent: "  #4fd1ff  " }), { accent: "#4fd1ff" });
  });

  it("covers every key the interface declares", () => {
    // Guards the list against drifting from the type: a key added to
    // GameTheme and forgotten here would be silently unsettable, which
    // looks exactly like a designer's choice not saving.
    const all = Object.fromEntries(THEME_COLOUR_KEYS.map((k) => [k, "#010203"]));

    assert.deepEqual(sanitizeGameTheme(all), all);
  });
});
