/**
 * Deciding which artwork a symbol gets, and refusing the URLs that should
 * not be fetched.
 *
 * Split from the loader so the *decisions* are testable — `Assets.load`
 * needs a live WebGL context, which `jsdom` does not provide, but "should
 * this URL be fetched at all" and "what do we draw when it fails" are
 * ordinary functions.
 *
 * The governing rule, inherited from the reference and worth restating:
 * **a missing picture must never hide a symbol.** Artwork here is optional
 * at every level — a game with none, a symbol absent from the map, a URL
 * that 404s — and each of those falls back to a generated placeholder. A
 * blank cell on a reel a player is being paid on is a far worse failure than
 * an ugly one, because the player cannot tell what they won.
 */

/**
 * Which URLs may be loaded.
 *
 * **Re-exported rather than defined here, and that is the point.** This rule
 * used to live in this file, which meant the backoffice had no way to apply
 * it — so the editor could store a URL this loader would silently refuse,
 * and the designer would see a saved field and a blank symbol with nothing
 * reporting a problem. It now lives beside `GameAssets` in `shared-types`,
 * where the writer and the reader of the field share one definition. The
 * re-export is kept so this module still reads as the place asset decisions
 * are made.
 */
export { isLoadableAssetUrl } from "@slots-engine/shared-types";
import { isLoadableAssetUrl } from "@slots-engine/shared-types";

/**
 * The URL to load for one symbol, or `null` to draw a placeholder.
 *
 * `null` rather than a thrown error, because "no artwork" is the ordinary
 * case for every game in this repo today — the fixtures ship no assets at
 * all — and an exception would make the common path the error path.
 */
export function symbolImageUrl(
  assets: { symbolImageUrls?: Record<string, string> } | undefined,
  symbol: string,
  pageOrigin?: string,
): string | null {
  const url = assets?.symbolImageUrls?.[symbol];
  return isLoadableAssetUrl(url, pageOrigin) ? url : null;
}

/** Same rule for the background, which is a single optional URL. */
export function backgroundImageUrl(
  assets: { backgroundUrl?: string } | undefined,
  pageOrigin?: string,
): string | null {
  const url = assets?.backgroundUrl;
  return isLoadableAssetUrl(url, pageOrigin) ? url : null;
}

/**
 * What a load attempt produced, per symbol.
 *
 * Reported rather than swallowed so the renderer can log which symbols fell
 * back. A game silently rendering placeholders for every symbol — because an
 * asset host is down — looks like a styling choice rather than an outage,
 * and that is precisely the kind of thing nobody notices for a week.
 */
export interface AssetLoadReport {
  requested: number;
  loaded: number;
  /** Symbols that asked for artwork and did not get it. */
  failed: string[];
  /** Symbols with no artwork configured. Not a failure — most games. */
  unconfigured: string[];
}

export function summariseLoad(
  symbols: string[],
  configured: (symbol: string) => boolean,
  succeeded: (symbol: string) => boolean,
): AssetLoadReport {
  const report: AssetLoadReport = { requested: 0, loaded: 0, failed: [], unconfigured: [] };
  for (const symbol of symbols) {
    if (!configured(symbol)) {
      report.unconfigured.push(symbol);
      continue;
    }
    report.requested += 1;
    if (succeeded(symbol)) report.loaded += 1;
    else report.failed.push(symbol);
  }
  return report;
}

/**
 * Whether a load outcome is worth warning about.
 *
 * A game with no artwork is not a problem — it is every game in this repo
 * today. A game that *asked* for artwork and got none is an outage, and the
 * distinction is the only thing that makes a warning worth printing.
 */
export function shouldWarnAboutAssets(report: AssetLoadReport): boolean {
  return report.failed.length > 0;
}
