import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { hashPassword, verifyPassword } from "./passwords.js";

/**
 * What these tests cannot establish: that the hashing is actually *strong*.
 * They pin the format, the round trip, and the refusal behaviour — not the
 * cryptography, which is Node's scrypt and not this file's to prove. A
 * `COST` lowered to 2 would pass everything here; only the explicit cost
 * assertion below would notice, and only for newly written hashes.
 *
 * Nor do they establish constant-time comparison. `timingSafeEqual` is
 * called, which is checkable by reading; measuring timing in a test is
 * flaky and proves little on a loaded machine. Replacing it with
 * `derived.equals(expected)` survives every test here, and is a genuinely
 * equivalent mutant by observable output — the two differ only in timing.
 *
 * Two other mutants survive, both defence-in-depth guards whose removal
 * changes no output: dropping the `parts.length !== 4` check, and dropping
 * the `"scrypt"` label check. In both cases the stored digest still fails
 * to match, so the answer is `false` either way. Catching them would need a
 * fixture whose digest genuinely matches through the broken path, which is
 * not constructible for either. Recorded rather than papered over — the
 * empty-salt guard had the same shape and IS constructible, so it has a
 * real test below.
 *
 * These are slow by design — scrypt at N=2^15 is ~60ms per call, which is
 * the point of choosing it. Cases are kept few rather than exhaustive.
 */

