/**
 * The artwork editor.
 *
 * **The reason this screen needs tests is the reason it needed to exist.**
 * Artwork was already served by the public projection, already rendered by
 * the player client, already covered by 19 tests on the loader — and was
 * still unreachable, because nothing in the backoffice could write the field.
 * That is F24's shape, and building this turned up two more instances of it
 * on the same untravelled path: `publishDraft`'s allowlist dropped `assets`
 * at the one step that makes a game playable, and `draftFromPublished`
 * dropped it when a live game was reopened for editing. Both are pinned in
 * `publish.test.ts` and `drafts.test.ts`.
 *
 * What makes artwork bugs quiet, and what these tests are aimed at: **every
 * layer below this one is designed to tolerate a bad URL.** The loader
 * refuses anything that is not http(s) and draws a placeholder; the publish
 * gate ignores artwork entirely. That tolerance is correct — a missing
 * picture must never hide a symbol a player is being paid on — but it means
 * a `javascript:` URL, a typo'd scheme, or an emptied field saves cleanly,
 * publishes cleanly, and renders as a symbol that merely looks unstyled.
 * This form is the only place in the system where that is catchable.
 *
 * Deliberately not asserted: exact wording, colours, spacing. A test
 * restating a sentence makes copy edits fail the suite, which teaches people
 * to ignore failures. What is pinned is that a warning exists, that every
 * symbol gets a field, and that clearing one removes the key rather than
 * storing an empty string.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GameAssets, SymbolRule } from "@slots-engine/shared-types";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { AssetsEditor, applyAssetEdit, assetUrlWarning } from "./AssetsEditor.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const symbol = (name: string): SymbolRule => ({
  symbol: name,
  allowedReels: [0, 1, 2],
  role: "regular",
});

const SYMBOLS = [symbol("cherry"), symbol("seven")];

describe("applyAssetEdit", () => {
  it("sets a symbol's URL on a game that had no artwork at all", () => {
    // The first-artwork case. Every game in this repo ships `assets`
    // undefined, so this is the path a designer actually starts from and
    // the one a naive spread of `assets.symbolImageUrls` would throw on.
    const next = applyAssetEdit(undefined, { kind: "symbol", symbol: "seven", url: "https://cdn.example.com/7.png" });

    assert.deepEqual(next, { symbolImageUrls: { seven: "https://cdn.example.com/7.png" } });
  });

  it("leaves other symbols' artwork alone when one is edited", () => {
    const before: GameAssets = { symbolImageUrls: { cherry: "https://cdn.example.com/c.png" } };

    const next = applyAssetEdit(before, { kind: "symbol", symbol: "seven", url: "https://cdn.example.com/7.png" });

    assert.deepEqual(next?.symbolImageUrls, {
      cherry: "https://cdn.example.com/c.png",
      seven: "https://cdn.example.com/7.png",
    });
  });

  it("does not mutate the assets it was given", () => {
    // React state, so a mutation would change the object the previous render
    // still holds — the class of bug where a screen shows the right value
    // and re-renders to the wrong one.
    const before: GameAssets = { symbolImageUrls: { cherry: "https://cdn.example.com/c.png" } };

    applyAssetEdit(before, { kind: "symbol", symbol: "seven", url: "https://cdn.example.com/7.png" });

    assert.deepEqual(before, { symbolImageUrls: { cherry: "https://cdn.example.com/c.png" } });
  });

  it("removes the key when a symbol's field is emptied, rather than storing an empty string", () => {
    /*
     * The distinction the whole feature rests on. Consumers decide "has
     * artwork" by the key's presence: the public projection omits an absent
     * field, and the load report separates "no artwork configured" from
     * "artwork that failed to load". An empty string is a *present* value
     * that resolves to nothing — a symbol claiming artwork it does not
     * have, which on screen is indistinguishable from a dead asset host.
     */
    const before: GameAssets = { symbolImageUrls: { cherry: "https://c.png", seven: "https://7.png" } };

    const next = applyAssetEdit(before, { kind: "symbol", symbol: "seven", url: "" });

    assert.deepEqual(next?.symbolImageUrls, { cherry: "https://c.png" });
  });

  it("drops the whole map once the last symbol is cleared", () => {
    const before: GameAssets = { symbolImageUrls: { seven: "https://7.png" } };

    const next = applyAssetEdit(before, { kind: "symbol", symbol: "seven", url: "" });

    assert.equal(next, undefined, "clearing the last artwork must leave no trace, not an empty table");
  });

  it("returns undefined rather than an empty object when nothing is left", () => {
    // Matched to the publish path, which carries `assets` only when defined.
    // An empty object would publish a game that HAS artwork, none of which
    // loads — which is the one state the load report exists to distinguish.
    const next = applyAssetEdit({ backgroundUrl: "https://bg.png" }, { kind: "background", url: "" });

    assert.equal(next, undefined);
  });

  it("keeps the background when a symbol is cleared, and the reverse", () => {
    // The two live under one key, so a careless rebuild drops the sibling.
    const before: GameAssets = { symbolImageUrls: { seven: "https://7.png" }, backgroundUrl: "https://bg.png" };

    const clearedSymbol = applyAssetEdit(before, { kind: "symbol", symbol: "seven", url: "" });
    const clearedBackground = applyAssetEdit(before, { kind: "background", url: "" });

    assert.deepEqual(clearedSymbol, { backgroundUrl: "https://bg.png" });
    assert.deepEqual(clearedBackground, { symbolImageUrls: { seven: "https://7.png" } });
  });

  it("trims a pasted URL, since a trailing space makes it unloadable", () => {
    // Pasting from a chat or a spreadsheet routinely brings whitespace, and
    // `new URL(" https://x")` is fine while the loader's own check is not
    // the thing that would report it.
    const next = applyAssetEdit(undefined, { kind: "background", url: "  https://cdn.example.com/bg.png  " });

    assert.equal(next?.backgroundUrl, "https://cdn.example.com/bg.png");
  });

  it("treats a whitespace-only field as empty rather than as a URL", () => {
    const next = applyAssetEdit({ backgroundUrl: "https://bg.png" }, { kind: "background", url: "   " });

    assert.equal(next, undefined);
  });
});

