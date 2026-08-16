import { createHash } from "node:crypto";
import type { BonusModule, BonusStepInput, BonusStepOutput } from "../types.js";
import { InvalidBonusActionError } from "../types.js";
import { evaluateSpin } from "../../engine/spin.js";

const DEFAULT_SPIN_COUNT = 10;
const DEFAULT_WIN_MULTIPLIER = 2;
/** Extra spins granted when a retrigger lands. */
const DEFAULT_RETRIGGER_SPINS = 5;
/**
 * Hard ceiling on retriggers per session.
 *
 * Uncapped retriggering is not a theoretical concern: each free spin is
 * played on the real reels, so it has the same chance of triggering the
 * bonus again that the base game does. With a trigger probability p, the
 * expected number of retriggers over N spins is N·p, and the round only
 * terminates because that is below 1 — a designer who raises either value
 * far enough produces a session that never ends and pays without bound.
 *
 * A cap makes the worst case finite and computable, which is what lets the
 * publish gate reason about this module at all.
 */
const DEFAULT_MAX_RETRIGGERS = 5;

interface FreeSpinsConfig {
  spinCount: number;
  winMultiplier: number;
  retriggerSpins: number;
  maxRetriggers: number;
}

interface FreeSpinsState {
  /** Spins still to play, including any granted by a retrigger. */
  remaining: number;
  /** Spins played so far — also the index into the derived rng stream. */
  played: number;
  retriggers: number;
  /** Accumulated win in integer minor units, already multiplied. */
  accumulated: number;
  done: boolean;
}