describe("hashPassword", () => {
  it("produces the documented scrypt$N$salt$hash format", async () => {
    const stored = await hashPassword("correct-horse");
    const parts = stored.split("$");

    assert.equal(parts.length, 4);
    assert.equal(parts[0], "scrypt");
    assert.ok(parts[2].length > 0, "salt must be present");
    assert.ok(parts[3].length > 0, "hash must be present");
  });

  it("bakes the cost into each record, so it can be raised without invalidating old passwords", async () => {
    // The reason the format carries N at all. If this becomes a constant
    // read at verification time, every existing password breaks the day
    // COST changes.
    const stored = await hashPassword("correct-horse");
    assert.equal(Number(stored.split("$")[1]), 2 ** 15);
  });

  it("never stores the password itself", async () => {
    const stored = await hashPassword("correct-horse");
    assert.equal(stored.includes("correct-horse"), false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    // Without this, identical passwords are visibly identical in a stolen
    // database and one cracked hash breaks every account sharing it.
    const [a, b] = await Promise.all([hashPassword("correct-horse"), hashPassword("correct-horse")]);
    assert.notEqual(a, b);
    assert.notEqual(a.split("$")[2], b.split("$")[2], "the salts must differ");
  });

  it("uses base64url, so no segment can contain the field separator", async () => {
    // Plain base64's `+` and `/` are harmless, but padding and any `$`
    // would break `split("$")` and turn a valid hash into a parse failure.
    const stored = await hashPassword("correct-horse");
    for (const segment of stored.split("$").slice(2)) {
      assert.match(segment, /^[A-Za-z0-9_-]+$/, `segment ${segment} is not base64url`);
    }
  });
});

describe("verifyPassword", () => {
  it("accepts the password it was given", async () => {
    // Load-bearing: without it, every refusal below would pass against a
    // function that returns false unconditionally.
    const stored = await hashPassword("correct-horse");
    assert.equal(await verifyPassword("correct-horse", stored), true);
  });

  it("refuses a different password", async () => {
    const stored = await hashPassword("correct-horse");
    assert.equal(await verifyPassword("wrong-horse", stored), false);
  });

  it("refuses a password differing only in case or whitespace", async () => {
    const stored = await hashPassword("correct-horse");
    assert.equal(await verifyPassword("Correct-Horse", stored), false);
    assert.equal(await verifyPassword("correct-horse ", stored), false);
  });

  it("verifies a hash written at a lower cost than the current constant", async () => {
    // The migration property, and the reason N is stored per record: a
    // password hashed before COST was raised must still verify afterwards.
    // Built with scrypt directly, since hashPassword always uses the
    // current cost — and with a real 64-byte digest, so it exercises the
    // cost path rather than tripping the length check.
    const salt = randomBytes(16);
    const oldCost = 2 ** 14;
    const derived = (await promisify(scryptCallback)(
      "correct-horse",
      salt,
      64,
      { N: oldCost, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 } as never,
    )) as Buffer;
    const stored = `scrypt$${oldCost}$${salt.toString("base64url")}$${derived.toString("base64url")}`;

    assert.equal(await verifyPassword("correct-horse", stored), true);
    assert.equal(await verifyPassword("wrong-horse", stored), false);
  });

  describe("a malformed stored value reads as a wrong password, never as a crash", () => {
    // The docstring's promise, and it matters: this runs on the login path,
    // where a throw is an uncaught 500 that tells an attacker this
    // particular account exists and is broken. Exactly F13's shape.
    //
    // Each fixture keeps a full-length 64-byte digest and a valid salt, so
    // the named field is the ONLY thing wrong. Built with short fake
    // digests first, these all passed for the wrong reason: the length
    // check rejected them before the branch under test was reached, and
    // mutation testing showed four of these guards could be deleted with
    // the suite still green.
    const salt = randomBytes(16).toString("base64url");
    const digest = randomBytes(64).toString("base64url");

    const malformed: Record<string, string> = {
      "empty string": "",
      "no separators": "notahash",
      "too few fields": `scrypt$32768$${salt}`,
      "too many fields": `scrypt$32768$${salt}$${digest}$extra`,
      "wrong algorithm label": `bcrypt$32768$${salt}$${digest}`,
      "empty salt": `scrypt$32768$$${digest}`,
      "empty hash": `scrypt$32768$${salt}$`,
      "non-numeric cost": `scrypt$abc$${salt}$${digest}`,
      "zero cost": `scrypt$0$${salt}$${digest}`,
      "negative cost": `scrypt$-1$${salt}$${digest}`,
      "fractional cost": `scrypt$1.5$${salt}$${digest}`,
      "cost of 1": `scrypt$1$${salt}$${digest}`,
      // scrypt requires N to be a power of two and within its memory limit.
      // Both of these make Node's scrypt throw "Invalid scrypt params"
      // rather than return, so they have to be refused before the call.
      "cost that is not a power of two": `scrypt$12345$${salt}$${digest}`,
      "cost far beyond the memory limit": `scrypt$${2 ** 30}$${salt}$${digest}`,
    };

    for (const [description, stored] of Object.entries(malformed)) {
      it(`refuses ${description}`, async () => {
        assert.equal(await verifyPassword("correct-horse", stored), false);
      });
    }
  });

  it("refuses a truncated hash, even against the correct password", async () => {
    // The digest length used to be taken from the stored record, so a
    // shortened hash made scrypt derive an equally short key and the
    // comparison succeeded. Measured before the fix: against a 1-byte
    // hash, an arbitrary password verified after 274 guesses. Anyone able
    // to write to a user record could downgrade an account to
    // trivially guessable without changing the password.
    const stored = await hashPassword("correct-horse");
    const parts = stored.split("$");
    const full = Buffer.from(parts[3], "base64url");

    for (const length of [1, 2, 16, 63]) {
      const truncated = `${parts[0]}$${parts[1]}$${parts[2]}$${full
        .subarray(0, length)
        .toString("base64url")}`;
      assert.equal(
        await verifyPassword("correct-horse", truncated),
        false,
        `a ${length}-byte hash must not verify`,
      );
    }
  });

  it("refuses an empty salt even when the digest genuinely matches it", async () => {
    // The empty-salt guard is only observable with a digest actually
    // derived from an empty salt — with a random digest the comparison
    // fails anyway and the guard's removal changes nothing. Mutation
    // testing showed exactly that: deleting the check left the suite green.
    //
    // It matters because an empty salt is the one value an attacker can
    // pick in advance: it makes the hash a pure function of the password,
    // so a single precomputed table breaks every account sharing it.
    const derived = (await promisify(scryptCallback)(
      "correct-horse",
      Buffer.alloc(0),
      64,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 } as never,
    )) as Buffer;
    const stored = `scrypt$${2 ** 15}$$${derived.toString("base64url")}`;

    assert.equal(await verifyPassword("correct-horse", stored), false);
  });

  it("refuses an over-long hash", async () => {
    const stored = await hashPassword("correct-horse");
    const parts = stored.split("$");
    const padded = Buffer.concat([Buffer.from(parts[3], "base64url"), Buffer.alloc(8)]);
    const overLong = `${parts[0]}$${parts[1]}$${parts[2]}$${padded.toString("base64url")}`;
    assert.equal(await verifyPassword("correct-horse", overLong), false);
  });

  it("refuses an empty password against a real hash", async () => {
    const stored = await hashPassword("correct-horse");
    assert.equal(await verifyPassword("", stored), false);
  });

  it("round-trips a password containing the field separator", async () => {
    // `$` in a password must not be able to forge a field boundary.
    const password = "a$b$c$scrypt$1";
    const stored = await hashPassword(password);
    assert.equal(await verifyPassword(password, stored), true);
    assert.equal(await verifyPassword("a$b$c", stored), false);
  });

  it("round-trips a unicode password byte-for-byte", async () => {
    const password = "пароль-🎰-პაროლი";
    const stored = await hashPassword(password);
    assert.equal(await verifyPassword(password, stored), true);
  });
});
