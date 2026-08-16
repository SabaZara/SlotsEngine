/**
 * Per-account login throttling.
 *
 * The IP-keyed limiter on `/v1/auth/login` stops one address guessing
 * quickly. It does nothing about the attack that matters more: an attacker
 * spreading attempts across many addresses still gets the full per-IP
 * allowance *per address* against a single account. Ten guesses from each
 * of a thousand hosts is ten thousand guesses at one password, and every
 * one of them looks like a first attempt to a limiter keyed by IP.
 *
 * So this counts failures against the **account**, which is the thing being
 * attacked, and is deliberately independent of where they came from.
 *
 * ## Why this cannot live in the rate limiter
 *
 * The obvious implementation — key the limiter by IP *and* email — was
 * tried and measured, and is recorded in the README as one of three things
 * measurement corrected. `@fastify/rate-limit` runs its `keyGenerator` at
 * `onRequest`, before the body is parsed, so `request.body` is undefined
 * and every attempt collapses into one shared bucket: a *different* email
 * is then refused too, which converts the protection into a way for one
 * attacker to lock out every administrator.
 *
 * Per-account throttling therefore has to run *after* body parsing, inside
 * the handler, tracked against stored state rather than request metadata.
 * That is what this module is.
 *
 * ## Why the counter is keyed by attempted email, not by user id
 *
 * A failed attempt against an address that does not exist must be recorded
 * too. Keying by user id would mean only real accounts are tracked, and the
 * observable behaviour then differs between a real and an unknown address —
 * the account-enumeration oracle the login route already goes out of its
 * way to close (identical error body, dummy hash verification so the timing
 * matches). Throttling by user id would reopen through the side door what
 * that dummy hash closes through the front.
 *
 * ## The lockout is a window, not a flag
 *
 * A latching "locked" boolean needs something to unlatch it, and whatever
 * that is — an admin, a job — becomes a second failure mode. Storing
 * `lockedUntil` as a timestamp makes recovery a property of time passing,
 * which requires nothing to be working. This is the same reasoning as the
 * TTL-index note in docs/TODO.md, applied where it is cheap to get right.
 */

import type { Db } from "mongodb";

export interface ThrottlePolicy {
  /** Consecutive failures tolerated before the account is locked. */
  maxAttempts: number;
  /** How long a lockout lasts, in milliseconds. */
  lockoutMs: number;
  /** Idle time after which the failure count is forgotten, in
   * milliseconds. Without this a handful of typos spread over months would
   * eventually lock a legitimate user out. */
  attemptWindowMs: number;
}

export function loadThrottlePolicy(env: NodeJS.ProcessEnv = process.env): ThrottlePolicy {
  return {
    maxAttempts: Number(env.LOGIN_MAX_ATTEMPTS ?? 10),
    lockoutMs: Number(env.LOGIN_LOCKOUT_MINUTES ?? 15) * 60_000,
    attemptWindowMs: Number(env.LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15) * 60_000,
  };
}

/** Same normalisation as `findUserByEmail`, so "Ana@x.com" and "ana@x.com"
 * share one counter. Two counters for one account would halve the
 * protection and be invisible while doing it. */
function normaliseKey(email: string): string {
  return email.trim().toLowerCase();
}

export interface LockState {
  locked: boolean;
  /** Whole seconds until the lock expires. 0 when not locked. */
  retryAfter: number;
}

/**
 * Reads the current lock state without recording anything.
 *
 * Called before the password is verified, so a locked account costs one
 * indexed lookup rather than a scrypt hash — which also means a flood
 * against a locked account cannot be used to burn CPU.
 */
export async function checkLock(
  db: Db,
  email: string,
  now: number = Date.now(),
): Promise<LockState> {
  const doc = await db.collection("loginAttempts").findOne({ key: normaliseKey(email) });
  const lockedUntil = doc?.lockedUntil as number | undefined;

  if (lockedUntil === undefined || lockedUntil <= now) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
}

/**
 * Records one failed attempt and returns the resulting state.
 *
 * The read-modify-write here is not atomic, and that is a considered
 * trade rather than an oversight: two simultaneous failures can race and
 * record one increment instead of two. The cost of losing an occasional
 * count is one extra guess out of ten; the cost of the alternative — a
 * transaction on every failed login — is a write amplification on the exact
 * path an attacker floods. An attacker can also only lose counts by
 * limiting their own parallelism, which is not an advantage worth
 * engineering against.
 */
export async function recordFailure(
  db: Db,
  email: string,
  policy: ThrottlePolicy,
  now: number = Date.now(),
): Promise<LockState> {
  const key = normaliseKey(email);
  const doc = await db.collection("loginAttempts").findOne({ key });

  // A stale run of failures is forgotten rather than resumed: the count
  // only means "consecutive failures, recently", so an old typo must not
  // combine with today's to produce a lockout.
  const lastAttemptAt = (doc?.lastAttemptAt as number | undefined) ?? 0;
  const previous = doc && now - lastAttemptAt <= policy.attemptWindowMs ? ((doc.attempts as number) ?? 0) : 0;
  const attempts = previous + 1;

  const locked = attempts >= policy.maxAttempts;
  const lockedUntil = locked ? now + policy.lockoutMs : undefined;

  await db.collection("loginAttempts").updateOne(
    { key },
    {
      $set: {
        attempts,
        lastAttemptAt: now,
        // Cleared explicitly when not locking, so a fresh run of failures
        // after an expired lock does not inherit the old timestamp.
        lockedUntil: lockedUntil ?? null,
        // Feeds the TTL index, so a counter nobody returns to is reaped by
        // the database instead of accumulating one document per address
        // ever attempted — which, under a spraying attack, is otherwise
        // unbounded growth driven entirely by the attacker.
        //
        // Dated from the later of the two deadlines: reaping a document
        // while its lock is still in force would end the lockout early,
        // turning garbage collection into a bypass.
        expiresAt: new Date(Math.max(now + policy.attemptWindowMs, lockedUntil ?? 0)),
      },
    },
    { upsert: true },
  );

  if (!locked) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil(policy.lockoutMs / 1000) };
}

/**
 * Clears the counter after a successful login.
 *
 * Only a *successful* login clears it. Resetting on any attempt would let
 * an attacker who knows one valid account keep another account's counter at
 * zero, and resetting on a lockout expiry would give an attacker a fresh
 * full allowance every window instead of a slow drip.
 */
export async function clearFailures(db: Db, email: string): Promise<void> {
  // Reset in place rather than deleted: the document is about to be
  // recreated on the next failure anyway, and a delete/insert cycle on a
  // hot path churns the index for nothing. `updateOne` without `upsert`
  // also means a successful first-ever login writes nothing at all.
  await db
    .collection("loginAttempts")
    .updateOne({ key: normaliseKey(email) }, { $set: { attempts: 0, lockedUntil: null } });
}
