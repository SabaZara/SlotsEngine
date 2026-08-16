import type { GameDefinition } from "@slots-engine/shared-types";

/**
 * A real, playable 5x3 reference game — the fixture the engine seeds on
 * first boot and every test evaluates against.
 *
 * Deliberately tuned to a **shippable** RTP (~0.95), not an inflated one. A
 * fixture that pays back more than it takes exercises the plumbing but
 * teaches the wrong intuition to everyone who reads it, and it can't be
 * used to sanity-check that the simulation reports a believable number.
 *
 * Reel-strip mode: a symbol's frequency is how many times it appears on a
 * strip, so the strips below ARE the game's math. High symbols are scarce
 * and back-loaded onto later reels; the wild appears on reels 1-3 only,
 * which is what keeps five-of-a-kind rare without making wins feel absent.
 */

/** Reels 0 and 4 carry no wild, so a 5-of-a-kind always needs the real
 * symbol at both ends — the standard way to keep the top prize rare. */
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

export const REFERENCE_GAME: GameDefinition = {
  gameId: "reference-5x3",
  name: "Reference 5x3",
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
  // Ten lines: three straights, two V shapes, and five zigzags. Enough for
  // wins to feel frequent without the grid being saturated.
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
  // A note on the scale of these numbers, because it is the single easiest
  // thing to get wrong: a paytable multiplier applies to that LINE's stake,
  // not to the whole bet. With 10 paylines each line is staked at a tenth of
  // the bet, so a 3-of-a-kind paying `10` returns 1x the total bet, not 10x.
  // Scatter payouts (below) are the exception — they multiply the whole bet,
  // which is why those numbers look an order of magnitude smaller.
  //
  // The values here were fitted by simulation to the `rtpTarget` below, not
  // chosen by eye. `runSimulation` is the check: see `simulate.test.ts`.
  symbols: [
    // Low symbols: frequent, small. They carry hit frequency, not return.
    { symbol: "ten", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 29, 5: 92 } },
    { symbol: "jack", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 29, 5: 92 } },
    { symbol: "queen", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 14, 4: 39, 5: 148 } },
    { symbol: "king", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 19, 4: 53, 5: 187 } },
    { symbol: "ace", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 21, 4: 73, 5: 280 } },
    // Mid symbols.
    { symbol: "cherry", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 26, 4: 79, 5: 265 } },
    { symbol: "plum", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 33, 4: 106, 5: 335 } },
    { symbol: "bell", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 53, 4: 159, 5: 530 } },
    // The top symbol — scarce on every strip.
    { symbol: "seven", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 132, 4: 530, 5: 1975 } },
    {
      symbol: "wild",
      // Reels 1-3 only. This single restriction is the main lever holding
      // the top-end payouts down.
      allowedReels: [1, 2, 3],
      role: "wild",
      paytable: { 3: 66, 4: 265, 5: 985 },
      // "all-regular" never covers scatter or bonus symbols — see
      // wildSubstitutes. That default is what stops a wild from silently
      // manufacturing scatter wins.
      wildConfig: { substitutesFor: "all-regular", multiplier: 2 },
    },
    {
      symbol: "scatter",
      allowedReels: [0, 1, 2, 3, 4],
      role: "scatter",
      // Pays on count anywhere, as a multiple of the whole bet — not of a
      // single line's stake, which is why these numbers look small next to
      // the paytables above.
      scatterConfig: { multiplierOf: "totalBet", payout: { 3: 3, 4: 15, 5: 80 } },
    },
    {
      symbol: "star",
      allowedReels: [0, 1, 2, 3, 4],
      role: "bonusTrigger",
      bonusTriggerConfig: { module: "wheel", minCount: 3 },
    },
  ],
  bonusModules: [{ moduleId: "wheel", params: { rewardMultipliers: [2, 3, 5, 8, 12, 20, 35, 50] } }],
  rtpTarget: 0.95,
  // Integer minor units: 100 = 1.00 in the game's currency.
  betOptions: [100, 200, 500, 1000, 2000, 5000],
  currency: "USD",
  mathEngineId: "generic-v1",
  paylineWinRule: "sum",
};
