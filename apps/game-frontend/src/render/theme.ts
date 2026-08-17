/**
 * Applying a game's colour identity.
 *
 * The whole client already draws from seven CSS custom properties, so a
 * theme is not a new rendering path — it is seven writes. That is why this
 * file is small and why the theme type is colours only: the layout, radii
 * and spacing a designer might otherwise want to touch already live in a
 * stylesheet, and duplicating them into game data would create two sources
 * for one fact.
 *
 * **The mapping is here rather than in `main.ts` so it can be tested
 * without a page.** Which theme key drives which CSS variable is exactly
 * the kind of thing that is wrong by one row and looks plausible — a game
 * whose "panel" colour landed on `--border` renders, and renders wrong.
 */

import { isValidThemeColour, THEME_COLOUR_KEYS, type GameTheme, type ThemeColourKey } from "@slots-engine/shared-types";

/**
 * Theme key → CSS custom property.
 *
 * Named explicitly rather than derived as `--${key}`, even though six of
 * the seven would work that way. `background` maps to `--bg`, and a
 * convention with one exception is a convention nobody can rely on — the
 * next key added would silently pick the wrong form.
 */
const CSS_VARIABLE: Record<ThemeColourKey, string> = {
  background: "--bg",
  panel: "--panel",
  border: "--border",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  win: "--win",
};

/**
 * The CSS variables a theme would set, as a plain object.
 *
 * Exported separately from applying them so the mapping is testable without
 * a DOM. Invalid colours are dropped rather than written: the value reaches
 * a stylesheet, and a stylesheet is not a place to find out a value was
 * malformed.
 */
export function themeCssVariables(theme: GameTheme | undefined): Record<string, string> {
  if (!theme) return {};

  const variables: Record<string, string> = {};
  for (const key of THEME_COLOUR_KEYS) {
    const value = theme[key];
    // Re-checked here even though the projection sanitizes on the way out.
    // The two guards are not redundant: this module is also reachable from
    // a cached or hand-edited payload, and the cost of being wrong is CSS
    // injection rather than a bad colour.
    if (isValidThemeColour(value)) variables[CSS_VARIABLE[key]] = value.trim();
  }
  return variables;
}

/**
 * Writes a theme onto an element, usually `<html>`.
 *
 * **Only ever sets; never clears what it did not set.** A game with a
 * partial theme keeps the built-in palette for everything else, which is
 * what makes a theme additive rather than a replacement a designer has to
 * complete before it looks right.
 */
export function applyGameTheme(target: HTMLElement, theme: GameTheme | undefined): void {
  for (const [variable, value] of Object.entries(themeCssVariables(theme))) {
    target.style.setProperty(variable, value);
  }
}
