import {
  THEME_COLOUR_KEYS,
  isValidThemeColour,
  type GameTheme,
  type ThemeColourKey,
} from "@slots-engine/shared-types";
import { Field, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Where a designer sets a game's colours.
 *
 * Built as the artwork editor's sibling, and for the same F24 reason: a
 * `theme` field the client renders and no screen can write is a feature
 * that exists everywhere except where someone would use it.
 *
 * **Colours only, unlike the reference's `VisualTheme`.** Theirs carries
 * radii, spacing, glow alphas, particle density and type roles, because its
 * renderer draws its own chrome and needs a whole design system in game
 * data. This client draws chrome with CSS, where those already live — so
 * putting them here would create two sources for one fact, and the one in
 * the database would win silently.
 */

/** What each colour actually controls, in the player's terms rather than
 * the variable's. A designer picking "muted" needs to know it is the status
 * line, not that it maps to `--muted`. */
const DESCRIPTIONS: Record<ThemeColourKey, string> = {
  background: "The page behind everything.",
  panel: "Panels and raised surfaces — the bonus overlay, the reel frame.",
  border: "Hairlines and outlines.",
  text: "Body text.",
  muted: "Secondary text: the status line, labels.",
  accent: "The interactive colour — spin button, selected bet, focus rings.",
  win: "Reserved for wins. Players learn this colour means money, so it is worth keeping distinct from the accent.",
};

const LABELS: Record<ThemeColourKey, string> = {
  background: "Background",
  panel: "Panel",
  border: "Border",
  text: "Text",
  muted: "Muted text",
  accent: "Accent",
  win: "Win",
};

/**
 * Applies one colour edit, removing the key when the field is emptied.
 *
 * Exported and pure so the removal rule is testable without a DOM — the
 * same rule, and the same reasoning, as `applyAssetEdit`. **An emptied
 * field must delete the key rather than store `""`.** Every consumer treats
 * absence as "use the built-in colour", and an empty string is a present
 * value that fails validation and is then dropped anyway — so it stores a
 * choice that does nothing, which is indistinguishable on screen from the
 * default the designer was trying to change.
 */
export function applyThemeEdit(theme: GameTheme | undefined, key: ThemeColourKey, value: string): GameTheme | undefined {
  const next: GameTheme = { ...theme };
  const trimmed = value.trim();

  if (trimmed === "") delete next[key];
  else next[key] = trimmed;

  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Why a colour will not be applied, or `null` if it is fine.
 *
 * The value of saying this here is that **nothing downstream ever will**.
 * The projection drops an invalid colour on the way out and the client
 * falls back per field, both deliberately — so a typo saves cleanly,
 * publishes cleanly, and renders as the default. The designer sees a field
 * they filled in and a game that ignored it.
 */
export function themeColourWarning(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (isValidThemeColour(trimmed)) return null;
  return "not a hex colour like #4fd1ff — this will be ignored and the built-in colour used instead";
}

export function ThemeEditor({
  theme,
  onChange,
}: {
  theme: GameTheme | undefined;
  onChange: (theme: GameTheme | undefined) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: t.faint, marginBottom: 12 }}>
        Presentation only — colours never reach the evaluator, the RTP simulation or the publish gate, so they can be
        changed on a live game without re-running any of them. Any colour left empty uses the built-in one.
      </div>

      {THEME_COLOUR_KEYS.map((key) => {
        const value = theme?.[key] ?? "";
        const warning = themeColourWarning(value);
        return (
          <Field key={key} label={LABELS[key]} hint={DESCRIPTIONS[key]}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* A native colour input alongside the text field rather than
                  instead of it. The picker cannot express "unset" — it always
                  reports a colour — so clearing a value needs the text field,
                  and a designer pasting a brand hex needs it too. */}
              <input
                type="color"
                aria-label={`${LABELS[key]} colour picker`}
                value={isValidThemeColour(value) ? normaliseForPicker(value) : "#000000"}
                onChange={(e) => onChange(applyThemeEdit(theme, key, e.target.value))}
                style={{ width: 34, height: 30, padding: 0, background: "none", border: "none", cursor: "pointer" }}
              />
              <div style={{ flex: 1 }}>
                <TextInput
                  mono
                  label={LABELS[key]}
                  value={value}
                  placeholder="#4fd1ff  (leave empty for the built-in colour)"
                  onChange={(next) => onChange(applyThemeEdit(theme, key, next))}
                />
              </div>
            </div>
            {warning && <div style={{ fontSize: 11, color: t.warn, marginTop: 4 }}>{warning}</div>}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * A colour the native picker will accept.
 *
 * `<input type="color">` understands `#rrggbb` and nothing else — a
 * three-digit shorthand or an eight-digit value with alpha makes it fall
 * back to black, which would then be reported as the designer's choice on
 * the next change event and silently overwrite a valid colour.
 */
function normaliseForPicker(value: string): string {
  const hex = value.trim();
  if (hex.length === 4) {
    // #abc -> #aabbcc
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  // Eight-digit values carry alpha the picker cannot show; the RGB half is
  // the closest honest approximation.
  if (hex.length === 9) return hex.slice(0, 7);
  return hex;
}