function positiveInt(value: unknown, fallback: number, min = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function config(params: Record<string, unknown>): FreeSpinsConfig {
  return {
    spinCount: positiveInt(params.spinCount, DEFAULT_SPIN_COUNT),
    // A multiplier of 1 is meaningful (free spins with no boost), so the
    // floor here is 1 rather than the 1-and-above an ordinary count needs.
    winMultiplier:
      typeof params.winMultiplier === "number" && Number.isFinite(params.winMultiplier) && params.winMultiplier >= 1
        ? params.winMultiplier
        : DEFAULT_WIN_MULTIPLIER,
    retriggerSpins: positiveInt(params.retriggerSpins, DEFAULT_RETRIGGER_SPINS, 0),
    maxRetriggers: positiveInt(params.maxRetriggers, DEFAULT_MAX_RETRIGGERS, 0),
  };
}

function readState(state: Record<string, unknown>): FreeSpinsState {
  const remaining = state.remaining;
  if (typeof remaining !== "number") {
    throw new InvalidBonusActionError("free-spins session has no remaining-spin count");
  }
  return {
    remaining,
    played: typeof state.played === "number" ? state.played : 0,
    retriggers: typeof state.retriggers === "number" ? state.retriggers : 0,
    accumulated: typeof state.accumulated === "number" ? state.accumulated : 0,
    done: state.done === true,
  };
}

/**
 * Derives the seed for one free spin from the session seed and the spin
 * index.
 *
 * The same construction `deriveStepRng` uses, and for the same reason: given
 * the session seed, every spin in the round can be recomputed exactly, so a
 * dispute is settled by replay rather than by trusting a log. It must NOT
 * draw from `input.rng` directly — that generator is already derived per
 * step, and a spin's seed has to be reproducible from `(sessionSeed, index)`
 * alone so a replay does not depend on how many times `step` was called.
 */
function spinSeed(sessionSeed: string, spinIndex: number): string {
  return createHash("sha256").update(`${sessionSeed}:freespin:${spinIndex}`).digest("hex");
}

/**
 * Free spins: N spins on the real reels, wins multiplied, retriggerable.
 *
 * **Every free spin is a real spin.** It goes through `evaluateSpin` against
 * the game's own definition — the same reel strips, paylines, wilds and
 * scatters the base game uses — rather than a simplified model. Anything
 * else would mean the feature paid out under mathematics nobody configured
 * and no simulation measured, which is the failure `getMathEngine` refuses an
 * unknown id to avoid.
 *
 * That is why this module needs `gameDef`, and why it throws when it is
 * absent rather than substituting a default.
 *
 * **The session seed is stored, not the individual spin seeds.** Each spin's
 * seed is `sha256(sessionSeed:freespin:index)`, so the whole round replays
 * from one stored value and no per-spin state can drift from what was paid.
 *
 * **Retriggering is capped.** A free spin can land the trigger again, since
 * it is a real spin on the real reels; each retrigger grants more spins up
 * to `maxRetriggers`. Without the cap a sufficiently generous configuration
 * produces a round that never terminates — see the constant's note.
 */
export const freeSpinsModule: BonusModule = {
  moduleId: "freeSpins",

  start({ params }): BonusStepOutput {
    const { spinCount, winMultiplier } = config(params);

    const state: FreeSpinsState = {
      remaining: spinCount,
      played: 0,
      retriggers: 0,
      accumulated: 0,
      done: false,
    };

    // Deliberately NOT resolved on start, unlike the wheel. The player
    // drives each spin, so the client can animate the reels for every one —
    // resolving the whole round immediately would pay correctly and show
    // the player a single number where a slot is expected to show ten
    // spins.
    return {
      state: { ...state },
      done: false,
      totalWin: 0,
      view: {
        remaining: spinCount,
        played: 0,
        retriggers: 0,
        winMultiplier,
        accumulatedWin: 0,
        spins: [],
      },
    };
  },

  step({ totalBet, state: rawState, params, action, gameDef, sessionSeed }: BonusStepInput): BonusStepOutput {
    const state = readState(rawState);
    if (state.done) throw new InvalidBonusActionError("this bonus session is already finished");
    if (action !== "spin") {
      throw new InvalidBonusActionError(`unsupported action '${action}' — the freeSpins module accepts 'spin'`);
    }
    if (state.remaining <= 0) throw new InvalidBonusActionError("no free spins remain");

    // Refused rather than defaulted. A free spin evaluated against anything
    // other than this game's own reels pays out under mathematics nobody
    // configured, and a silent fallback would make that indistinguishable
    // from a correct round.
    if (!gameDef) {
      throw new InvalidBonusActionError("the freeSpins module requires the game definition to spin the real reels");
    }

    const { winMultiplier, retriggerSpins, maxRetriggers } = config(params);

    // Refused rather than defaulted, for the same reason `gameDef` is. A
    // module that quietly invented a seed would produce a round that cannot
    // be replayed from what was stored — and it would look completely
    // normal, because the spins would still be random.
    if (!sessionSeed) {
      throw new InvalidBonusActionError("the freeSpins module requires the session seed to derive replayable spins");
    }

    const seed = spinSeed(sessionSeed, state.played);

    // The algorithm argument is omitted, exactly as the base spin path does
    // (`rounds/service.ts` calls `evaluateSpin(gameDef, seed, totalBet)`),
    // so a free spin resolves under the same generator as an ordinary one.
    // Naming a different algorithm here would make the two halves of a game
    // disagree about how randomness is produced.
    const result = evaluateSpin(gameDef, seed, totalBet);

    // The base-game win, multiplied. `Math.floor` keeps this in integer
    // minor units — a fractional multiplier must never create a fraction of
    // a unit, which is the whole reason money is integer here.
    const spinWin = Math.floor(result.evaluation.totalWin * winMultiplier);

    // A free spin is a real spin, so it can trigger the feature again. The
    // cap is what makes the round finite.
    const retriggered = result.evaluation.bonusTriggered && state.retriggers < maxRetriggers;
    const granted = retriggered ? retriggerSpins : 0;

    const remaining = state.remaining - 1 + granted;
    const played = state.played + 1;
    const accumulated = state.accumulated + spinWin;
    const done = remaining <= 0;

    const next: FreeSpinsState = {
      remaining,
      played,
      retriggers: state.retriggers + (retriggered ? 1 : 0),
      accumulated,
      done,
    };

    return {
      state: { ...next },
      done,
      totalWin: done ? accumulated : 0,
      view: {
        remaining,
        played,
        retriggers: next.retriggers,
        winMultiplier,
        accumulatedWin: accumulated,
        // Only the spin just played is described, never a future one — the
        // same rule the pick module follows about its unrevealed tiles.
        lastSpin: {
          matrix: result.finalMatrix,
          winLines: result.evaluation.winLines,
          baseWin: result.evaluation.totalWin,
          multipliedWin: spinWin,
          retriggered,
          ...(granted > 0 ? { spinsGranted: granted } : {}),
        },
        ...(done ? { totalWin: accumulated } : {}),
      },
    };
  },

  /**
   * Expected return of a free-spins round, as a multiple of the triggering
   * bet.
   *
   *     E[total] = spins × baseRtp × winMultiplier × retriggerFactor
   *
   * **This one is genuinely an estimate, and the reason is worth stating
   * rather than hiding behind a number.** Unlike `wheel` (exact, a mean over
   * equally-likely segments) and `pick` (a closed form with one documented
   * assumption), a free spin's return is the base game's own RTP — which is
   * a property of the reel strips and paytable, not of `params`.
   *
   * `params` cannot see the game definition, so the base RTP is taken from
   * `params.assumedBaseRtp` when a designer supplies it and falls back to
   * 0.95 otherwise. That fallback is the module's single largest source of
   * error, and it is declared rather than buried: a game tuned to 0.88 with
   * the default assumed would have its bonus return overstated by ~8%.
   *
   * The retrigger factor is the expected multiplier on total spins from a
   * capped geometric process. With per-spin trigger probability p, each spin
   * grants `retriggerSpins` more with probability p until the cap, so the
   * expected total is bounded by `1 + maxRetriggers × retriggerSpins /
   * spinCount`. Using the BOUND rather than the true expectation is
   * deliberate: it overstates the bonus return, which makes the publish gate
   * *stricter* than reality. An overstated bonus makes a game look like it
   * pays more than it does, so the gate refuses a game that is actually
   * within tolerance — a false refusal a designer can investigate, rather
   * than a false acceptance that ships.
   */
  expectedReturnMultiplier(params: Record<string, unknown>): number {
    const { spinCount, winMultiplier, retriggerSpins, maxRetriggers } = config(params);

    const assumedBaseRtp =
      typeof params.assumedBaseRtp === "number" && params.assumedBaseRtp > 0 && params.assumedBaseRtp < 2
        ? params.assumedBaseRtp
        : 0.95;

    // Upper bound on the spin multiplier from retriggering, per the note.
    const retriggerFactor = 1 + (maxRetriggers * retriggerSpins) / spinCount;

    return spinCount * assumedBaseRtp * winMultiplier * retriggerFactor;
  },
};
