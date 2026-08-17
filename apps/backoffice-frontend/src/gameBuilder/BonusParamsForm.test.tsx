/**
 * The schema-driven bonus parameter form.
 *
 * **This is F24's follow-up, and the reason it needs tests is F24's own
 * lesson.** That bug made every bonus module selectable and stopped there,
 * leaving their parameters a free-form JSON blob — so a designer could reach
 * `freeSpins` and still had no way to learn which five values it reads.
 *
 * What makes the failure quiet is worth stating, because it is what these
 * tests are aimed at: **every module silently substitutes its own default
 * for anything malformed.** A typo'd key, a number typed as text, a value
 * below a module's minimum — none of them fails validation, none blocks a
 * publish. The game simply plays under numbers nobody chose, and looks
 * entirely successful doing it. The form is the only place that is
 * catchable, so what is asserted here is that it *says so*.
 *
 * Deliberately not asserted: exact wording, colours, or spacing. A test
 * restating a sentence makes copy edits fail the suite, which teaches people
 * to ignore failures. What is pinned is that a warning exists, that a
 * default is shown, and that an empty field clears the key rather than
 * storing zero.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { BonusParamsForm, formatDefault, parseNumberList, violation, type BonusParamSpec } from "./BonusParamsForm.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const spinCount: BonusParamSpec = {
  key: "spinCount",
  label: "Free spins awarded",
  type: "integer",
  defaultValue: 10,
  min: 1,
  help: "How many free spins the feature starts with.",
};

const rewards: BonusParamSpec = {
  key: "rewardMultipliers",
  label: "Reward multipliers",
  type: "numberList",
  defaultValue: [2, 3, 5],
  min: 0,
  help: "One entry per segment.",
};

describe("parseNumberList", () => {
  it("reads a comma-separated table", () => {
    assert.deepEqual(parseNumberList("2, 3, 5").values, [2, 3, 5]);
  });

  it("reads a space-separated table, since a designer types either", () => {
    assert.deepEqual(parseNumberList("2 3 5").values, [2, 3, 5]);
  });

  it("tolerates ragged separators rather than producing zeros", () => {
    // `Number("")` is 0, so a trailing comma would otherwise append a
    // phantom zero-multiplier segment — a real change to the odds.
    assert.deepEqual(parseNumberList("2,  3 , 5,").values, [2, 3, 5]);
  });

  it("reports a non-numeric entry instead of dropping it", () => {
    // Dropping is precisely what the module does, and it is what makes the
    // failure silent: "2, 3, x, 5" becomes a three-segment wheel with
    // different odds, and nothing anywhere complains.
    const { values, invalid } = parseNumberList("2, 3, x, 5");
    assert.deepEqual(values, [2, 3, 5]);
    assert.deepEqual(invalid, ["x"]);
  });

  it("keeps decimals, which a multiplier legitimately can be", () => {
    assert.deepEqual(parseNumberList("0.5, 1.25").values, [0.5, 1.25]);
  });

  it("returns nothing for an empty string rather than one zero", () => {
    assert.deepEqual(parseNumberList("   ").values, []);
  });
});

describe("violation", () => {
  it("accepts a value inside the module's own bounds", () => {
    assert.equal(violation(spinCount, 10), null);
  });

  it("names the minimum and what the module will do instead", () => {
    // The second half matters more than the first. "Below minimum" alone
    // suggests the publish will fail; it will not — the module substitutes
    // its default and the game ships.
    const message = violation(spinCount, 0);
    assert.ok(message, "a value below the minimum must be reported");
    assert.match(message, /minimum/i);
    assert.match(message, /10/, "the message must say which value the module will use instead");
  });

  it("rejects a fraction where the module takes a whole number", () => {
    assert.ok(violation(spinCount, 2.5));
  });

  it("accepts a fraction where the module takes any number", () => {
    const multiplier: BonusParamSpec = { ...spinCount, key: "winMultiplier", type: "number" };
    assert.equal(violation(multiplier, 2.5), null);
  });

  it("reports a value above a maximum", () => {
    const bounded: BonusParamSpec = { ...spinCount, type: "number", max: 1.99, min: 0.01, defaultValue: 0.95 };
    assert.ok(violation(bounded, 3));
  });

  it("reports NaN, which is what an emptied field parses to", () => {
    assert.ok(violation(spinCount, Number.NaN));
  });
});

describe("formatDefault", () => {
  it("renders a list as the designer would type it back in", () => {
    // Round-trips through `parseNumberList`, so the shown default can be
    // copied into the field verbatim.
    assert.equal(formatDefault(rewards), "2, 3, 5");
    assert.deepEqual(parseNumberList(formatDefault(rewards)).values, rewards.defaultValue);
  });

  it("renders a scalar plainly", () => {
    assert.equal(formatDefault(spinCount), "10");
  });
});

describe("BonusParamsForm", () => {
  it("renders a labelled field for every parameter the module declares", () => {
    // The F24 property at the form level: a parameter absent from the form
    // is a parameter a designer cannot set, however correct the module is.
    renderComponent(<BonusParamsForm schema={[spinCount, rewards]} params={{}} onChange={() => {}} />);

    assert.ok(screen.getByText("Free spins awarded"));
    assert.ok(screen.getByText("Reward multipliers"));
  });

  it("shows the module's default for a parameter left unset", () => {
    // A blank field is a choice with a value, not an omission. Without this
    // the designer cannot tell what leaving it blank actually does.
    renderComponent(<BonusParamsForm schema={[spinCount]} params={{}} onChange={() => {}} />);

    assert.match(screen.getByText(/Default:/).textContent ?? "", /10/);
  });

  it("reports a number, not a string, so the module's guard accepts it", () => {
    // `typeof params.spinCount === "number"` is the module's actual check.
    // A string here passes silently and the module uses its default.
    const seen: Array<Record<string, unknown>> = [];
    renderComponent(<BonusParamsForm schema={[spinCount]} params={{}} onChange={(p) => seen.push(p)} />);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });

    assert.deepEqual(seen.at(-1), { spinCount: 25 });
    assert.equal(typeof seen.at(-1)?.spinCount, "number");
  });

  it("warns when a value is outside what the module accepts", async () => {
    // The whole point. Nothing downstream will complain about this — not
    // the draft validator, not the publish gate — so the form is the only
    // place it can be caught.
    renderComponent(<BonusParamsForm schema={[spinCount]} params={{ spinCount: 0 }} onChange={() => {}} />);

    assert.ok(screen.getByText(/minimum/i), "a below-minimum value produced no warning");
  });

  it("does not warn about a valid value", async () => {
    renderComponent(<BonusParamsForm schema={[spinCount]} params={{ spinCount: 10 }} onChange={() => {}} />);

    assert.equal(screen.queryByText(/minimum/i), null);
  });

  it("clears the key when a list field is emptied, rather than storing an empty table", async () => {
    /**
     * The distinction that matters, and it is not cosmetic. The module
     * falls back to its default when the key is **absent**; an empty array
     * is a present value, and `wheel`'s guard treats it as "no valid
     * entries" and also falls back — but `pick` stores it, and a game with
     * an explicitly empty reward table is a different document from one
     * that never set the field. Absence is the honest representation of
     * "use the default".
     */
    const seen: Array<Record<string, unknown>> = [];
    renderComponent(
      <BonusParamsForm schema={[rewards]} params={{ rewardMultipliers: [2, 3] }} onChange={(p) => seen.push(p)} />,
    );

    await interact(() => fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } }));

    assert.deepEqual(seen.at(-1), {}, "an emptied field must remove the key, not store an empty array");
  });

  it("stores a parsed list of numbers from typed text", () => {
    const seen: Array<Record<string, unknown>> = [];
    renderComponent(<BonusParamsForm schema={[rewards]} params={{}} onChange={(p) => seen.push(p)} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "2, 4, 8" } });

    assert.deepEqual(seen.at(-1), { rewardMultipliers: [2, 4, 8] });
  });

  it("says which list entries the module will ignore", () => {
    // Rendered from the stored value, so this covers a draft that already
    // contains junk — restored from an older deployment, or hand-edited.
    renderComponent(
      <BonusParamsForm
        schema={[rewards]}
        params={{ rewardMultipliers: [2, "x", 5] as unknown as number[] }}
        onChange={() => {}}
      />,
    );

    assert.ok(screen.getByText(/Ignored/i), "a non-numeric entry was not reported");
  });

  it("falls back to raw JSON for a module that publishes no schema", () => {
    /**
     * An empty form would read as "this module takes no parameters", which
     * is a different and false statement. A module without a schema is
     * telling the editor it cannot describe itself — the honest response is
     * the blob, labelled as such.
     */
    renderComponent(<BonusParamsForm schema={[]} params={{ custom: 1 }} onChange={() => {}} />);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    assert.equal(input.value, JSON.stringify({ custom: 1 }));
  });

  it("keeps a half-typed JSON edit rather than wiping the field", () => {
    // Parsing on every keystroke means most intermediate states are
    // invalid. Throwing them away makes the field impossible to edit.
    const seen: Array<Record<string, unknown>> = [];
    renderComponent(<BonusParamsForm schema={[]} params={{ custom: 1 }} onChange={(p) => seen.push(p)} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: '{"custom":' } });

    assert.deepEqual(seen, [], "an unparseable intermediate state must not be reported upward");
  });
});
