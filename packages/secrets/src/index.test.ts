import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MalformedEncryptedValueError,
  MissingEncryptionKeyError,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  secretsEqual,
} from "./index.js";

/**
 * What these tests cannot establish, stated because every suite here that
 * has a blind spot says so:
 *
 *   - **They do not establish that AES-256-GCM is correctly implemented.**
 *     That is Node's `crypto`, and re-testing it would be testing OpenSSL.
 *     What is tested is that this module *uses* it correctly — that the
 *     auth tag is actually verified, that the IV varies, and that a key is
 *     required.
 *   - **They do not establish that the key is stored safely.** It comes
 *     from an environment variable by design (see the module comment), and
 *     no test can assert on a deployment's secret handling. That remains
 *     TODO item 4.
 *   - **A passing round-trip says nothing about ciphertext quality.** The
 *     `randomBytes` IV is trusted, exactly as the RNG package's own tests
 *     established a predictable seed and a secure one produce
 *     indistinguishable output (TODO A2).
 */

const VALID_KEY = "a".repeat(64);

beforeEach(() => {
  process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
});

describe("encryptSecret / decryptSecret", () => {
  it("returns the original secret after a round trip", () => {
    const plaintext = "operator-api-secret-9f2c";
    const encrypted = encryptSecret(plaintext);

    assert.notEqual(encrypted, plaintext, "the stored form must not be the plaintext");
    assert.equal(isEncrypted(encrypted), true);
    assert.equal(decryptSecret(encrypted), plaintext);
  });

  it("produces different ciphertext each time, so a repeated secret is not detectable in the database", () => {
    // Two operators choosing the same secret, or one secret re-encrypted
    // during a migration, must not produce identical rows — that would leak
    // the fact that they match to anyone who can read the collection.
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");

    assert.notEqual(a, b, "a fixed IV would make these equal");
    assert.equal(decryptSecret(a), "same-value");
    assert.equal(decryptSecret(b), "same-value");
  });

  it("round-trips a secret containing multi-byte characters without corrupting it", () => {
    // utf8 in, utf8 out. A latin1 default anywhere in the pair truncates
    // these to mojibake, and the failure would first appear as an operator
    // whose signature never verifies.
    const plaintext = "sécret-ключ-密鑰-🔐";
    assert.equal(decryptSecret(encryptSecret(plaintext)), plaintext);
  });

  it("round-trips an empty secret rather than treating it as absent", () => {
    // Not an endorsement of empty secrets — the operator routes reject
    // those. This pins that the crypto layer stays total, so an empty value
    // fails validation where validation lives, not with an opaque cipher
    // error from three layers down.
    assert.equal(decryptSecret(encryptSecret("")), "");
  });

  it("refuses a tampered ciphertext instead of returning altered plaintext", () => {
    const encrypted = encryptSecret("do-not-tamper");

    // Flip the final character to something guaranteed to differ. Writing a
    // fixed "0" here is a no-op whenever the last nibble is already zero —
    // a test that silently passes about 1 time in 16 without testing
    // anything, which the reference repo hit and fixed.
    const last = encrypted.slice(-1);
    const flipped = last === "0" ? "1" : "0";

    assert.throws(() => decryptSecret(encrypted.slice(0, -1) + flipped));
  });

  it("refuses a ciphertext whose auth tag was swapped for another valid one", () => {
    // A sharper case than flipping a bit: both parts are individually
    // well-formed, and only the *binding* between them is broken. This is
    // what GCM buys over CBC, so it is worth asserting directly.
    const a = encryptSecret("value-a");
    const b = encryptSecret("value-b");
    const [, ivA, , ctA] = ["", ...a.slice(4).split(":")] as string[];
    const tagB = b.slice(4).split(":")[1]!;

    assert.throws(() => decryptSecret(`enc:${ivA}:${tagB}:${ctA}`));
  });

  it("refuses a plaintext value rather than silently passing it through", () => {
    // The dangerous alternative is returning the input unchanged: a
    // half-migrated collection would then "work", and the unencrypted rows
    // would never be noticed.
    assert.throws(() => decryptSecret("plain-old-string"), MalformedEncryptedValueError);
  });

  it("names the shape when the encrypted value has the wrong number of parts", () => {
    assert.throws(() => decryptSecret("enc:onlyonepart"), MalformedEncryptedValueError);
    assert.throws(() => decryptSecret("enc:aa:bb:cc:dd"), MalformedEncryptedValueError);
  });

  it("rejects a truncated IV rather than passing a short buffer to the cipher", () => {
    // `Buffer.from(hex)` truncates rather than throwing, so without an
    // explicit length check this surfaces as an OpenSSL error that names
    // neither the field nor the row it came from.
    const encrypted = encryptSecret("x");
    const [, tag, ct] = encrypted.slice(4).split(":") as [string, string, string];

    assert.throws(() => decryptSecret(`enc:aabb:${tag}:${ct}`), MalformedEncryptedValueError);
  });
});

