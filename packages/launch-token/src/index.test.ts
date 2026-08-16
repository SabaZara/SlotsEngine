import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  ExpiredLaunchTokenError,
  InvalidLaunchTokenError,
  signLaunchToken,
  signSessionToken,
  verifyLaunchToken,
} from "./index.js";

const INPUT = { operatorId: "op-1", playerId: "player-1", gameId: "reference-5x3" };

before(() => {
  process.env.LAUNCH_TOKEN_SECRET = "test-secret-that-is-long-enough-to-be-real";
});

describe("signLaunchToken / verifyLaunchToken", () => {
  it("round-trips the identity it was signed with", () => {
    const payload = verifyLaunchToken(signLaunchToken(INPUT).token);
    assert.equal(payload.operatorId, "op-1");
    assert.equal(payload.playerId, "player-1");
    assert.equal(payload.gameId, "reference-5x3");
    assert.equal(payload.kind, "launch");
  });

  it("gives every token a distinct jti, so single-use can be tracked", () => {
    const a = signLaunchToken(INPUT);
    const b = signLaunchToken(INPUT);
    assert.notEqual(a.jti, b.jti);
  });

  it("rejects a tampered payload", () => {
    // The whole point: a player must not be able to rewrite who they are.
    const { token } = signLaunchToken(INPUT);
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...verifyLaunchToken(token), playerId: "someone-else" }),
      "utf8",
    ).toString("base64url");
    assert.throws(() => verifyLaunchToken(`${forged}.${signature}`), InvalidLaunchTokenError);
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = signLaunchToken(INPUT);
    process.env.LAUNCH_TOKEN_SECRET = "a-completely-different-secret-value-here";
    try {
      assert.throws(() => verifyLaunchToken(token), InvalidLaunchTokenError);
    } finally {
      process.env.LAUNCH_TOKEN_SECRET = "test-secret-that-is-long-enough-to-be-real";
    }
  });

  it("rejects a malformed token", () => {
    assert.throws(() => verifyLaunchToken("not-a-token"), InvalidLaunchTokenError);
    assert.throws(() => verifyLaunchToken("a.b.c"), InvalidLaunchTokenError);
    assert.throws(() => verifyLaunchToken(""), InvalidLaunchTokenError);
  });

  it("distinguishes an expired token from an invalid one", () => {
    // A player who waited too long deserves a clearer message than someone
    // presenting a forgery.
    const { token } = signLaunchToken({ ...INPUT, ttlMs: -1 });
    assert.throws(() => verifyLaunchToken(token), ExpiredLaunchTokenError);
  });

  it("gives a launch token a short TTL, since it travels in a URL", () => {
    const { expiresAt } = signLaunchToken(INPUT);
    assert.ok(expiresAt - Date.now() <= 60_000);
  });

  it("gives a session token a much longer TTL", () => {
    const { expiresAt } = signSessionToken(INPUT);
    assert.ok(expiresAt - Date.now() > 60 * 60 * 1000);
    assert.equal(verifyLaunchToken(signSessionToken(INPUT).token).kind, "session");
  });

  it("refuses to sign without a configured secret", () => {
    const saved = process.env.LAUNCH_TOKEN_SECRET;
    delete process.env.LAUNCH_TOKEN_SECRET;
    try {
      assert.throws(() => signLaunchToken(INPUT), /LAUNCH_TOKEN_SECRET is not set/);
    } finally {
      process.env.LAUNCH_TOKEN_SECRET = saved;
    }
  });
});
