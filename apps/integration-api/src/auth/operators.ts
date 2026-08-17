import type { Db } from "mongodb";
import type { Operator } from "@slots-engine/shared-types";
import { decryptSecret, isEncrypted } from "@slots-engine/secrets";

export class OperatorSecretNotEncryptedError extends Error {}

/**
 * The single read path for operator credentials.
 *
 * Everything that needs an `apiSecret` goes through here rather than
 * touching the collection, because the stored value is ciphertext: a raw
 * `findOne` hands back an `enc:` string that will fail every signature
 * check, and the symptom — "this operator's requests are all rejected" —
 * points at the operator rather than at the code.
 */
export async function findOperatorByKeyId(db: Db, apiKeyId: string): Promise<Operator | null> {
  const doc = await db.collection("operators").findOne({ apiKeyId });
  if (!doc) return null;

  const { _id, ...operator } = doc;
  const stored = operator.apiSecret as unknown;

  /**
   * A plaintext secret here is refused rather than used.
   *
   * The tempting alternative is to accept it — "if it isn't encrypted,
   * it's already the secret" — which would make a half-migrated collection
   * keep working. That is exactly why it is wrong: the rows that never got
   * encrypted would go on authenticating successfully and nothing would
   * ever report them. The failure has to be loud, and it has to be at the
   * point of use, because there is no other moment when anyone looks.
   *
   * This is refused as a 401 by the caller, not a 500: from the operator's
   * side the credential genuinely does not work, and the detail belongs in
   * our logs rather than in their error body.
   */
  if (typeof stored !== "string" || !isEncrypted(stored)) {
    throw new OperatorSecretNotEncryptedError(
      `operator ${String(operator.operatorId)} has an apiSecret that is not encrypted — ` +
        "it must be re-issued through the backoffice rather than read as-is",
    );
  }

  return { ...operator, apiSecret: decryptSecret(stored) } as unknown as Operator;
}
