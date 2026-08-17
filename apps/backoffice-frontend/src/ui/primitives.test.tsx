/**
 * The shared primitives every backoffice screen is built from.
 *
 * These are the first React component tests in this repo, and they exist
 * because `docs/TODO.md` section C's stopping point ("no DOM environment,
 * no component testing library") stopped being the right trade. F24 is the
 * argument: a feature was complete, mutation-verified and confirmed live,
 * and was still unreachable because of a hardcoded array in a component
 * nothing tested. The components are where that class of bug lives.
 *
 * What these tests deliberately do NOT assert: colours, padding, border
 * radius — anything whose only definition is a token. A test restating
 * `t.accent` passes whatever the value is, so it pins nothing and makes the
 * tokens harder to change. What is asserted is **behaviour a user depends
 * on**: that a disabled control cannot be activated, that a value typed
 * reaches the parent, and that a control reports only what it promises to.
 *
 * What they cannot establish: that any screen actually uses these. A
 * primitive can be perfect and unmounted. That is the screens' own tests.
 *
 * **Mutation results: 4 of 5 caught, and the survivor is documented rather
 * than left silent.** Removing `disabled` from the Button element (leaving
 * the dimmed styling, so it still *looks* disabled), defaulting `type` to
 * `submit`, dropping NumberInput's emptiness guard, and rendering only the
 * first Select option are all caught.
 *
 * The survivor is `value={Number.isFinite(value) ? value : ""}` reduced to
 * `value={value}`. It is an **equivalent mutant**, established by probe
 * rather than by argument: a raw `<input type="number">` rendered with
 * `value={NaN}` reports `.value === ""` on its own, because the DOM coerces
 * a non-finite number to the empty string before the guard is consulted.
 * The guard is therefore unobservable through the rendered value, and the
 * test below pins the resulting behaviour rather than the branch. It is
 * still worth keeping in the source: it states the intent for a reader, and
 * it stops a future change to a `text` input (where the coercion does NOT
 * happen) from quietly printing "NaN" into a paytable field.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
// Everything DOM-dependent is reached through this one module, which
// installs the environment before it imports Testing Library. Importing
// Testing Library directly here would capture an undefined `document`.
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { Button, NumberInput, Select, TextInput } from "./primitives.js";

afterEach(() => cleanup());
after(() => uninstallDom());

describe("Button", () => {
  it("calls its handler when clicked", async () => {
    let clicks = 0;
    renderComponent(<Button onClick={() => (clicks += 1)}>Publish</Button>);

    await interact(() => fireEvent.click(screen.getByText("Publish")));

    assert.equal(clicks, 1);
  });

  it("does not call its handler when disabled", async () => {
    let clicks = 0;
    renderComponent(
      <Button disabled onClick={() => (clicks += 1)}>
        Publish
      </Button>,
    );

    await interact(() => fireEvent.click(screen.getByText("Publish")));

    // The visual dimming is not the guarantee — a disabled publish button
    // that still fires is a publish nobody chose.
    assert.equal(clicks, 0);
  });

  it("defaults to type=button, so a button inside a form does not submit it", () => {
    renderComponent(<Button>Add</Button>);

    // The browser default is `submit`. A stray submit inside the login form
    // reloads the page and loses the entered credentials.
    assert.equal(screen.getByText("Add").getAttribute("type"), "button");
  });

  it("can still be an explicit submit button", () => {
    renderComponent(<Button type="submit">Sign in</Button>);

    assert.equal(screen.getByText("Sign in").getAttribute("type"), "submit");
  });
});

describe("TextInput", () => {
  it("reports what the user typed", async () => {
    const seen: string[] = [];
    renderComponent(<TextInput value="" onChange={(v) => seen.push(v)} />);

    await interact(() => fireEvent.change(screen.getByRole("textbox"), { target: { value: "reference-5x3" } }));

    assert.deepEqual(seen, ["reference-5x3"]);
  });

  it("reports an emptied field, rather than swallowing the clear", async () => {
    const seen: string[] = [];
    renderComponent(<TextInput value="abc" onChange={(v) => seen.push(v)} />);

    await interact(() => fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } }));

    assert.deepEqual(seen, [""], "a field that cannot be cleared traps a typo permanently");
  });
});

describe("NumberInput", () => {
  it("reports a number, not the string the DOM gave it", async () => {
    const seen: unknown[] = [];
    renderComponent(<NumberInput value={0} onChange={(v) => seen.push(v)} />);

    await interact(() => fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "12" } }));

    assert.deepEqual(seen, [12]);
    assert.equal(typeof seen[0], "number", "a string reaching a paytable would concatenate rather than add");
  });

  it("stays silent while a field is empty rather than reporting 0", async () => {
    const seen: number[] = [];
    renderComponent(<NumberInput value={5} onChange={(v) => seen.push(v)} />);

    await interact(() => fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } }));

    // The distinction this component exists for. Reporting 0 for an empty
    // field would silently rewrite a bet option or a paytable entry to zero
    // the moment a designer selected the text to retype it.
    assert.deepEqual(seen, [], "an emptied field must not be reported as the number zero");
  });

  it("renders an empty field rather than the text NaN for a non-finite value", () => {
    renderComponent(<NumberInput value={Number.NaN} onChange={() => {}} />);

    assert.equal((screen.getByRole("spinbutton") as HTMLInputElement).value, "");
  });
});

describe("Select", () => {
  it("reports the chosen option", async () => {
    const seen: string[] = [];
    renderComponent(
      <Select
        value="wheel"
        options={[
          { value: "wheel", label: "wheel" },
          { value: "freeSpins", label: "freeSpins" },
        ]}
        onChange={(v) => seen.push(v)}
      />,
    );

    await interact(() => fireEvent.change(screen.getByRole("combobox"), { target: { value: "freeSpins" } }));

    assert.deepEqual(seen, ["freeSpins"]);
  });

  it("renders every option it was given", () => {
    renderComponent(
      <Select
        value="wheel"
        options={[
          { value: "wheel", label: "wheel" },
          { value: "pick", label: "pick" },
          { value: "freeSpins", label: "freeSpins" },
        ]}
        onChange={() => {}}
      />,
    );

    // F24's shape at the component level: an option that is not rendered is
    // a module a designer cannot select, however correct the engine is.
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    assert.deepEqual(labels, ["wheel", "pick", "freeSpins"]);
  });
});
