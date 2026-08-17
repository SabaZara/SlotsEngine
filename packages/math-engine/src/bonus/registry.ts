import { createHash } from "node:crypto";
import { createRng, type Rng } from "@slots-engine/rng";
import type { BonusModule, BonusParamSpec } from "./types.js";
import { wheelModule } from "./modules/wheel.js";
import { pickModule } from "./modules/pick.js";
import { freeSpinsModule } from "./modules/freeSpins.js";

const modules = new Map<string, BonusModule>();

export function registerBonusModule(module: BonusModule): void {
  modules.set(module.moduleId, module);
}

/** Throws rather than falling back — a game referencing an unregistered
 * module is a deployment error, and paying out under a substituted module
 * would be worse than refusing. */
export function getBonusModule(moduleId: string): BonusModule {
  const module = modules.get(moduleId);
  if (!module) {
    throw new Error(`no bonus module registered under id '${moduleId}' (registered: ${[...modules.keys()].join(", ") || "none"})`);
  }
  return module;
}

export function listBonusModules(): string[] {
  return [...modules.keys()];
}

/**
 * Every registered module with the parameters it reads.
 *
 * The backoffice builds its bonus form from this, which is the whole point:
 * F24 was a module list kept in a second place, and a *parameter* list kept
 * in a second place would be the identical bug one level down — a form
 * offering a field the module ignores, or omitting one it depends on, with
 * nothing failing either way because every module silently falls back to a
 * default.
 *
 * A module with no `paramSchema` reports an empty array rather than being
 * omitted. The distinction matters to the caller: "this module takes no
 * parameters I can describe" is an answer, and dropping the module entirely
 * would make it unselectable — F24 exactly.
 */
export function listBonusModuleSchemas(): Array<{ moduleId: string; params: BonusParamSpec[] }> {
  return [...modules.values()].map((module) => ({
    moduleId: module.moduleId,
    // Copied rather than handed back by reference — F18's shape, where
    // returning internal state from the function meant to produce a safe
    // view let a caller edit the registry in place.
    params: (module.paramSchema ?? []).map((spec) => ({ ...spec })),
  }));
}

/**
 * Derives a bonus step's RNG deterministically from the session's own seed
 * plus the step number, rather than drawing fresh entropy at step time.
 *
 * This is what makes a bonus round auditable to the same standard as a
 * spin: given the session seed, every step's randomness can be recomputed
 * exactly. It also means a retried or concurrent step for the same step
 * number sees the identical stream, so a duplicate request cannot produce a
 * different prize than the one already recorded.
 */
export function deriveStepRng(sessionSeed: string, stepIndex: number): Rng {
  const derived = createHash("sha256").update(`${sessionSeed}:${stepIndex}`).digest("hex");
  return createRng(derived);
}

registerBonusModule(wheelModule);
registerBonusModule(pickModule);
registerBonusModule(freeSpinsModule);
