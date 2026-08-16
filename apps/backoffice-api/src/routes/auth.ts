import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { toPublicUser, type User } from "@slots-engine/shared-types";
import { signSession } from "../auth/jwt.js";
import { verifyPassword } from "../auth/passwords.js";
import { findUserByEmail, revokeSessions } from "../auth/users.js";
import { checkLock, clearFailures, loadThrottlePolicy, recordFailure } from "../auth/loginThrottle.js";
import { writeAuditLog } from "../audit/log.js";

/** Deliberately identical for "no such user" and "wrong password". Telling
 * the two apart hands an attacker a free account-enumeration oracle. */
const INVALID_CREDENTIALS = { error: "invalid_credentials" };

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  const throttle = loadThrottlePolicy();

  app.post<{ Body: { email?: string; password?: string } }>("/v1/auth/login", {
    // Login gets its own, far tighter ceiling. The global limit is sized
    // for ordinary admin work and is useless here: 300 password guesses a
    // minute is a working credential-stuffing rate, not a defence.
    //
    // Keyed by IP alone, deliberately. Keying by IP *and* the attempted
    // email looks stronger — it would stop one address walking a list of
    // accounts — but it does not work: the rate limiter runs before the
    // body is parsed, so `request.body` is undefined inside keyGenerator.
    // Measured, not assumed: every attempt then lands in one shared bucket
    // and a *different* email is refused too, which turns the protection
    // into a way for one attacker to lock out every administrator.
    //
    // Per-account throttling belongs after parsing, tracked against the
    // user record rather than the request — see docs/TODO.md.
    config: {
      rateLimit: {
        max: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
        timeWindow: "5 minutes",
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) return reply.code(400).send({ error: "email and password are required" });

    // Checked BEFORE the password is verified, so a locked account costs one
    // indexed lookup instead of a scrypt hash — a flood against a locked
    // account must not become a way to burn the server's CPU.
    //
    // 429 rather than 401: the credential was never assessed, and telling a
    // client "wrong password" when we did not look is both untrue and
    // useless. A legitimate user locked out by someone else's attack needs
    // to know that waiting is the remedy.
    const lock = await checkLock(db, email);
    if (lock.locked) {
      return reply
        .code(429)
        .header("retry-after", String(lock.retryAfter))
        .send({ error: "account_locked", message: `Too many failed attempts. Try again in ${lock.retryAfter}s.` });
    }

    const user = await findUserByEmail(db, email);

    // Verify against a dummy hash when the user doesn't exist, so a missing
    // account and a wrong password take the same time. Without this, the
    // response time alone reveals which emails are registered.
    const storedHash = user?.passwordHash ?? "scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA";
    const passwordOk = await verifyPassword(password, storedHash);

    if (!user || !passwordOk || !user.active) {
      // Recorded for an unknown address too, keyed by what was attempted.
      // Tracking only real accounts would make the two observably
      // different, reopening the enumeration oracle that the identical
      // error body and the dummy-hash timing above exist to close.
      const state = await recordFailure(db, email, throttle);

      // The response is deliberately unchanged when this attempt is the one
      // that trips the lock: saying "locked" here would confirm the address
      // is worth locking. The next attempt gets the 429 — by which point
      // the attacker has learned nothing they could not have learned by
      // guessing an unknown address the same number of times.
      if (state.locked && user) {
        await writeAuditLog(
          db,
          {
            actorUserId: user.userId,
            action: "auth.account_locked",
            entityType: "user",
            entityId: user.userId,
            diff: { attempts: throttle.maxAttempts, lockoutSeconds: state.retryAfter },
          },
          (err) => request.log?.error({ err }, "failed to write lockout audit entry"),
        );
      }

      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    // Only a real success clears the counter — see the note in the module.
    await clearFailures(db, email);

    const { token, expiresAt } = signSession({
      userId: user.userId,
      email: user.email,
      roles: user.roles,
      tokenVersion: user.tokenVersion ?? 0,
    });

    await db.collection("users").updateOne({ userId: user.userId }, { $set: { lastLoginAt: new Date().toISOString() } });

    return reply.send({ token, expiresAt, user: toPublicUser(user as User) });
  });

  /** Who am I — lets a UI restore its session on reload without a second
   * login, and confirms the token still passes the revocation check. */
  app.get("/v1/auth/me", async (request, reply) => {
    const user = await findUserByEmail(db, request.user!.email);
    if (!user) return reply.code(401).send({ error: "session_revoked" });
    return reply.send({ user: toPublicUser(user) });
  });

  /**
   * Logs out everywhere by bumping `tokenVersion`, which invalidates every
   * token already issued — including ones on devices this session has no
   * knowledge of. A logout that only forgets the token client-side is not a
   * logout at all if the token has already been copied.
   */
  app.post("/v1/auth/logout", async (request, reply) => {
    await revokeSessions(db, request.user!.userId);
    await writeAuditLog(db, {
      actorUserId: request.user!.userId,
      action: "auth.logout_all",
      entityType: "user",
      entityId: request.user!.userId,
    });
    return reply.send({ loggedOut: true });
  });
}
