/**
 * An operator is the customer of this platform: the casino or aggregator
 * whose players actually spin. Every row of money in the system is keyed by
 * `operatorId`, so this is the type that gives that key a referent — until
 * now `operatorId` appeared on rounds, transactions, players and bonus
 * sessions as a string that nothing in the codebase ever defined or issued.
 */

/**
 * Which side calls which.
 *
 * `"direct"` — the operator calls us. They hold the player's wallet
 * balance with us, cash in and out over the integration API, and we are the
 * system of record for the money in play. This is the only mode
 * implemented.
 *
 * `"reverse"` — we call the operator's wallet for every debit and credit,
 * and they remain the system of record. Deliberately unimplemented: it
 * cannot be built against a guess, because each aggregator's wallet API
 * differs in the details that matter (idempotency key placement, rollback
 * semantics, whether a failed credit is retryable). The field exists so
 * that adding it later is a new branch rather than a schema migration on a
 * live collection.
 */
export type IntegrationType = "direct" | "reverse";

export interface Operator {
  operatorId: string;
  name: string;
  integrationType: IntegrationType;
  /**
   * The public half of the credential pair, sent in the clear as the
   * `X-Api-Key-Id` header. It names which secret to verify against; it
   * proves nothing on its own.
   */
  apiKeyId: string;
  /**
   * The shared HMAC secret — used to *sign* on the operator's side and to
   * *verify* on ours, which is precisely why it cannot be a one-way hash
   * the way `users.passwordHash` is. Verification needs the original bytes
   * back.
   *
   * **Stored encrypted**, never plaintext: this field always holds the
   * `enc:` form produced by `@slots-engine/secrets`. Read it through
   * `findOperatorByKeyId`, which decrypts on the way out, rather than
   * touching the collection directly — a raw `findOne` hands back
   * ciphertext that will silently fail every signature check.
   */
  apiSecret: string;
  /**
   * Entitlement: which games this operator may launch. Checked at token
   * issuance rather than at play time, so a token that exists at all is one
   * already known-valid for its operator/game pair.
   *
   * An empty array is meaningful and is the safe default — a newly created
   * operator can launch nothing until someone says otherwise.
   */
  enabledGameIds: string[];
  /**
   * ISO-8601. A string rather than a BSON date to match `Round.createdAt`
   * and the rest of the collections here; the only real dates in this
   * schema are the ones a TTL index reaps, because a TTL index requires
   * one.
   */
  createdAt: string;
  /** Set when the operator is suspended. A disabled operator authenticates
   * successfully and is then refused, which keeps "wrong credentials" and
   * "credentials withdrawn" distinguishable in the logs. */
  disabledAt?: string;
}
