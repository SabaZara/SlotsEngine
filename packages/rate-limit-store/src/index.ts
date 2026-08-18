// Named import, not default. ioredis ships CommonJS, and under
// `moduleResolution: NodeNext` its default export resolves to the module
// namespace rather than the class — so `new Redis(...)` fails to compile
// with "has no construct signatures". The named export is the class.
import { Redis } from "ioredis";

/**
 * The shared counter store the HTTP rate limiters use.
 *
 * **Why this exists.** Every limiter counted in its own process memory, so
 * two instances behind a load balancer meant an effective ceiling of double
 * the configured value, and a restart cleared every counter. That is fine
 * on one instance and wrong the moment there are two — and it is what
 * blocked zero-downtime deploys, since those run two instances of a service
 * at once by definition.
 *
 * **One module rather than three copies.** Three services register
 * `@fastify/rate-limit`, and the ioredis options below are not defaults —
 * getting them wrong in one service and right in the other two is exactly
 * the drift this repo keeps meeting. The connection policy is a decision,
 * so it lives in one place.
 *
 * What this deliberately does **not** cover:
 *
 * - **The login throttle**, which is already in Mongo. It must survive a
 *   restart — a lockout that clears when a process bounces is a lockout an
 *   attacker can trigger themselves — so a volatile store would be a
 *   regression, not an improvement.
 * - **The socket's token buckets**, which are per-*connection*. A
 *   connection lives on exactly one instance, so per-process state is
 *   correct there by construction, not by oversight.
 */

/** Bounded so a limiter check cannot become the slowest thing in a request.
 *
 * Both values are deliberate and neither is an ioredis default: the default
 * `maxRetriesPerRequest` is 20 and the default `connectTimeout` is 10s, so
 * a Redis that is merely slow would stall every request behind twenty
 * retries. The plugin's own example recommends exactly this pair, and the
 * reasoning is that a rate limiter is a guard, not a dependency — it should
 * fail fast and get out of the way. */
const CONNECT_TIMEOUT_MS = 500;
const MAX_RETRIES_PER_REQUEST = 1;

export interface RateLimitStore {
  /** Passed straight to `@fastify/rate-limit` as its `redis` option. */
  redis: Redis;
  close(): Promise<void>;
}

/**
 * Builds the store from `REDIS_URL`, or returns `undefined` when it is
 * unset.
 *
 * **Absent is a supported configuration, not an error.** A single-instance
 * deployment and every local `npm test` run have no Redis, and the plugin
 * falls back to its in-memory store — which is correct for one process. So
 * this returns `undefined` rather than throwing, and the caller passes it
 * through unchanged.
 *
 * The alternative — requiring Redis everywhere — would mean a developer
 * cannot run a service without standing up another container, and the
 * failure would be at boot with a connection error rather than anything
 * about rate limiting.
 */
export function createRateLimitStore(url = process.env.REDIS_URL): RateLimitStore | undefined {
  if (!url) return undefined;

  const redis = new Redis(url, {
    connectionName: "rate-limit",
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    // **Left at ioredis's default (`true`), deliberately, after measuring.**
    //
    // Disabling it is the tempting choice and it is wrong here. The
    // argument for `false` is that a limiter should not replay stale
    // counter writes against a window that has already moved on. The
    // argument against is decisive: ioredis connects *asynchronously*, so
    // every command issued between construction and `ready` is rejected
    // outright with "Stream isn't writeable and enableOfflineQueue options
    // is false". A service registers the limiter at boot and starts taking
    // requests immediately, so the first ones land in exactly that window
    // — and with `skipOnError: true` the plugin swallows the rejection and
    // counts in memory instead. The result is a limiter that reports
    // healthy and silently is not shared, which is the failure this whole
    // package exists to remove.
    //
    // Observed, not reasoned: with `false`, a `set` issued straight after
    // construction throws that error every time, and Redis ends a full
    // rate-limit run holding zero keys.
    //
    // The stale-replay concern is real but much smaller: the queue only
    // holds commands from a brief disconnect, and `@fastify/rate-limit`'s
    // keys carry their own TTL, so a replayed increment lands on a key that
    // expires on schedule regardless.
    // Retry with a bounded backoff rather than ioredis's unbounded default,
    // so a Redis that is down does not have every service reconnecting on
    // an ever-lengthening delay by the time it comes back.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
  });

  // A limiter must never be the reason a service dies. ioredis emits
  // `error` on every failed reconnect, and an unhandled `error` on an
  // EventEmitter is a process-level crash — so a Redis outage would take
  // down the money path rather than degrade the guard in front of it.
  redis.on("error", () => {});

  return {
    redis,
    close: async () => {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
