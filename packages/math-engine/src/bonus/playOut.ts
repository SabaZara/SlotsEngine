import { createHash } from "node:crypto";
import type { GameDefinition } from "@slots-engine/shared-types";
import { deriveStepRng, getBonusModule } from "./registry.js";

/** The action each multi-step module accepts, keyed by module id.
 *
 * Read from a table rather than guessed, because every module treats an
 * unrecognised action as an error rather than a no-op — `pick` accepts
 * "pick", `freeSpins` accepts "spin", and a driver sending "start" to
 * either would throw rather than advance. Single-step modules resolve in
 * `start()` and never reach here.
 *
 * A module absent from this table and not resolving on start is a module
 * this driver cannot play, and `playOutBonus` says so rather than looping
 * to `maxSteps` and reporting a number nobody can act on. */
const STEP_ACTION: Record<string, string> = {
  pick: "pick",
  freeSpins: "spin",
};

/**
 * Plays one bonus round from trigger to resolution and returns what it paid.
 *
 * This exists to replace a constant. The simulation scored a triggered
 * bonus at a flat multiple of the bet — 20x by default — and that number
 * moves the published RTP more than the gate's own tolerance: the reference
 * game reports 0.9614 at 20x and 0.9044 at 5x, against a band of ±0.05. A
 * gate cannot detect an error larger than the band it compares against, so
 * the headline figure was an assumption wearing a measurement's clothes.
 *
 * `SimulationReport` still separates `baseRtp` from `bonusRtp`, which was
 * the real argument for not folding the bonus in: a drift stays
 * attributable to one half or the other. What changes is that both halves
 * are now played rather than one being asserted.
 *
 * The round is driven exactly as `bonus/session.ts` drives it in the game
 * backend — same module, same `deriveStepRng(seed, stepIndex)`, same
 * `sessionSeed` — so what this measures is what a player would be paid.
 * Deliberately not the same code path: the backend's is transactional and
 * database-bound, and a simulation opening a Mongo session per spin would
 * be unusable at 100k spins.
 *
 * A module that never reports `done` throws rather than returning a partial
 * total. Scoring an unfinished round would report an RTP no player could
 * receive, which is the failure this whole change exists to remove.
 */
export function playOutBonus(input: {
  gameDef: GameDefinition;
  moduleId: string;
  totalBet: number;
  /** Seeds the whole round, so a seeded simulation replays its bonus
   * rounds as exactly as it replays its base spins. */
  sessionSeed: string;
  maxSteps?: number;
}): { totalWin: number; steps: number } {
  const { gameDef, moduleId, totalBet, sessionSeed } = input;
  const maxSteps = input.maxSteps ?? 500;

  const module = getBonusModule(moduleId);
  const params = gameDef.bonusModules.find((m) => m.moduleId === moduleId)?.params ?? {};

  const started = module.start({
    totalBet,
    state: {},
    params,
    rng: deriveStepRng(sessionSeed, 0),
    gameDef,
    sessionSeed,
  });
  if (started.done) return { totalWin: started.totalWin, steps: 1 };

  const action = STEP_ACTION[moduleId];
  if (action === undefined) {
    throw new Error(
      `bonus module '${moduleId}' does not resolve on start and has no known step action — ` +
        `add it to STEP_ACTION so a simulation can play it out`,
    );
  }

  let state = started.state;
  let stepIndex = 1;

  while (stepIndex < maxSteps) {
    const result = module.step({
      totalBet,
      state,
      params,
      action,
      rng: deriveStepRng(sessionSeed, stepIndex),
      gameDef,
      sessionSeed,
    });

    state = result.state;
    stepIndex++;

    if (result.done) return { totalWin: result.totalWin, steps: stepIndex };
  }

  throw new Error(
    `bonus module '${moduleId}' did not resolve within ${maxSteps} steps — ` +
      `a simulation cannot score an unfinished round`,
  );
}

/** One bonus seed per spin, derived so the round replays from the spin's
 * own seed rather than from fresh entropy. */
export function bonusSeedForSpin(spinSeed: string): string {
  return createHash("sha256").update(`${spinSeed}:bonus`).digest("hex");
}
