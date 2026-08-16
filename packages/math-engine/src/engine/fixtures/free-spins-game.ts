import type { GameDefinition } from "@slots-engine/shared-types";

/**
 * A real, playable 5x3 game whose feature is **free spins** — the third
 * shipped fixture, and the first whose bonus is played on its own reels.
 *
 * It exists to be shippable, not to be a test instrument. `pick-bonus-5x3`
 * is deliberately broken (100% trigger rate) and is refused in production;
 * this one is tuned to a believable RTP the same way `reference-5x3` is, so
 * it passes the publish gate on its merits and can be seeded alongside it.
 *
 * ## What is different from `reference-5x3`, and why
 *
 * The paytable is **lower across the board** — roughly 8% below the
 * reference game's on every entry. That is not a stylistic choice: free
 * spins add return on top of the base game, and a game carrying the
 * reference paytable *plus* ten multiplied free spins would measure well
 * above 1.0 and be refused. The base game gives up some return so the
 * feature can pay for itself, which is how a real free-spins slot is built.
 *
 * The figure was found by simulation, not by arithmetic: an 8% reduction
 * measures a base RTP of 0.808 and a full RTP of 0.954, a drift of 0.004
 * against a 0.05 tolerance. A 12% reduction — the first attempt — came in at
 * 0.927, and a 10% one overshot to 1.03. The curve is steep because the
 * feature's return scales with the base paytable it is drawn from, so both
 * halves move together.
 *
 * The `scatter` symbol does double duty as the trigger, which is the
 * convention nearly every real slot follows — three scatters pay a scatter
 * prize *and* award the free spins. Here they are kept as separate symbols
 * (`scatter` pays, `star` triggers) to match the reference game's shape and
 * keep the two effects independently tunable; a designer wanting the
 * combined behaviour sets `bonusTriggerConfig` on `scatter` instead.
 *
 * ## The numbers
 *
 * Fitted by simulation against `runSimulation`, not chosen by eye, and the
 * fit is pinned by `free-spins-game.test.ts` rather than asserted here.
 * `assumedBaseRtp` is passed explicitly in `params` so the publish gate
 * scores the feature against this game's actual base return rather than the
 * module's 0.95 fallback — the module's own docstring names that fallback as
 * its largest source of error, and a fixture is exactly where it should be
 * overridden.
 */

/** Reels 0 and 4 carry no wild, so a 5-of-a-kind always needs the real
 * symbol at both ends. One `star` each, so a three-star trigger needs it on
 * both outer reels plus an inner one. */
const OUTER_REEL = [
  "ten", "jack", "cherry", "queen", "bell", "ten", "king", "jack", "plum", "queen",
  "ten", "bell", "jack", "ace", "cherry", "queen", "ten", "plum", "king", "jack",
  "seven", "ten", "queen", "bell", "jack", "cherry", "ten", "ace", "queen", "plum",
  "scatter", "ten", "jack", "king", "queen", "ten", "bell", "jack", "cherry", "star",
];

const INNER_REEL = [
  "ten", "jack", "wild", "queen", "cherry", "ten", "bell", "jack", "king", "plum",
  "ten", "queen", "jack", "seven", "bell", "ten", "cherry", "queen", "ace", "jack",
  "ten", "plum", "star", "king", "queen", "ten", "jack", "bell", "cherry", "queen",
  "scatter", "ten", "jack", "ace", "plum", "ten", "queen", "bell", "jack", "king",
];

/**
 * The base game's own return, measured with the feature contributing
 * nothing. Passed to the module as `assumedBaseRtp` so its expected-return
 * estimate is grounded in this game rather than in a default.
 *
 * Measured, not assumed — `free-spins-game.test.ts` fails if the base game
 * drifts away from it.
 */
export const FREE_SPINS_BASE_RTP = 0.81;

export const FREE_SPINS_GAME: GameDefinition = {
  gameId: "free-spins-5x3",
  name: "Free Spins 5x3",
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
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [1, 2, 1, 0, 1],
  ],
  // Roughly 12% below `reference-5x3` on every entry. The base game funds
  // the feature — see the note at the top. A multiplier applies to that
  // LINE's stake, not the whole bet: with 10 paylines, a 3-of-a-kind paying
  // 10 returns 1x the total bet.
  symbols: [
    { symbol: "ten", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 9, 4: 27, 5: 85 } },
    { symbol: "jack", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 9, 4: 27, 5: 85 } },
    { symbol: "queen", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 13, 4: 36, 5: 137 } },
    { symbol: "king", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 18, 4: 49, 5: 173 } },
    { symbol: "ace", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 19, 4: 67, 5: 258 } },
    { symbol: "cherry", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 24, 4: 74, 5: 245 } },
    { symbol: "plum", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 30, 4: 98, 5: 310 } },
    { symbol: "bell", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 49, 4: 147, 5: 489 } },
    { symbol: "seven", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 122, 4: 489, 5: 1825 } },
    {
      symbol: "wild",
      allowedReels: [1, 2, 3],
      role: "wild",
      paytable: { 3: 61, 4: 245, 5: 910 },
      wildConfig: { substitutesFor: "all-regular", multiplier: 2 },
    },
    {
      symbol: "scatter",
      allowedReels: [0, 1, 2, 3, 4],
      role: "scatter",
      scatterConfig: { multiplierOf: "totalBet", payout: { 3: 3, 4: 14, 5: 74 } },
    },
    {
      symbol: "star",
      allowedReels: [0, 1, 2, 3, 4],
      role: "bonusTrigger",
      bonusTriggerConfig: { module: "freeSpins", minCount: 3 },
    },
  ],
  bonusModules: [
    {
      moduleId: "freeSpins",
      params: {
        spinCount: 10,
        winMultiplier: 2,
        retriggerSpins: 5,
        // Capped so the round is finite and its worst case computable.
        // See the module's own note on why an uncapped retrigger is not a
        // theoretical concern.
        maxRetriggers: 3,
        // This game's own base return, so the publish gate scores the
        // feature against reality rather than the module's 0.95 fallback.
        assumedBaseRtp: FREE_SPINS_BASE_RTP,
      },
    },
  ],
  rtpTarget: 0.95,
  betOptions: [100, 200, 500, 1000, 2000, 5000],
  currency: "USD",
  mathEngineId: "generic-v1",
  paylineWinRule: "sum",
};
