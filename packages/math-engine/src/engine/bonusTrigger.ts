import type { BonusModuleId, GameDefinition } from "@slots-engine/shared-types";
import type { Rng } from "@slots-engine/rng";
import type { Matrix } from "./matrix.js";
import { countSymbol } from "./scatter.js";

export interface BonusTriggerResult {
  triggered: boolean;
  moduleId?: BonusModuleId;
}

/**
 * Decides whether this spin starts a bonus round.
 *
 * Two independent paths, checked in this order:
 *
 * 1. **Symbol trigger** — enough `bonusTrigger` symbols landed. Definition
 *    order breaks ties, so the same grid always picks the same module.
 * 2. **Probability trigger** — a flat per-spin chance declared on the
 *    module itself, only rolled when no symbol trigger already fired.
 *
 * The probability roll draws from the SAME seeded stream as the rest of the
 * spin. That is deliberate and load-bearing: a separate randomness source
 * here would make the round unreplayable from its stored seed, which is
 * precisely the property the whole audit story rests on.
 *
 * Because the roll is only consumed when reached, the draw sequence depends
 * on the grid — fine for replay (identical inputs, identical path) but the
 * reason this function must stay the last consumer of `rng` in a spin.
 */
export function checkFeatureTrigger(matrix: Matrix, gameDef: GameDefinition, rng: Rng): BonusTriggerResult {
  for (const symbol of gameDef.symbols) {
    const config = symbol.bonusTriggerConfig;
    if (symbol.role !== "bonusTrigger" || !config) continue;

    const count = countSymbol(matrix, gameDef, symbol.symbol, config.wildCountsToward === true);
    if (count >= config.minCount) {
      return { triggered: true, moduleId: config.module };
    }
  }

  for (const module of gameDef.bonusModules) {
    const chance = module.probabilityTrigger?.chancePerSpin;
    if (chance === undefined || chance <= 0) continue;
    if (rng.next() < chance) {
      return { triggered: true, moduleId: module.moduleId };
    }
  }

  return { triggered: false };
}