describe("assetUrlWarning", () => {
  it("says nothing about an empty field, which is the ordinary case", () => {
    // Every game here ships no artwork. Warning on absence would make the
    // form noisy by the second day, and a warning people scroll past is
    // worse than none.
    assert.equal(assetUrlWarning(""), null);
  });

  it("accepts an https URL", () => {
    assert.equal(assetUrlWarning("https://cdn.example.com/seven.png"), null);
  });

  it("accepts a relative path, which is where a self-hosted asset lives", () => {
    assert.equal(assetUrlWarning("/assets/seven.png"), null);
  });

  it("warns about a javascript: URL", () => {
    // A game definition is data a designer edits, and this value reaches the
    // player client's loader. The loader refuses it — so the game is not
    // unsafe — but it refuses it *silently*, and this is where that is
    // visible.
    assert.ok(assetUrlWarning("javascript:alert(1)"));
  });

  it("warns about a data: URL, which the loader also refuses", () => {
    assert.ok(assetUrlWarning("data:image/png;base64,iVBORw0KGgo="));
  });

  it("accepts a stray string, because relative paths are deliberately allowed", () => {
    /*
     * Written expecting the opposite, and the measurement is worth keeping.
     * `new URL("h ttps://broken example", "http://localhost/")` does not
     * throw — it resolves as a *relative path* and comes back `http:`. So
     * the check cannot report "that is not a URL": allowing relative paths
     * (which is what lets a self-hosted asset be `/assets/seven.png`) means
     * accepting nearly any junk string as a same-origin path.
     *
     * That is the honest boundary of what this warning establishes. It
     * catches the scheme that would be *refused* — `javascript:`, `data:` —
     * and it cannot catch a typo that happens to be a legal path. The
     * backstop for the second case is the loader's own report, which names
     * every symbol whose artwork failed to arrive.
     */
    assert.equal(assetUrlWarning("h ttps://broken example"), null);
  });

  it("says what the player will see, not merely that the value is wrong", () => {
    // The second half is the load-bearing one. "Invalid URL" suggests
    // something will refuse it; nothing will. The game publishes and the
    // symbol renders as a placeholder.
    const message = assetUrlWarning("javascript:alert(1)");
    assert.ok(message);
    assert.match(message, /placeholder/i);
  });
});

