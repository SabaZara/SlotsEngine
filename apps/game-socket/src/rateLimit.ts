/**
 * Per-connection message rate limiting.
 *
 * The HTTP services use `@fastify/rate-limit`; a WebSocket has no request
 * cycle to hang that off, so the equivalent is done here. Without it a
 * single socket can send messages as fast as it can write them, and every
 * SPIN_REQUEST is a database transaction — the cheapest possible way to
 * make one client expensive for everyone.
 *
 * A **token bucket**, not a fixed window. A fixed window lets a client
 * spend its whole allowance in the last instant of one window and again in
 * the first instant of the next, producing a burst of double the intended
 * rate at exactly the moment the limiter claims to be holding the line. A
 * bucket refills continuously, so the sustained rate is the real rate and
 * a burst is bounded by the bucket's size.
 *
 * Two ceilings, because the two failure modes are different: spins move
 * money and are worth a tight limit; pings and reconnect chatter are cheap
 * and only need a ceiling that stops a flood.
 */

export interface RateLimitConfig {
  /** Sustained messages per second, refilled continuously. */
  ratePerSecond: number;
  /** Maximum burst — how many tokens the bucket can hold. */
  burst: number;
}

export const DEFAULT_LIMITS: { spin: RateLimitConfig; message: RateLimitConfig } = {
  // A human spins a few times a second at most, and the client animates for
  // longer than that. 5/s sustained with a burst of 10 is far above real
  // play and far below what a script would attempt.
  spin: { ratePerSecond: Number(process.env.SOCKET_SPIN_RATE ?? 5), burst: Number(process.env.SOCKET_SPIN_BURST ?? 10) },
  // Everything else: generous, purely an anti-flood ceiling.
  message: { ratePerSecond: Number(process.env.SOCKET_MSG_RATE ?? 25), burst: Number(process.env.SOCKET_MSG_BURST ?? 50) },
};

/**
 * A single continuously-refilling bucket.
 *
 * `now` is passed in rather than read from the clock so the behaviour is a
 * pure function of time — which is what makes it testable without waiting
 * in real seconds for a refill.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly config: RateLimitConfig, now: number = Date.now()) {
    this.tokens = config.burst;
    this.lastRefill = now;
  }

  /** Takes a token if one is available. Returns false when the caller is
   * over its limit, without consuming anything. */
  tryConsume(now: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.config.burst, this.tokens + elapsedSeconds * this.config.ratePerSecond);
    this.lastRefill = now;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Seconds until at least one token is available. 0 when one already is. */
  retryAfterSeconds(now: number = Date.now()): number {
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    const projected = Math.min(this.config.burst, this.tokens + elapsedSeconds * this.config.ratePerSecond);
    if (projected >= 1) return 0;
    return Math.ceil(((1 - projected) / this.config.ratePerSecond) * 10) / 10;
  }
}

/**
 * The pair of buckets belonging to one connection.
 *
 * Held per connection rather than per player deliberately: a connection is
 * what an abuser actually controls, and it exists before JOIN — so the
 * limit applies to a client that never authenticates at all, which is the
 * one that most needs limiting.
 */
export class ConnectionLimiter {
  private readonly spins: TokenBucket;
  private readonly messages: TokenBucket;

  constructor(limits = DEFAULT_LIMITS, now: number = Date.now()) {
    this.spins = new TokenBucket(limits.spin, now);
    this.messages = new TokenBucket(limits.message, now);
  }

  /**
   * Both ceilings apply to a spin: it is a message too. Order matters —
   * the general bucket is charged first so a client cannot dodge the flood
   * limit by making every message a spin.
   */
  check(messageType: string, now: number = Date.now()): { allowed: true } | { allowed: false; retryAfter: number } {
    if (!this.messages.tryConsume(now)) {
      return { allowed: false, retryAfter: this.messages.retryAfterSeconds(now) };
    }
    if (messageType === "SPIN_REQUEST" && !this.spins.tryConsume(now)) {
      return { allowed: false, retryAfter: this.spins.retryAfterSeconds(now) };
    }
    return { allowed: true };
  }
}
