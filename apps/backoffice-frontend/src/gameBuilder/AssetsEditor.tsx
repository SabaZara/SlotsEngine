import { isLoadableAssetUrl, type GameAssets, type SymbolRule } from "@slots-engine/shared-types";
import { Field, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Where a designer sets a game's artwork.
 *
 * **This screen is the whole feature, not the last mile of it.** Artwork was
 * already served by the public projection and already rendered by the player
 * client — and was still unreachable, because the only way to set it was to
 * edit the stored document by hand. That is F24's shape exactly: a feature
 * complete on its own path and absent from the one a user travels. The two
 * silent drops found while building this (the publish allowlist and
 * `draftFromPublished`) were both on that untravelled path, which is why
 * neither had ever failed anything.
 *
 * **A URL field rather than an upload.** The reference repo signs 24-hour
 * URLs out of object storage, and its own `repair-corrupted-asset-urls.ts`
 * records what that cost: `GET` returned signed URLs, `updateDraft` blindly
 * `$set` the client's `assets` object back, and every "Save draft" therefore
 * overwrote the raw storage key with a signed URL — compounding on each save,
 * since the next GET re-signed the already-corrupted value. This repo has the
 * same blind spread in its `PUT /v1/games/:gameId`. It is safe here for one
 * reason worth stating plainly, because a future upload feature would remove
 * it: **what is read is exactly what is written.** No signing step sits
 * between them, so a round-trip cannot corrupt a value. Introducing storage
 * means introducing that asymmetry, and the reference is the evidence for
 * what to do about it.
 */

/**
 * Applies one URL edit, removing the key when the field is emptied.
 *
 * Exported and pure so the removal rule is testable without a DOM, and it is
 * the rule most likely to be got wrong. **An emptied field must delete the
 * key, not store `""`.** Every consumer decides "has artwork" by the key's
 * presence — `symbolImageUrl` falls back on a non-loadable value, and the
 * public projection omits an absent field entirely — so an empty string is a
 * symbol that claims artwork and resolves to nothing. That is indistinguishable
 * on screen from a dead asset host, which is the one distinction the load
 * report exists to make.
 *
 * Returns `undefined` for a wholly empty result rather than `{}`, for the same
 * reason one level up: the publish path carries `assets` only when defined, so
 * an empty object would publish a game that *has* artwork, none of which
 * loads.
 */
export function applyAssetEdit(
  assets: GameAssets | undefined,
  edit:
    | { kind: "symbol"; symbol: string; url: string }
    | { kind: "background"; url: string }
    | { kind: "music"; url: string }
    | { kind: "spinSound"; url: string },
): GameAssets | undefined {
  const next: GameAssets = {
    ...(assets?.symbolImageUrls !== undefined ? { symbolImageUrls: { ...assets.symbolImageUrls } } : {}),
    ...(assets?.backgroundUrl !== undefined ? { backgroundUrl: assets.backgroundUrl } : {}),
    ...(assets?.musicUrl !== undefined ? { musicUrl: assets.musicUrl } : {}),
    ...(assets?.spinSoundUrl !== undefined ? { spinSoundUrl: assets.spinSoundUrl } : {}),
  };

  const trimmed = edit.url.trim();

  if (edit.kind === "background") {
    if (trimmed === "") delete next.backgroundUrl;
    else next.backgroundUrl = trimmed;
  } else if (edit.kind === "music") {
    if (trimmed === "") delete next.musicUrl;
    else next.musicUrl = trimmed;
  } else if (edit.kind === "spinSound") {
    if (trimmed === "") delete next.spinSoundUrl;
    else next.spinSoundUrl = trimmed;
  } else {
    const symbols = { ...next.symbolImageUrls };
    if (trimmed === "") delete symbols[edit.symbol];
    else symbols[edit.symbol] = trimmed;
    // An emptied map is dropped too — the last symbol cleared should leave no
    // trace, not an empty table that reads as "artwork configured".
    if (Object.keys(symbols).length === 0) delete next.symbolImageUrls;
    else next.symbolImageUrls = symbols;
  }

  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Why a URL will not be loaded, or `null` if it is fine.
 *
 * The value of saying this **here** is that nothing downstream ever will. The
 * player client refuses the URL and quietly draws a placeholder, by design —
 * a missing picture must never hide a symbol — and the publish gate ignores
 * artwork entirely. So a `javascript:` URL, or a typo'd scheme, saves
 * cleanly, publishes cleanly, and renders as a symbol that simply looks
 * unstyled. This field is the only place in the system where that is
 * catchable, which is the same argument `BonusParamsForm` makes about
 * silently-substituted defaults.
 */
export function assetUrlWarning(url: string, kind: "artwork" | "sound" = "artwork"): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  if (isLoadableAssetUrl(trimmed)) return null;
  // The consequence differs by kind, and saying the wrong one is worse than
  // saying none: a designer told to expect a "placeholder" for a refused
  // music URL will go looking for a visual problem.
  return kind === "sound"
    ? "not a loadable URL — this will be silent"
    : "not a loadable URL — the player will see a placeholder instead of this artwork";
}

function UrlField({
  label,
  hint,
  value,
  onChange,
  kind = "artwork",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (url: string) => void;
  kind?: "artwork" | "sound";
}) {
  const warning = assetUrlWarning(value, kind);
  return (
    <Field label={label} hint={hint}>
      {/* Named on the input itself, not only via the surrounding `Field`.
          `Field` labels a group, and a group name is not what a screen
          reader announces when focus lands on the box. */}
      <TextInput
        mono
        label={label}
        value={value}
        placeholder="https://…  (leave empty for none)"
        onChange={onChange}
      />
      {/* `warn`, not `bad`, and matching `BonusParamsForm` deliberately: both
          say the same kind of thing — this saves and publishes fine, and then
          quietly does something other than what you asked. */}
      {warning && <div style={{ fontSize: 11, color: t.warn, marginTop: 4 }}>{warning}</div>}
    </Field>
  );
}

export function AssetsEditor({
  symbols,
  assets,
  onChange,
}: {
  /** Taken from the draft's own symbol rules rather than from the artwork
   * map, so the list is every symbol the game actually has. Deriving it from
   * `symbolImageUrls` instead would only ever show symbols that already had
   * artwork — leaving a designer no way to add the first one, which is F24's
   * failure in miniature. */
  symbols: SymbolRule[];
  assets: GameAssets | undefined;
  onChange: (assets: GameAssets | undefined) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: t.faint, marginBottom: 10 }}>
        Presentation only — artwork never reaches the evaluator, the RTP simulation or the publish gate, so it can be
        changed on a live game without re-running any of them. Any symbol left empty draws its generated glyph instead.
      </div>

      <UrlField
        label="Background"
        hint="Drawn behind the reels. Empty means the built-in gradient."
        value={assets?.backgroundUrl ?? ""}
        onChange={(url) => onChange(applyAssetEdit(assets, { kind: "background", url }))}
      />

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, margin: "16px 0 6px" }}>
        Sound
      </div>
      <div style={{ fontSize: 11, color: t.faint, marginBottom: 10 }}>
        Optional, and off by default. A browser will not play anything until the player has interacted with the page,
        so the first spin is what starts the music — that is the browser's rule, not a bug here.
      </div>
      <UrlField
        kind="sound"
        label="Music"
        hint="Looped quietly for the whole session."
        value={assets?.musicUrl ?? ""}
        onChange={(url) => onChange(applyAssetEdit(assets, { kind: "music", url }))}
      />
      <UrlField
        kind="sound"
        label="Spin sound"
        hint="Looped only while the reels are moving, layered over the music."
        value={assets?.spinSoundUrl ?? ""}
        onChange={(url) => onChange(applyAssetEdit(assets, { kind: "spinSound", url }))}
      />

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, margin: "16px 0 6px" }}>
        Symbols
      </div>
      {symbols.map((symbol) => (
        <UrlField
          key={symbol.symbol}
          label={symbol.symbol}
          value={assets?.symbolImageUrls?.[symbol.symbol] ?? ""}
          onChange={(url) => onChange(applyAssetEdit(assets, { kind: "symbol", symbol: symbol.symbol, url }))}
        />
      ))}
      {symbols.length === 0 && (
        <div style={{ fontSize: 12, color: t.faint }}>This game has no symbols yet — add some on the Symbols tab.</div>
      )}
    </div>
  );
}
