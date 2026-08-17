/**
 * A game's music, and specifically *when* each track should be playing.
 *
 * The playing is four lines of `HTMLAudioElement` and is not what breaks.
 * What breaks is the mapping from phase to intent — a spin bed still
 * looping after the reels have stopped is as wrong as one that never
 * starts, and neither raises an error anywhere. A tester with the volume
 * down would not notice either.
 *
 * Driven through a stand-in track rather than a real `<audio>`, so these
 * run with no DOM and no sound card. That is a real limit, stated here
 * rather than implied: these establish that the right calls are made in the
 * right order, and nothing about whether a browser honours them. The
 * autoplay-policy rejection in particular can only be observed in a real
 * browser after a real gesture.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameAudio, audioIntentFor, type AudioTrack } from "./gameAudio.js";
import type { GameState } from "../state/gameState.js";

const idle: GameState = { phase: "idle" };
const spinning: GameState = { phase: "spinning" };
const revealing: GameState = { phase: "revealing", stopRequested: false };
const bonus: GameState = { phase: "bonus" };
const offline: GameState = { phase: "offline" };

/** A track that records what was asked of it. */
function fakeTrack(): AudioTrack & { calls: string[] } {
  let paused = true;
  const calls: string[] = [];
  return {
    calls,
    loop: false,
    muted: false,
    volume: 1,
    currentTime: 0,
    get paused() {
      return paused;
    },
    play: async () => {
      paused = false;
      calls.push("play");
    },
    pause: () => {
      paused = true;
      calls.push("pause");
    },
  };
}

function setup(options: { music?: boolean; spinSound?: boolean } = {}) {
  const tracks: Array<AudioTrack & { calls: string[] }> = [];
  const audio = new GameAudio({
    ...(options.music !== false ? { musicUrl: "https://cdn.example.com/bg.mp3" } : {}),
    ...(options.spinSound !== false ? { spinSoundUrl: "https://cdn.example.com/spin.mp3" } : {}),
    createTrack: () => {
      const track = fakeTrack();
      tracks.push(track);
      return track;
    },
  });
  return { audio, background: tracks[0], spin: tracks[1] };
}

describe("audioIntentFor", () => {
  it("keeps the ambient loop running through an ordinary round", () => {
    // It is a bed, not a cue: stopping it between spins would make the game
    // pulse in and out of silence.
    assert.equal(audioIntentFor(idle).background, true);
    assert.equal(audioIntentFor(spinning).background, true);
    assert.equal(audioIntentFor(bonus).background, true);
  });

  it("plays the spin bed while the reels are still moving, not just while awaiting a result", () => {
    /*
     * The whole subtlety. `revealing` means the result is already known —
     * but the reels are moving and the player is watching a spin. Cutting
     * the bed at `spinning -> revealing` would stop the sound partway
     * through the motion it exists to accompany.
     */
    assert.equal(audioIntentFor(spinning).spin, true);
    assert.equal(audioIntentFor(revealing).spin, true);
  });

  it("stops the spin bed once the round is over", () => {
    assert.equal(audioIntentFor(idle).spin, false);
    assert.equal(audioIntentFor(bonus).spin, false);
  });

  it("silences everything when the session ends", () => {
    // A disconnected player should not be left with music over a dead
    // client.
    assert.deepEqual(audioIntentFor(offline), { background: false, spin: false });
    assert.deepEqual(audioIntentFor({ phase: "unrecoverable", code: "token_spent" }), {
      background: false,
      spin: false,
    });
  });
});

describe("a game with no audio configured", () => {
  it("reports that it has none, so no control is offered for silence", () => {
    const audio = new GameAudio({});

    assert.equal(audio.hasAudio, false);
  });

  it("does nothing rather than throwing when driven", () => {
    // Every game in this repo ships no music, so this is the ordinary path
    // and must be the quietest one in the code as well as on screen.
    const audio = new GameAudio({});

    audio.apply(spinning);
    audio.prime();
    audio.setMuted(true);
    audio.destroy();

    assert.equal(audio.hasAudio, false);
  });

  it("refuses a URL the loader would not accept", () => {
    /*
     * Same rule as artwork, and the same reason: these URLs come from a
     * game definition a designer edits, so a careless or hostile value
     * would otherwise reach the browser's media loader directly. Refusing
     * means silence — which is exactly what a game with no music already
     * sounds like, so the fallback costs nothing.
     */
    const audio = new GameAudio({ musicUrl: "javascript:alert(1)", spinSoundUrl: "data:audio/mp3;base64,AAAA" });

    assert.equal(audio.hasAudio, false);
  });
});

