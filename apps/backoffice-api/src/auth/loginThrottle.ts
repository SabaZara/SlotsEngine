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
  /** How long the FIRST lockout lasts, in milliseconds. Each consecutive
   * lockout doubles this — see `lockoutDurationMs`. */
  lockoutMs: number;
  /** Ceiling on the doubling, in milliseconds. Without one, an attacker
   * willing to keep failing could push a legitimate user's wait to weeks —
   * turning a mitigation for the denial-of-service lever into a better
   * version of the lever. */
  maxLockoutMs: number;
  /** Idle time after which the failure count is forgotten, in
   * milliseconds. Without this a handful of typos spread over months would
   * eventually lock a legitimate user out. */
  attemptWindowMs: number;
}

export function loadThrottlePolicy(env: NodeJS.ProcessEnv = process.env): ThrottlePolicy {
  return {
    maxAttempts: Number(env.LOGIN_MAX_ATTEMPTS ?? 10),
    lockoutMs: Number(env.LOGIN_LOCKOUT_MINUTES ?? 15) * 60_000,
    maxLockoutMs: Number(env.LOGIN_MAX_LOCKOUT_MINUTES ?? 120) * 60_000,
    attemptWindowMs: Number(env.LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15) * 60_000,
  };
}

/**
 * How long the `n`th consecutive lockout lasts: `lockoutMs * 2^(n-1)`,
 * capped at `maxLockoutMs`.
 *
 * The point of the doubling is the asymmetry between the two people it
 * affects. A legitimate user who mistypes their password ten times hits
 * lockout #1 and waits the base fifteen minutes — unchanged from before.
 * An attacker grinding the same account is spending exponentially more
 * wall-clock time per allowance of guesses, so the sustainable guessing
 * rate collapses.
 *
 * The cap exists because this cuts both ways: the item this addresses
 * (docs/TODO.md #3) is that anyone who knows an administrator's email can
 * keep that account locked deliberately. Uncapped doubling would let them
 * push the wait to weeks, which is a *worse* denial of service than the flat
 * window it replaced. Two hours is the ceiling — long enough that grinding
 * is pointless, short enough that a targeted user recovers the same day
 * without anyone's intervention.
 *
 * `consecutiveLockouts` is only ever reset by a SUCCESSFUL login, for the
 * same reason the attempt counter is: clearing it on expiry would hand an
 * attacker a fresh full allowance every window.
 */
export function lockoutDurationMs(policy: ThrottlePolicy, consecutiveLockouts: number): number {
  // A policy without a cap means "do not cap", not "produce NaN".
  // `Math.min(x, undefined)` is NaN, which would sail through as a
  // `lockedUntil` of NaN — and `NaN <= now` is false, so an account would
  // be locked *forever* with no way to observe why. Caught by an existing
  // test constructing a policy literal, which is exactly the shape a caller
  // outside this module would write.
  const cap = Number.isFinite(policy.maxLockoutMs) ? policy.maxLockoutMs : Number.POSITIVE_INFINITY;
  const doublings = Math.max(0, consecutiveLockouts - 1);

  // Guarded before the multiply rather than after: 2^1024 is Infinity, and
  // Infinity against a finite cap happens to give the right answer, but an
  // uncapped policy would then return Infinity as a duration.
  if (doublings > 40) return Number.isFinite(cap) ? cap : policy.lockoutMs;

  return Math.min(policy.lockoutMs * 2 ** doublings, cap);
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

  // The attempt count restarts the moment a lock is applied, so the next
  // lockout needs another full run of `maxAttempts` failures to arrive.
  //
  // Without this the count climbs past the threshold and EVERY subsequent
  // failure satisfies `attempts >= maxAttempts` — so a single uninterrupted
  // burst escalates the backoff once per attempt rather than once per
  // lockout, and an attacker reaches the cap without ever waiting out a
  // single lock. Found by tracing the stored document across four failures
  // and seeing `consecutiveLockouts` reach 3 while the account had only
  // genuinely locked twice.
  const nextAttempts = locked ? 0 : attempts;

  // Counts how many times this account has been locked WITHOUT a successful
  // login in between, which is what makes the backoff exponential. Carried
  // on the document rather than derived, because "how many times has this
  // happened before" is not recoverable from a count that resets.
  //
  // Note this is deliberately NOT aged out by `attemptWindowMs` the way the
  // attempt count is. A patient attacker who waits out each lock and starts
  // again is exactly the case backoff exists to slow; forgetting the history
  // between windows would reset them to a fifteen-minute penalty forever.
  // The TTL on `expiresAt` still reaps the document once nobody returns to
  // it at all.
  const previousLockouts = (doc?.consecutiveLockouts as number | undefined) ?? 0;
  const consecutiveLockouts = locked ? previousLockouts + 1 : previousLockouts;
  const thisLockoutMs = lockoutDurationMs(policy, consecutiveLockouts);
  const lockedUntil = locked ? now + thisLockoutMs : undefined;

  await db.collection("loginAttempts").updateOne(
    { key },
    {
      $set: {
        attempts: nextAttempts,
        consecutiveLockouts,
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
  return { locked: true, retryAfter: Math.ceil(thisLockoutMs / 1000) };
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
  // `consecutiveLockouts` is reset here and NOWHERE else. That is what makes
  // the exponential backoff forgiving to the right person: the legitimate
  // owner proving they know the password wipes the history, while an
  // attacker who never succeeds keeps climbing the curve.
  await db
    .collection("loginAttempts")
    .updateOne(
      { key: normaliseKey(email) },
      { $set: { attempts: 0, consecutiveLockouts: 0, lockedUntil: null } },
    );
}
