/**
 * The theme editor.
 *
 * Built as the artwork editor's sibling and tested for the same F24 reason:
 * a `theme` field the client renders and no screen can write is a feature
 * complete everywhere except where someone would use it.
 *
 * What makes theme bugs quiet is the same tolerance that makes them safe:
 * the projection drops an invalid colour on the way out, and the client
 * falls back per field. Both are correct — a bad colour must never blank a
 * page — but it means a typo saves cleanly, publishes cleanly, and renders
 * as the default. The designer sees a field they filled in and a game that
 * ignored it. This form is the only place that is catchable.
 *
 * Deliberately not asserted: exact wording or the swatch's rendering. What
 * is pinned is that every colour gets a field, that an invalid one is
 * called out, and that clearing one removes the key rather than storing "".
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GameTheme } from "@slots-engine/shared-types";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { ThemeEditor, applyThemeEdit, themeColourWarning } from "./ThemeEditor.js";

afterEach(() => cleanup());
after(() => uninstallDom());

describe("applyThemeEdit", () => {
  it("sets a colour on a game that had no theme at all", () => {
    // Every game in this repo ships no theme, so this is the path a designer
    // actually starts from.
    assert.deepEqual(applyThemeEdit(undefined, "accent", "#4fd1ff"), { accent: "#4fd1ff" });
  });

  it("leaves the other colours alone", () => {
    const before: GameTheme = { accent: "#4fd1ff" };

    assert.deepEqual(applyThemeEdit(before, "win", "#ffd166"), { accent: "#4fd1ff", win: "#ffd166" });
  });

  it("does not mutate the theme it was given", () => {
    // React state: a mutation would change the object the previous render
    // still holds, which is the class of bug where a screen shows the right
    // value and re-renders to the wrong one.
    const before: GameTheme = { accent: "#4fd1ff" };

    applyThemeEdit(before, "win", "#ffd166");

    assert.deepEqual(before, { accent: "#4fd1ff" });
  });

  it("removes the key when a field is emptied, rather than storing an empty string", () => {
    /*
     * Absence is how every consumer decides "use the built-in colour". An
     * empty string is a present value that fails validation and is dropped
     * anyway — so it stores a choice that does nothing, indistinguishable
     * on screen from the default the designer was trying to change.
     */
    const before: GameTheme = { accent: "#4fd1ff", win: "#ffd166" };

    assert.deepEqual(applyThemeEdit(before, "win", ""), { accent: "#4fd1ff" });
  });

  it("returns undefined once the last colour is cleared", () => {
    // Matched to the publish path, which carries `theme` only when defined.
    assert.equal(applyThemeEdit({ accent: "#4fd1ff" }, "accent", ""), undefined);
  });

  it("trims a pasted value", () => {
    assert.deepEqual(applyThemeEdit(undefined, "accent", "  #4fd1ff  "), { accent: "#4fd1ff" });
  });

  it("stores an invalid value rather than silently discarding the keystroke", () => {
    /*
     * Deliberate, and the opposite of what the projection does. A designer
     * halfway through typing "#4fd" must see what they typed — dropping it
     * here would make the field impossible to type into. The value is
     * warned about below, refused at the boundary, and never reaches CSS.
     */
    assert.deepEqual(applyThemeEdit(undefined, "accent", "#4fd"), { accent: "#4fd" });
  });
});

describe("themeColourWarning", () => {
  it("says nothing about an empty field, which is the ordinary case", () => {
    // Every game here ships no theme, so warning on absence would make the
    // form noisy by the second day.
    assert.equal(themeColourWarning(""), null);
  });

  it("accepts the hex forms a browser understands", () => {
    assert.equal(themeColourWarning("#abc"), null);
    assert.equal(themeColourWarning("#4fd1ff"), null);
    assert.equal(themeColourWarning("#4fd1ff80"), null);
  });

  it("warns about a named colour, which this engine does not accept", () => {
    assert.ok(themeColourWarning("red"));
  });

  it("warns about a value that could escape into the stylesheet", () => {
    assert.ok(themeColourWarning("red; } body { display: none }"));
    assert.ok(themeColourWarning("url(https://evil.example)"));
  });

  it("says what will happen, not merely that the value is wrong", () => {
    // The load-bearing half. "Invalid" suggests something will refuse it;
    // nothing will — the game publishes and quietly uses the default.
    const message = themeColourWarning("red");
    assert.ok(message);
    assert.match(message, /ignored|built-in/i);
  });
});

describe("ThemeEditor", () => {
  it("renders a field for every colour a theme can set", () => {
    // F24 at the form level: a colour absent from the form is a colour a
    // designer cannot set, however correct the client is.
    renderComponent(<ThemeEditor theme={undefined} onChange={() => {}} />);

    for (const label of ["Background", "Panel", "Border", "Text", "Muted text", "Accent", "Win"]) {
      assert.ok(screen.getByRole("textbox", { name: label }), `${label} has no field`);
    }
  });

  it("shows the colour already stored", () => {
    renderComponent(<ThemeEditor theme={{ accent: "#4fd1ff" }} onChange={() => {}} />);

    // Scoped to the text field: the picker legitimately holds the same
    // value, so an unscoped query is ambiguous — which is itself the
    // evidence that both controls are bound to one source.
    assert.equal((screen.getByRole("textbox", { name: "Accent" }) as HTMLInputElement).value, "#4fd1ff");
  });

  it("reports an edited colour to its parent", () => {
    const seen: Array<GameTheme | undefined> = [];
    renderComponent(<ThemeEditor theme={undefined} onChange={(t) => seen.push(t)} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Accent" }), { target: { value: "#4fd1ff" } });

    assert.deepEqual(seen.at(-1), { accent: "#4fd1ff" });
  });

  it("warns in place about a colour the client will refuse", () => {
    renderComponent(<ThemeEditor theme={{ accent: "red" }} onChange={() => {}} />);

    assert.ok(screen.getByText(/ignored/i), "an invalid colour produced no warning");
  });

  it("does not warn about a colour that will apply", () => {
    renderComponent(<ThemeEditor theme={{ accent: "#4fd1ff" }} onChange={() => {}} />);

    assert.equal(screen.queryByText(/ignored/i), null);
  });

  it("clears a colour when its field is emptied", async () => {
    const seen: Array<GameTheme | undefined> = [];
    renderComponent(<ThemeEditor theme={{ accent: "#4fd1ff" }} onChange={(t) => seen.push(t)} />);

    await interact(() =>
      fireEvent.change(screen.getByRole("textbox", { name: "Accent" }), { target: { value: "" } }),
    );

    assert.equal(seen.at(-1), undefined, "an emptied field must remove the colour, not store an empty string");
  });

  it("offers a picker alongside the text field, not instead of it", () => {
    /*
     * Both, deliberately. The native picker cannot express "unset" — it
     * always reports a colour — so clearing needs the text field, and a
     * designer pasting a brand hex needs it too.
     */
    renderComponent(<ThemeEditor theme={undefined} onChange={() => {}} />);

    assert.ok(screen.getByLabelText("Accent colour picker"));
    assert.ok(screen.getByRole("textbox", { name: "Accent" }));
  });
});