describe("the encryption key", () => {
  it("refuses to encrypt when no key is configured", () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    assert.throws(() => encryptSecret("x"), MissingEncryptionKeyError);
  });

  it("refuses to decrypt when no key is configured", () => {
    const encrypted = encryptSecret("x");
    delete process.env.SECRETS_ENCRYPTION_KEY;
    assert.throws(() => decryptSecret(encrypted), MissingEncryptionKeyError);
  });

  it("refuses a key of the wrong length", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "abcd";
    assert.throws(() => encryptSecret("x"), MissingEncryptionKeyError);
  });

  it("refuses a key containing non-hex characters instead of silently truncating it", () => {
    // 64 characters, so a length check alone passes — but `Buffer.from`
    // stops at the 'z', yielding a 1-byte key. Refusing here is what turns
    // a typo into a boot failure rather than a weak key nobody can see.
    process.env.SECRETS_ENCRYPTION_KEY = `aaz${"a".repeat(61)}`;
    assert.throws(() => encryptSecret("x"), MissingEncryptionKeyError);
  });

  it("refuses a non-hex key that would still truncate to exactly 32 valid bytes", () => {
    // The case the test above does NOT cover, found by mutation testing:
    // removing the hex check left that test passing, because its typo sits
    // early enough that truncation yields 1 byte and the *length* check
    // refuses it. So the hex check was unverified — the length check was
    // doing all the work.
    //
    // Here the first 64 characters are valid hex, so truncation stops at
    // the 'z' having already produced a full 32 bytes. The length check is
    // satisfied and only the hex check can refuse it. Without that check
    // the key silently becomes the 32-byte prefix, and the trailing
    // characters — which someone believed were part of their key — are
    // discarded with no error anywhere.
    const key = `${"a".repeat(64)}zzbbbb`;
    assert.equal(Buffer.from(key, "hex").length, 32, "the premise: this key defeats a length-only check");

    process.env.SECRETS_ENCRYPTION_KEY = key;
    assert.throws(() => encryptSecret("x"), MissingEncryptionKeyError);
  });

  it("cannot decrypt a value encrypted under a different key", () => {
    // This is the property that makes key rotation a real operation: after
    // rotating, old rows must fail loudly rather than decrypt to garbage.
    const encrypted = encryptSecret("rotate-me");
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("hex");

    assert.throws(() => decryptSecret(encrypted));
  });

  it("reads the key at call time, not at module load", () => {
    // Pins the deliberate non-caching decision in loadKey(). If the key
    // were captured at import, this second key would be ignored and the
    // value would round-trip — so this test failing is the signal that
    // someone added a cache.
    const keyTwo = randomBytes(32).toString("hex");
    process.env.SECRETS_ENCRYPTION_KEY = keyTwo;
    const underTwo = encryptSecret("late-bound");

    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
    assert.throws(() => decryptSecret(underTwo), "the first key must not still be in effect");

    process.env.SECRETS_ENCRYPTION_KEY = keyTwo;
    assert.equal(decryptSecret(underTwo), "late-bound");
  });
});

describe("isEncrypted", () => {
  it("tells an encrypted value from a plaintext one, which is what makes a migration possible", () => {
    assert.equal(isEncrypted(encryptSecret("x")), true);
    assert.equal(isEncrypted("x"), false);
    assert.equal(isEncrypted(""), false);
  });
});

describe("secretsEqual", () => {
  it("matches identical secrets and rejects different ones", () => {
    assert.equal(secretsEqual("abc", "abc"), true);
    assert.equal(secretsEqual("abc", "abd"), false);
  });

  it("returns false for different lengths rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch. Letting that propagate
    // would turn an ordinary wrong-credential check into a 500.
    assert.equal(secretsEqual("short", "much-longer-value"), false);
  });
});
