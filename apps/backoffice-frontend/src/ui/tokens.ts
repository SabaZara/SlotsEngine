/**
 * Design tokens, deliberately matching the player client's palette so the
 * two surfaces read as one product. Kept as a TS object rather than a CSS
 * file because several components compute colours (a validity badge, an RTP
 * reading that shifts from green to amber to red) and duplicating those
 * values across two languages is how they drift apart.
 */
export const t = {
  bg: "#05070f",
  panel: "#0d1220",
  panelRaised: "#141b2d",
  border: "rgba(79, 209, 255, 0.16)",
  borderStrong: "rgba(79, 209, 255, 0.34)",

  text: "#e6edf7",
  muted: "#7c93b8",
  faint: "#4d5f7a",

  accent: "#4fd1ff",
  accentText: "#04121b",
  good: "#5ad48f",
  warn: "#ffd166",
  bad: "#ff5d5d",

  radius: 10,
  radiusSm: 6,
  space: 8,
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/**
 * Colour for a measured RTP against its declared target.
 *
 * The thresholds mirror the API's publish gate exactly (5% tolerance), so
 * the number a designer sees turning red is the same number that will refuse
 * the publish. A UI that warns at a different threshold than the server
 * enforces teaches people to ignore it.
 */
export function rtpColor(measured: number, target: number): string {
  const drift = Math.abs(measured - target);
  if (drift > 0.05) return t.bad;
  if (drift > 0.02) return t.warn;
  return t.good;
}
