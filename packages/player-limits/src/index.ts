/**
 * Player protection limits: the ceilings a licensed operator must be able
 * to place on how much a player stakes or loses in a period.
 *
 * **Why this is a package rather than a module inside game-backend.** The
 * decision has to be made on the money path, but limits are *set* through
 * the operator API and *read* by the backoffice, so three services need the
 * same definition of what a limit means. A second copy of "is this bet
 * allowed" is the drift F24 is about, and here the two copies would
 * disagree about money.
 *
 * The split inside is the important part: `decide.ts` is pure and holds
 * everything that can be arithmetically wrong; `periods.ts` turns a clock
 * reading into a counter key. Neither touches a database. The atomic
 * accumulation that makes the check safe under concurrency lives in
 * game-backend, inside the spin transaction, because that is the only place
 * it can be correct.
 */

export { LIMIT_PERIODS, periodKey, type LimitPeriod } from "./periods.js";
export {
  decideBet,
  type LimitDecision,
  type LimitRefusalReason,
  type PeriodUsage,
  type PlayerLimit,
} from "./decide.js";
