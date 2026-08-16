import type { GameDefinition } from "@slots-engine/shared-types";

/**
 * A 5x3 game whose bonus is the **multi-step `pick` module** — the one the
 * concurrency fix in `bonus/session.ts` actually exists for.
 *
 * `reference-5x3` carries the `wheel` module, which resolves in a single
 * step at `start`. That makes it a fine game and a useless subject for the
 * step race: there is no second step to run twice. So the load check's
 * bonus section skipped against it, and the atomic-claim fix was asserted
 * only against an in-memory fake.
 *
 * This fixture exists so that race can be run against real Mongo. Two
 * properties are tuned for that purpose rather than for play:
 *
 * - **The bonus triggers often.** `star` appears far more frequently than
 *   is sensible for a shipping game, so a load check reaches an open
 *   session in a handful of spins instead of a few hundred. A test that
 *   usually gives up before reaching its subject is not a test.
 * - **The pick round is long.** Nine tiles with a single blank means a
 *   session stays open across many steps, so there is a wide window in
 *   which concurrent steps genuinely overlap.
 *
 * Both make the RTP meaningless, which is why this game is **not seeded**
 * alongside the reference game and is marked with a deliberately absurd
 * `rtpTarget` — it is a test instrument, and publishing it through the
 * normal gate would rightly be refused.
 */

/** Outer reels carry no wild, and one `star` — the trigger needs three. */
const OUTER_REEL = [
  "ten", "star", "jack", "cherry", "star", "queen", "bell", "star", "ten", "king",
  "star", "jack", "plum", "star", "queen", "ten", "star", "bell", "jack", "star",
];

const INNER_REEL = [
  "ten", "star", "wild", "jack", "star", "queen", "cherry", "star", "bell", "ten",
  "star", "king", "jack", "star", "plum", "ten", "star", "queen", "bell", "star",
];

export const PICK_BONUS_GAME: GameDefinition = {
  gameId: "pick-bonus-5x3",
  name: "Pick Bonus 5x3",
  version: 1,
  status: "published",
  grid: { reels: 5, rows: 3 },
  reelGenerationMode: "reel-strip",
  reelStrips: [
    { reelIndex: 0, symbols: OUTER_REEL },
    { reelIndex: 1, symbols: INNER_REEL },
    { reelIndex: 2, symbols: INNER_REEL },
    { reelIndex: 3, symbols: INNER_REEL },
    { reelIndex: 4, symbols: OUTER_REEL },
  ],
  paylines: [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
  ],
  symbols: [
    {
      symbol: "ten",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 2, 4: 5, 5: 20 },
    },
    {
      symbol: "jack",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 2, 4: 6, 5: 25 },
    },
    {
      symbol: "queen",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 3, 4: 8, 5: 30 },
    },
    {
      symbol: "king",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 4, 4: 10, 5: 40 },
    },
    {
      symbol: "bell",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 5, 4: 12, 5: 50 },
    },
    {
      symbol: "cherry",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 5, 4: 15, 5: 60 },
    },
    {
      symbol: "plum",
      allowedReels: [0, 1, 2, 3, 4],
      role: "regular",
      paytable: { 3: 6, 4: 18, 5: 70 },
    },
    {
      symbol: "wild",
      allowedReels: [1, 2, 3],
      role: "wild",
      wildConfig: { substitutesFor: ["ten", "jack", "queen", "king", "bell", "cherry", "plum"], multiplier: 1 },
    },
    {
      symbol: "star",
      allowedReels: [0, 1, 2, 3, 4],
      role: "bonusTrigger",
      bonusTriggerConfig: { module: "pick", minCount: 3 },
    },
  ],
  bonusModules: [
    {
      moduleId: "pick",
      params: {
        rewardMultipliers: [1, 2, 3, 5],
        tileCount: 9,
        // One blank out of nine: the round usually runs many steps before
        // it ends, which is the window the step race needs.
        blankCount: 1,
      },
    },
  ],
  // Deliberately not a real target. This fixture is tuned for reachability
  // of the bonus, not for return, and should never pass a publish gate.
  rtpTarget: 0.95,
  betOptions: [100, 200, 500, 1000, 2000, 5000],
  currency: "USD",
  mathEngineId: "generic-v1",
  paylineWinRule: "sum",
};
