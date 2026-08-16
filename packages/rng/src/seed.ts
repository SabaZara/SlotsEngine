import { randomBytes } from "node:crypto";

/**
 * Cryptographically-secure, unpredictable seed for a single round. This is
 * the only place true OS entropy enters the system — everything downstream
 * (the actual spin outcome) is a *deterministic* function of this seed, so
 * a stored seed lets an auditor replay any historical round exactly.
 *
 * Never derive a seed from anything guessable (wall-clock time, a round
 * counter, a player id): predictability here is predictability of outcomes.
 */
export function generateSeed(): string {
  return randomBytes(32).toString("hex");
}
