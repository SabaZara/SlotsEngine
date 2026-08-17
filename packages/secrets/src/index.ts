import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * At-rest encryption for values that must come back out in plaintext.
 *
 * The distinction from password handling is the whole reason this package
 * exists, and it is worth stating because getting it backwards is a
 * plausible mistake: a password is only ever *compared*, so it should be
 * hashed one-way and can never be recovered. An operator's `apiSecret` is
 * used to **recompute an HMAC**, so verification needs the original bytes
 * back. Hashing it would make the integration API unable to authenticate
 * anyone. Encryption is therefore the correct tool here and the wrong tool
 * for `users.passwordHash` — which is why that field is hashed and this one
 * is not, in the same database.
 *
 * **What this does and does not buy.** The key lives in
 * `SECRETS_ENCRYPTION_KEY`, an environment variable, not a KMS or an HSM.
 * That raises the bar from "read the database, get every operator's secret"
 * to "read the database *and* the process environment" — a real
 * improvement, since a Mongo backup, a misconfigured port or a dumped
 * collection is a much likelier exposure than either alone. It is not the
 * end state, and it does not close TODO item 4: it adds a fourth secret to
 * the set that wants a managed store, rather than removing one.
 *
 * AES-256-GCM rather than AES-256-CBC because GCM is authenticated: a
 * tampered ciphertext fails to decrypt instead of decrypting to garbage
 * that then gets used as an HMAC key. With CBC, a flipped bit in the
 * database would silently become a signature mismatch, and the operator
 * would be told their credentials were wrong when in fact their row was
 * corrupt. See TODO F-row rationale on preferring a loud failure.
 */
const ALGORITHM = "aes-256-gcm";
const ENCRYPTED_PREFIX = "enc:";

/** 96 bits is the GCM-recommended IV size — larger IVs are re-hashed
 * internally by the construction, so a bigger one buys nothing and costs
 * interoperability. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {}
export class MalformedEncryptedValueError extends Error {}

/**
 * Read on every call rather than cached at module load.
 *
 * A cache would be faster and is the obvious refactor, so the reason not to
 * is recorded here: this package is imported by `backoffice-api` (which
 * writes operator secrets) and `integration-api` (which reads them), and
 * caching the key at import time makes the value depend on *when the module
 * was first evaluated* rather than on the environment. That difference is
 * invisible in production and lethal in tests, where a suite that sets the
 * key in a `before()` hook would silently encrypt under a key captured
 * before the hook ran. The cost is a hex parse per operation on a path that
 * already does an AES operation and a database round trip.
 */
function loadKey(): Buffer {
  const hex = process.env.SECRETS_ENCRYPTION_KEY;
  if (!hex) {
    throw new MissingEncryptionKeyError(
      "SECRETS_ENCRYPTION_KEY is not set — required to encrypt and decrypt operator secrets. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // `Buffer.from(hex, "hex")` stops at the first non-hex character and
  // returns a SHORT buffer rather than throwing, so a key with a typo in
  // the middle silently becomes a different, shorter key. Checked
  // explicitly because the length check below would then report a
  // misleading byte count and send someone looking for the wrong problem.
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new MissingEncryptionKeyError("SECRETS_ENCRYPTION_KEY must be hex characters only.");
  }

  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new MissingEncryptionKeyError(
      `SECRETS_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${key.length}.`,
    );
  }
  return key;
}

/**
 * Returns `enc:<iv>:<authTag>:<ciphertext>`, every part hex.
 *
 * The prefix is not decoration: it is what lets `isEncrypted` distinguish a
 * value this function produced from a plaintext secret written by an older
 * code path or a manual database edit. Without it, a migration cannot tell
 * which rows still need encrypting, and would either double-encrypt or skip.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export function decryptSecret(encrypted: string): string {
  if (!isEncrypted(encrypted)) {
    throw new MalformedEncryptedValueError(
      "decryptSecret() called on a value that is not in the expected 'enc:<iv>:<authTag>:<ciphertext>' format. " +
        "A plaintext value here means a row predates encryption — migrate it rather than decrypting it.",
    );
  }

  const parts = encrypted.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new MalformedEncryptedValueError("malformed encrypted value — expected exactly three ':'-separated parts.");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];

  // Sizes are checked before handing anything to `createDecipheriv`.
  // `Buffer.from(…, "hex")` truncates silently on bad input (see loadKey),
  // so a corrupted IV would otherwise arrive as a short buffer and surface
  // as an opaque OpenSSL error naming neither the field nor the row.
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new MalformedEncryptedValueError("malformed encrypted value — IV or auth tag is not the expected length.");
  }

  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // `final()` is what verifies the tag, so it must not be skipped — a
  // decrypt that only calls `update()` returns plaintext for a tampered
  // ciphertext and never checks anything.
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Constant-time equality for two secrets.
 *
 * Lives here rather than in the integration API because the integration API
 * compares *signatures*, not secrets — this is for the narrower case of
 * checking a presented secret against a stored one (operator credential
 * rotation, and the backoffice's "is this the same value" check), where a
 * naive `===` leaks the shared prefix length through timing.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch rather than returning
  // false, and the lengths themselves are not secret.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
