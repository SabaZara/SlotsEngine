/**
 * WebSocket origin checking.
 *
 * The HTTP services state their browser-reachable surface explicitly and
 * never with `*` (see the `cors` registration in game-backend). The socket
 * took the opposite position by omission: `WebSocketServer` with no
 * `verifyClient` accepts a handshake from a page on any domain.
 *
 * **This is defence in depth, not authentication.** A socket that connects
 * still proves nothing about who it is; identity comes from a signed launch
 * token at JOIN, and that has always been true. What an origin check buys
 * is that a page on `evil.example` cannot open a socket in a logged-in
 * player's browser and sit there attempting messages — it is refused at the
 * handshake, before a connection object, a limiter or a session map entry
 * exists. The cost is one string comparison; the layer is worth having.
 *
 * ## Why a missing Origin is allowed
 *
 * Only browsers send `Origin` on a WebSocket handshake, and they set it
 * themselves — a page cannot forge it, which is the entire reason the check
 * is worth anything. Non-browser clients (`ws` from Node, the e2e scripts,
 * a load test, curl) send no `Origin` at all.
 *
 * So a missing header cannot be treated as a failure: it would refuse every
 * legitimate server-side client while stopping no attacker, since anything
 * that can omit the header can also set it to whatever it likes. An origin
 * check constrains *browsers*, which are exactly the clients that cannot
 * lie about it. Refusing a blank Origin would be security theatre that
 * breaks the test suite — the appearance of a stricter rule with none of
 * the effect.
 */

export interface OriginPolicy {
  /** Exact origins a browser may connect from. Empty means allow any. */
  allowed: string[];
  /** When true, an empty allowlist is a configuration error rather than
   * "allow any" — set in production. */
  requireAllowlist: boolean;
}

/**
 * Reads the policy from the environment.
 *
 * Defaults to the game frontend's dev origin, matching `GAME_CORS_ORIGINS`
 * in game-backend so the two surfaces are configured the same way rather
 * than each inventing a convention.
 */
export function loadOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const raw = env.SOCKET_ALLOWED_ORIGINS ?? env.GAME_CORS_ORIGINS ?? "http://localhost:9104";
  return {
    allowed: raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    requireAllowlist: env.NODE_ENV === "production",
  };
}

/**
 * Boot-time refusal, in the same spirit as game-backend's startup guards:
 * a promise to configure the allowlist in production becomes a process that
 * will not start without one.
 *
 * The wildcard is refused outright rather than honoured. Someone reaching
 * for `*` here is copying a CORS idiom that does not apply — a socket has
 * no preflight and no browser-enforced read restriction, so `*` is not a
 * relaxation of a check, it is the absence of one, and it should be spelled
 * that way (by leaving the variable unset outside production) rather than
 * looking like a configured policy.
 */
export function assertOriginPolicy(policy: OriginPolicy): void {
  if (policy.allowed.includes("*")) {
    throw new Error(
      "game-socket refusing to start:\n  - SOCKET_ALLOWED_ORIGINS must not be '*'. List the origins the game client is served from.",
    );
  }
  if (policy.requireAllowlist && policy.allowed.length === 0) {
    throw new Error(
      "game-socket refusing to start:\n  - SOCKET_ALLOWED_ORIGINS must be set explicitly in production.",
    );
  }
}

/**
 * The handshake decision.
 *
 * Comparison is exact, and deliberately so. Suffix matching is the usual
 * shortcut and the usual hole: `endsWith("example.com")` also accepts
 * `notexample.com`, and an attacker registers that domain in an afternoon.
 * An origin is a small closed set of known strings, so there is no reason
 * to pattern-match at all.
 *
 * Case is normalised on scheme and host only. Origins have no path, and the
 * host is case-insensitive per RFC 6454 — but lowercasing the whole header
 * blindly is wrong in principle, so the value is parsed and rebuilt rather
 * than string-mangled. A header that will not parse as a URL is refused: a
 * browser never sends one, so it is either a malformed client or someone
 * probing the comparison.
 */
export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  // No Origin: a non-browser client. See the note at the top of this file.
  if (origin === undefined || origin === "") return true;

  // No allowlist configured, outside production: allow any. Production
  // cannot reach here — `assertOriginPolicy` refuses to boot instead.
  if (policy.allowed.length === 0) return true;

  const normalised = normaliseOrigin(origin);
  if (normalised === null) return false;

  return policy.allowed.some((candidate) => normaliseOrigin(candidate) === normalised);
}

/** `scheme://host[:port]`, lowercased where the spec says it is
 * case-insensitive. Returns null for anything that is not a usable origin. */
function normaliseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // `null` is what a browser sends for a sandboxed or file:// document —
  // it parses as nothing useful and must never match an entry.
  if (!url.protocol || !url.host) return null;
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
}
