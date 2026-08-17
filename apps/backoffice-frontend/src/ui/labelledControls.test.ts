/**
 * Every form control in the backoffice carries its own accessible name.
 *
 * **A source-level check rather than a component test, and that is a
 * deliberate trade worth explaining.** The usual objection applies — this
 * asserts on text, so it cannot see whether a control is actually reachable
 * or correctly wired. What it can do is cover *every screen at once*,
 * including the six that have no tests of their own (`SettingsEditor`,
 * `SymbolsEditor`, `UsersScreen`, `GameListScreen`, `LoginScreen`,
 * `PaylinesEditor`). Writing component suites for all of them to pin one
 * property would cost far more and guard less.
 *
 * ## Why the property needs guarding at all
 *
 * This is F28's other half. `Field` names a *group*; a group name is
 * announced on entering the group, not on focusing each control inside it.
 * So a row holding several inputs — "Grid" is a reels box and a rows box,
 * "Bet options" is one per stake — leaves every control after the first
 * effectively anonymous, and the failure is **completely invisible on
 * screen**. The page looks right, the labels are all there in the markup,
 * and a screen reader announces "edit text, blank" twice.
 *
 * The wider sweep found 18 unlabelled controls across seven files, not the
 * two rows the original TODO entry predicted — including a password reset
 * whose only description was a placeholder that disappears the moment the
 * user types.
 *
 * ## What this cannot establish
 *
 * That the names are *good*. "Bet option 3" is checkable; whether it is
 * more useful than "Bet option 500" is a judgement, and the reasoning for
 * each choice lives beside the control it names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Components that render a raw form control and therefore need naming. */
const CONTROLS = ["TextInput", "NumberInput", "Select"] as const;

const SRC = new URL("../", import.meta.url).pathname;

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx") && !entry.includes(".test.")) found.push(full);
  }
  return found;
}

/**
 * Every `<Control … />` element in a file, with its source line.
 *
 * Matched with a regex rather than parsed, which is the honest limitation:
 * it works because these elements are written plainly here and never
 * contain a nested element before their props close. A parser would be
 * more correct and much heavier for a check whose whole value is being
 * cheap enough to run on every file.
 */
function controlElements(source: string): Array<{ control: string; line: number; text: string }> {
  const found: Array<{ control: string; line: number; text: string }> = [];
  const pattern = new RegExp(`<(${CONTROLS.join("|")})(<[^>]*>)?\\s([^<]*?)/?>`, "gs");
  for (const match of source.matchAll(pattern)) {
    found.push({
      control: match[1],
      line: source.slice(0, match.index).split("\n").length,
      text: match[0],
    });
  }
  return found;
}

describe("every form control names itself", () => {
  it("finds the controls to check, so a passing run is not an empty one", () => {
    // Guards the guard. A regex that silently stopped matching would make
    // this whole file pass while checking nothing — the failure mode of
    // every source-level test.
    const total = tsxFiles(SRC).reduce((n, f) => n + controlElements(readFileSync(f, "utf8")).length, 0);

    assert.ok(total > 20, `expected to find plenty of controls, found ${total}`);
  });

  it("gives every control an accessible name of its own", () => {
    /*
     * F28's other half. `Field` names the group; a group name is not
     * announced when focus lands on a control inside it. So without this,
     * the second and later inputs in a row are anonymous — and nothing on
     * screen looks wrong, which is why the original defect shipped.
     */
    const unlabelled: string[] = [];

    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const element of controlElements(source)) {
        if (!element.text.includes("label=")) {
          unlabelled.push(`${file.replace(SRC, "")}:${element.line} <${element.control}>`);
        }
      }
    }

    assert.deepEqual(
      unlabelled,
      [],
      `these controls have no accessible name of their own:\n  ${unlabelled.join("\n  ")}\n` +
        `Pass a \`label\` prop. \`Field\` names the row, which a screen reader ` +
        `announces on entering the group — not on focusing each control in it.`,
    );
  });
});
