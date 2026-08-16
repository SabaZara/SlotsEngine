import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { signSession, verifySession } from "./jwt.js";

/**
 * Tests for the code that decides who is an administrator.
 *
 * `game-socket` had the same gap once — 405 lines on the identity boundary
 * with no tests (F5 in docs/TODO.md). This is the backoffice equivalent:
 * every privileged route in the admin API trusts whatever `verifySession`
 * returns, so a forged or malformed token that survives this function is a
 * complete authentication bypass.
 *
 * The cases below are therefore written as attacks rather than as usage.
 */

const SECRET = "a-test-secret-long-enough-to-pass-the-guard";

before(() => {
  process.env.BACKOFFICE_JWT_SECRET = SECRET;
});

const user = {
  userId: "u-1",
  email: "admin@example.com",
  roles: ["super_admin"] as never,
  tokenVersion: 3,
};

/** Forges a token for an arbitrary payload, signed with a chosen secret —
 * the tool an attacker actually has if a secret ever leaks, and the way to
 * test payload validation independently of signature validation. */
function forge(payload: unknown, secret = SECRET): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${createHmac("sha256", secret).update(b64).digest("base64url")}`;
}

describe("signSession / verifySession round trip", () => {
  it("returns the identity it was signed with", () => {
    const { token } = signSession(user);
    const payload = verifySession(token);

    assert.equal(payload?.userId, "u-1");
    assert.equal(payload?.email, "admin@example.com");
    assert.deepEqual(payload?.roles, ["super_admin"]);
    assert.equal(payload?.tokenVersion, 3, "the revocation snapshot must survive the round trip");
  });

  it("reports an expiry eight hours out", () => {
    const { expiresAt } = signSession(user);
    const hours = (expiresAt - Date.now()) / (60 * 60 * 1000);
    assert.ok(hours > 7.9 && hours <= 8, `expected about 8 hours, got ${hours}`);
  });
});

describe("forgery and tampering", () => {
  it("rejects a token signed with a different secret", () => {
    // The case that matters if an attacker guesses or reuses a secret from
    // somewhere else in the system.
    assert.equal(verifySession(forge({ ...user, iat: Date.now(), exp: Date.now() + 60_000 }, "a-different-secret-also-long-enough")), null);
  });

  it("rejects a payload edited after signing", () => {
    // Privilege escalation in its most direct form: take a real viewer
    // token, rewrite the roles, keep the signature.
    const { token } = signSession({ ...user, roles: ["viewer"] as never });
    const [, signature] = token.split(".");
    const escalated = Buffer.from(
      JSON.stringify({ ...user, roles: ["super_admin"], iat: Date.now(), exp: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");

    assert.equal(verifySession(`${escalated}.${signature}`), null, "a rewritten role must not survive verification");
  });

  it("rejects a token with no signature at all", () => {
    const b64 = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 60_000 }), "utf8").toString("base64url");
    assert.equal(verifySession(b64), null);
    assert.equal(verifySession(`${b64}.`), null, "an empty signature must not pass");
  });

  it("rejects a token carrying extra segments", () => {
    // A JWT-shaped three-part token must not be accepted by a two-part
    // format — the parser must be strict about its own shape.
    const { token } = signSession(user);
    assert.equal(verifySession(`${token}.extra`), null);
  });

  it("rejects malformed input without throwing", () => {
    // Every one of these reaches the verifier from a real Authorization
    // header eventually; none may produce a 500.
    for (const bad of ["", ".", "..", "not-a-token", "a.b", "%%%.%%%", "null", "undefined"]) {
      assert.equal(verifySession(bad), null, `"${bad}" must be refused, not throw`);
    }
  });

  it("rejects a payload that is valid base64 but not an object", () => {
    for (const notAnObject of ["null", '"a string"', "42", "[1,2,3]"]) {
      const b64 = Buffer.from(notAnObject, "utf8").toString("base64url");
      const token = `${b64}.${createHmac("sha256", SECRET).update(b64).digest("base64url")}`;
      assert.equal(verifySession(token), null, `${notAnObject} must not verify as a session`);
    }
  });
});

describe("payload validation — a correctly signed token still has to make sense", () => {
  const base = { ...user, iat: Date.now(), exp: Date.now() + 60_000 };

  it("rejects a missing or non-string userId", () => {
    assert.equal(verifySession(forge({ ...base, userId: undefined })), null);
    assert.equal(verifySession(forge({ ...base, userId: 42 })), null);
  });

  it("rejects a non-array roles claim", () => {
    // `roles` drives every permission check downstream; a string would
    // silently satisfy an `includes` test on a substring.
    assert.equal(verifySession(forge({ ...base, roles: "super_admin" })), null);
    assert.equal(verifySession(forge({ ...base, roles: undefined })), null);
  });

  it("rejects a non-numeric tokenVersion", () => {
    // tokenVersion is what makes revocation work. A string "0" would fail
    // the equality check against a numeric 0 and lock a user out — or, if
    // compared loosely elsewhere, let a revoked token through.
    assert.equal(verifySession(forge({ ...base, tokenVersion: "3" })), null);
    assert.equal(verifySession(forge({ ...base, tokenVersion: undefined })), null);
  });

  it("rejects a token with no expiry rather than treating it as eternal", () => {
    assert.equal(verifySession(forge({ ...base, exp: undefined })), null);
    assert.equal(verifySession(forge({ ...base, exp: "later" })), null);
  });
});

describe("expiry", () => {
  it("rejects an expired token", () => {
    assert.equal(verifySession(forge({ ...user, iat: Date.now() - 10_000, exp: Date.now() - 1_000 })), null);
  });

  it("accepts a token that has not expired yet", () => {
    assert.ok(verifySession(forge({ ...user, iat: Date.now(), exp: Date.now() + 60_000 })));
  });
});

describe("secret configuration", () => {
  it("refuses to sign without a secret, rather than defaulting to open", () => {
    const saved = process.env.BACKOFFICE_JWT_SECRET;
    try {
      delete process.env.BACKOFFICE_JWT_SECRET;
      assert.throws(() => signSession(user), /BACKOFFICE_JWT_SECRET/);
    } finally {
      process.env.BACKOFFICE_JWT_SECRET = saved;
    }
  });

  it("refuses a trivially short secret", () => {
    const saved = process.env.BACKOFFICE_JWT_SECRET;
    try {
      process.env.BACKOFFICE_JWT_SECRET = "too-short";
      assert.throws(() => signSession(user), /32 characters/);
    } finally {
      process.env.BACKOFFICE_JWT_SECRET = saved;
    }
  });

  it("verifies nothing when the secret is missing, instead of throwing at the caller", () => {
    // A misconfigured service must fail closed on the request path: every
    // token invalid, not every request a 500 that reveals the misconfig.
    const { token } = signSession(user);
    const saved = process.env.BACKOFFICE_JWT_SECRET;
    try {
      delete process.env.BACKOFFICE_JWT_SECRET;
      assert.equal(verifySession(token), null);
    } finally {
      process.env.BACKOFFICE_JWT_SECRET = saved;
    }
  });

  it("stops honouring tokens once the secret is rotated", () => {
    const { token } = signSession(user);
    const saved = process.env.BACKOFFICE_JWT_SECRET;
    try {
      process.env.BACKOFFICE_JWT_SECRET = "a-completely-different-secret-of-sufficient-length";
      assert.equal(verifySession(token), null, "rotating the secret must invalidate issued sessions");
    } finally {
      process.env.BACKOFFICE_JWT_SECRET = saved;
    }
  });
});
