/**
 * A game's music, and the one thing about audio that is genuinely
 * decidable: **when each track should be playing.**
 *
 * The playing itself is four lines of `HTMLAudioElement` and is not
 * interesting. What is interesting, and what this file separates out so it
 * can be tested, is the mapping from phase to intent — a spin bed that
 * keeps looping after the reels stop is as wrong as one that never starts,
 * and neither raises an error anywhere.
 *
 * **Plain `<audio>` elements rather than the Web Audio API**, following the
 * reference. There is no mixing graph and no layered SFX to justify the
 * complexity: two independently controlled elements is the whole
 * requirement, and Web Audio would add a node graph nobody needs.
 *
 * ## Autoplay policy, which is the part that surprises people
 *
 * A browser refuses `play()` until the user has interacted with the page.
 * The rejection is a `DOMException` from a promise, not a thrown error, so
 * it is silent unless caught — and it is *expected* rather than a fault,
 * because the first `play()` genuinely does happen before any gesture. The
 * design consequence is that priming must be safe to call repeatedly from
 * every gesture handler, so the first real click succeeds where page load
 * could not.
 */

import { isLoadableAssetUrl } from "@slots-engine/shared-types";
import type { GameState } from "../state/gameState.js";

/** Quieter than the spin bed: it is ambience, not the thing a player's
 * attention is on. */
const BACKGROUND_VOLUME = 0.35;
const SPIN_VOLUME = 0.6;

export interface AudioIntent {
  /** The ambient loop should be running. True for the whole session once
   * unlocked — it is not stopped by spins, only by muting. */
  background: boolean;
  /** The spin bed should be running. */
  spin: boolean;
}

/**
 * What should be audible in a given phase.
 *
 * Pure, so the rule is testable without a sound card, an element, or a
 * browser that will refuse to play anything anyway.
 *
 * **`revealing` counts as spinning and that is the whole subtlety.** The
 * result is already known by then, but the reels are still moving and the
 * player is still watching a spin — cutting the bed at `spinning →
 * revealing` would stop the sound partway through the motion it exists to
 * accompany.
 *
 * A terminal phase silences everything. A player who has been disconnected
 * or whose session is spent should not be left with music playing over a
 * dead client.
 */
export function audioIntentFor(state: GameState): AudioIntent {
  switch (state.phase) {
    case "spinning":
    case "revealing":
      return { background: true, spin: true };
    case "idle":
    case "bonus":
      return { background: true, spin: false };
    case "offline":
    case "unrecoverable":
      return { background: false, spin: false };
  }
}

/** Just enough of `HTMLAudioElement` to drive, so tests need no DOM. */
export interface AudioTrack {
  play: () => Promise<void>;
  pause: () => void;
  loop: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  readonly paused: boolean;
}

export interface GameAudioOptions {
  musicUrl?: string;
  spinSoundUrl?: string;
  /** Injected so a test can supply a stand-in. Defaults to a real `Audio`. */
  createTrack?: (url: string) => AudioTrack;
}

export class GameAudio {
  private readonly background: AudioTrack | null;
  private readonly spin: AudioTrack | null;
  private muted = false;
  /** What the last phase asked for, so `setMuted` can restore exactly that
   * rather than guessing that everything should resume. */
  private intent: AudioIntent = { background: false, spin: false };

  constructor(options: GameAudioOptions = {}) {
    const create = options.createTrack ?? ((url: string) => new Audio(url) as unknown as AudioTrack);

    // Filtered through the same rule artwork uses, and for the same reason:
    // these URLs come from a game definition a designer edits, so a hostile
    // or careless value would otherwise reach the browser's loader
    // directly. A refused URL means silence, which is what a game with no
    // music already sounds like.
    this.background = isLoadableAssetUrl(options.musicUrl) ? create(options.musicUrl) : null;
    this.spin = isLoadableAssetUrl(options.spinSoundUrl) ? create(options.spinSoundUrl) : null;

    if (this.background) {
      this.background.loop = true;
      this.background.volume = BACKGROUND_VOLUME;
    }
    if (this.spin) {
      // Looped rather than played once: a spin's length varies with the
      // reveal, so a fixed-length clip would end mid-spin or run past it.
      this.spin.loop = true;
      this.spin.volume = SPIN_VOLUME;
    }
  }

  /** Whether this game has any audio at all. */
  get hasAudio(): boolean {
    return this.background !== null || this.spin !== null;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Call from a real gesture handler — a spin click, the mute button.
   *
   * A no-op once the background is already playing, so it is safe on every
   * click rather than requiring an "have we unlocked audio yet" flag at each
   * call site.
   */
  prime(): void {
    if (!this.background || this.muted || !this.intent.background) return;
    if (!this.background.paused) return;
    // A pre-gesture rejection is expected rather than a fault: the next real
    // gesture tries again and succeeds.
    void this.background.play().catch(() => {});
  }

  apply(state: GameState): void {
    this.intent = audioIntentFor(state);
    this.sync();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.background) this.background.muted = muted;
    if (this.spin) this.spin.muted = muted;
    this.sync();
  }

  /** Stops everything. A client being torn down must not leave a loop
   * running in a tab the player thinks they have left. */
  destroy(): void {
    this.background?.pause();
    this.spin?.pause();
  }

  private sync(): void {
    // Muting pauses rather than merely setting `.muted`, so a muted session
    // is not silently downloading and decoding audio nobody can hear.
    const wantBackground = this.intent.background && !this.muted;
    const wantSpin = this.intent.spin && !this.muted;

    if (this.background) {
      if (wantBackground && this.background.paused) void this.background.play().catch(() => {});
      else if (!wantBackground && !this.background.paused) this.background.pause();
    }

    if (this.spin) {
      if (wantSpin && this.spin.paused) {
        // Restarted from the top each spin: resuming a loop mid-phrase
        // makes consecutive spins sound arbitrarily different from one
        // another.
        this.spin.currentTime = 0;
        void this.spin.play().catch(() => {});
      } else if (!wantSpin && !this.spin.paused) {
        this.spin.pause();
      }
    }
  }
}