describe("the tracks are configured for their job", () => {
  it("loops both, since a spin's length varies", () => {
    // A fixed-length clip would end mid-spin on a slow reveal or run past
    // the end of a fast one.
    const { background, spin } = setup();

    assert.equal(background.loop, true);
    assert.equal(spin.loop, true);
  });

  it("keeps the ambient bed quieter than the spin", () => {
    const { background, spin } = setup();

    assert.ok(background.volume < spin.volume, "ambience must sit under the sound a player is attending to");
  });
});

describe("driving the tracks from the phase", () => {
  it("starts the ambient loop as soon as the client is playable", () => {
    const { audio, background } = setup();

    audio.apply(idle);

    assert.deepEqual(background.calls, ["play"]);
  });

  it("does not restart the ambient loop on every phase change", () => {
    // Re-`play()`ing a running loop is audible: it either restarts the
    // track or stutters, depending on the browser.
    const { audio, background } = setup();

    audio.apply(idle);
    audio.apply(spinning);
    audio.apply(revealing);

    assert.deepEqual(background.calls, ["play"], "the bed must be started once and left alone");
  });

  it("layers the spin bed over the ambient loop rather than replacing it", () => {
    const { audio, background, spin } = setup();

    audio.apply(idle);
    audio.apply(spinning);

    assert.equal(background.paused, false, "the ambient loop keeps running under a spin");
    assert.equal(spin.paused, false);
  });

  it("keeps the spin bed running through the reveal", () => {
    const { audio, spin } = setup();

    audio.apply(spinning);
    audio.apply(revealing);

    assert.deepEqual(spin.calls, ["play"], "the bed must not stop and restart mid-motion");
  });

  it("stops the spin bed when the round ends", () => {
    const { audio, spin } = setup();

    audio.apply(spinning);
    audio.apply(idle);

    assert.equal(spin.paused, true);
  });

  it("restarts the spin bed from the top on the next spin", () => {
    // Resuming a loop mid-phrase makes consecutive spins sound arbitrarily
    // different from each other.
    const { audio, spin } = setup();

    audio.apply(spinning);
    audio.apply(idle);
    spin.currentTime = 12;
    audio.apply(spinning);

    assert.equal(spin.currentTime, 0);
  });

  it("silences everything when the connection drops", () => {
    const { audio, background, spin } = setup();

    audio.apply(spinning);
    audio.apply(offline);

    assert.equal(background.paused, true);
    assert.equal(spin.paused, true);
  });
});

describe("muting", () => {
  it("pauses rather than only setting the muted flag", () => {
    // A muted session should not still be downloading and decoding audio
    // nobody can hear.
    const { audio, background } = setup();
    audio.apply(idle);

    audio.setMuted(true);

    assert.equal(background.paused, true);
    assert.equal(background.muted, true);
  });

  it("resumes exactly what the phase asks for, not everything", () => {
    /*
     * The reason the last intent is remembered. Unmuting mid-spin must
     * restore the spin bed too; unmuting while idle must NOT start it —
     * a naive "resume everything" would play a spin sound with the reels
     * stationary.
     */
    const { audio, background, spin } = setup();
    audio.apply(idle);
    audio.setMuted(true);

    audio.setMuted(false);

    assert.equal(background.paused, false);
    assert.equal(spin.paused, true, "unmuting while idle must not start the spin bed");
  });

  it("restores the spin bed when unmuted mid-spin", () => {
    const { audio, spin } = setup();
    audio.apply(spinning);
    audio.setMuted(true);

    audio.setMuted(false);

    assert.equal(spin.paused, false);
  });

  it("does not start anything while muted, however the phase changes", () => {
    const { audio, background, spin } = setup();

    audio.setMuted(true);
    audio.apply(spinning);

    assert.equal(background.paused, true);
    assert.equal(spin.paused, true);
  });
});

describe("priming past the browser's autoplay policy", () => {
  it("is safe to call repeatedly, so every gesture can try again", () => {
    /*
     * The first `play()` genuinely happens before any user gesture and is
     * refused — that is expected rather than a fault. Priming therefore has
     * to be a no-op once running, so it can be called from every click
     * without each call site tracking whether audio has been unlocked yet.
     */
    const { audio, background } = setup();
    audio.apply(idle);

    audio.prime();
    audio.prime();

    assert.deepEqual(background.calls, ["play"]);
  });

  it("does not start audio the phase has not asked for", () => {
    // A gesture on a disconnected client must not begin music.
    const { audio, background } = setup();
    audio.apply(offline);

    audio.prime();

    assert.equal(background.paused, true);
  });

  it("does not override a mute", () => {
    const { audio, background } = setup();
    audio.apply(idle);
    audio.setMuted(true);

    audio.prime();

    assert.equal(background.paused, true);
  });
});

describe("teardown", () => {
  it("stops every track, so nothing outlives the client", () => {
    const { audio, background, spin } = setup();
    audio.apply(spinning);

    audio.destroy();

    assert.equal(background.paused, true);
    assert.equal(spin.paused, true);
  });
});