describe("AssetsEditor", () => {
  it("renders a field for every symbol the game has, not only those with artwork", () => {
    /*
     * F24 in miniature, and the reason the symbol list comes from
     * `draft.symbols` rather than from the artwork map. Deriving it from
     * `symbolImageUrls` would show only symbols that already had artwork —
     * leaving a designer no way to add the first one, on a screen that
     * looked complete.
     */
    renderComponent(<AssetsEditor symbols={SYMBOLS} assets={undefined} onChange={() => {}} />);

    assert.ok(screen.getByText("cherry"));
    assert.ok(screen.getByText("seven"));
  });

  it("shows the URL already stored for a symbol", () => {
    renderComponent(
      <AssetsEditor
        symbols={SYMBOLS}
        assets={{ symbolImageUrls: { seven: "https://cdn.example.com/7.png" } }}
        onChange={() => {}}
      />,
    );

    assert.ok(
      screen.getByDisplayValue("https://cdn.example.com/7.png"),
      "a stored URL must be shown, or a designer cannot tell artwork is already set",
    );
  });

  it("reports an edited symbol URL to its parent", () => {
    const seen: Array<GameAssets | undefined> = [];
    renderComponent(<AssetsEditor symbols={SYMBOLS} assets={undefined} onChange={(a) => seen.push(a)} />);

    fireEvent.change(screen.getByLabelText("seven"), { target: { value: "https://cdn.example.com/7.png" } });

    assert.deepEqual(seen.at(-1), { symbolImageUrls: { seven: "https://cdn.example.com/7.png" } });
  });

  it("warns in place about a URL the player client will refuse", () => {
    renderComponent(
      <AssetsEditor symbols={SYMBOLS} assets={{ symbolImageUrls: { seven: "javascript:alert(1)" } }} onChange={() => {}} />,
    );

    assert.ok(screen.getByText(/placeholder/i), "a refused URL produced no warning");
  });

  it("does not warn about a URL that will load", () => {
    renderComponent(
      <AssetsEditor
        symbols={SYMBOLS}
        assets={{ symbolImageUrls: { seven: "https://cdn.example.com/7.png" } }}
        onChange={() => {}}
      />,
    );

    assert.equal(screen.queryByText(/placeholder/i), null);
  });

  it("clears a symbol's artwork when its field is emptied", async () => {
    const seen: Array<GameAssets | undefined> = [];
    renderComponent(
      <AssetsEditor
        symbols={SYMBOLS}
        assets={{ symbolImageUrls: { seven: "https://cdn.example.com/7.png" } }}
        onChange={(a) => seen.push(a)}
      />,
    );

    await interact(() => fireEvent.change(screen.getByLabelText("seven"), { target: { value: "" } }));

    assert.equal(seen.at(-1), undefined, "an emptied field must remove the artwork, not store an empty string");
  });

  it("edits the background independently of the symbols", () => {
    const seen: Array<GameAssets | undefined> = [];
    renderComponent(
      <AssetsEditor
        symbols={SYMBOLS}
        assets={{ symbolImageUrls: { seven: "https://7.png" } }}
        onChange={(a) => seen.push(a)}
      />,
    );

    /*
     * Matched as a prefix rather than as "Background", which is measured
     * rather than guessed: `Field` renders its hint *inside* the `<label>`,
     * so the input's accessible name is the label and the hint run
     * together — "BackgroundDrawn behind the reels…". Every field carrying
     * a hint behaves this way, so a screen reader announces the whole
     * sentence as the field's name. Noted rather than fixed here: the
     * change belongs in the shared primitive and would touch every screen
     * in the backoffice.
     */
    fireEvent.change(screen.getByLabelText(/^Background/), { target: { value: "https://bg.png" } });

    assert.deepEqual(seen.at(-1), {
      symbolImageUrls: { seven: "https://7.png" },
      backgroundUrl: "https://bg.png",
    });
  });

  it("says so when the game has no symbols yet, rather than rendering an empty panel", () => {
    // An empty area reads as "this game needs no artwork", which is a
    // different and false statement — the same reasoning that keeps the raw
    // JSON editor for a bonus module publishing no schema.
    renderComponent(<AssetsEditor symbols={[]} assets={undefined} onChange={() => {}} />);

    assert.ok(screen.getByText(/no symbols yet/i));
  });
});
