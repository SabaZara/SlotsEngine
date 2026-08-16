import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLE_IDS, toPublicUser, type RoleId, type User } from "./rbac.js";

/**
 * `rbac.ts` is mostly types, which need no tests — the compiler is the test.
 * What is worth pinning is the small amount that survives to runtime:
 * `ROLE_IDS`, and `toPublicUser`, which is the single point deciding what
 * leaves the process when a user is serialised.
 *
 * `toPublicUser` is written as an allowlist (it names the fields to keep)
 * rather than a denylist, so a field added to `User` is excluded by default.
 * That is the right direction, and the tests below are built to fail if it
 * is ever inverted into a `delete user.passwordHash` — which leaks any
 * *future* secret field the moment someone adds one.
 *
 * What these tests cannot establish: that every route actually calls this.
 * A handler returning a raw user document is invisible here. `users.test.ts`
 * covers the routes that exist today.
 */

const fullUser = (overrides: Partial<User> = {}): User => ({
  userId: "user-1",
  email: "designer@example.com",
  passwordHash: "scrypt$never$leaves$the$process",
  roles: ["game_designer"],
  active: true,
  tokenVersion: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("ROLE_IDS", () => {
  it("lists every role the RoleId type allows", () => {
    // A role added to the union but not to the array is invisible to any
    // UI that renders this list, which looks like a missing feature rather
    // than a missing entry. The compiler cannot catch it — the array is
    // typed `RoleId[]`, not "every RoleId" — so it is asserted here.
    const expected: RoleId[] = ["super_admin", "game_designer", "operations", "viewer"];
    assert.deepEqual([...ROLE_IDS].sort(), [...expected].sort());
  });

  it("contains no duplicates", () => {
    assert.equal(new Set(ROLE_IDS).size, ROLE_IDS.length);
  });

  it("keeps super_admin in the list, since it is a real assignable role", () => {
    // `requireRole` treats super_admin as an implicit bypass rather than a
    // listed role. That is about authorisation, not about assignment — it
    // must still be something an administrator can grant.
    assert.ok(ROLE_IDS.includes("super_admin"));
  });
});

describe("toPublicUser", () => {
  it("never returns the password hash", () => {
    // The one property this function exists for.
    const publicUser = toPublicUser(fullUser());
    assert.equal("passwordHash" in publicUser, false);
    assert.equal(JSON.stringify(publicUser).includes("scrypt"), false);
  });

  it("never returns tokenVersion, which is internal revocation state", () => {
    // Not a secret exactly, but it tells a caller nothing useful and hints
    // at the revocation mechanism. It is excluded by the allowlist rather
    // than by a rule anyone has to remember.
    assert.equal("tokenVersion" in toPublicUser(fullUser()), false);
  });

  it("returns exactly the public fields, and nothing else", () => {
    // The allowlist stated as an assertion. If `User` grows a field and
    // `toPublicUser` is rewritten as a denylist, this fails — which is the
    // point, since a denylist leaks every field added after it was written.
    assert.deepEqual(Object.keys(toPublicUser(fullUser())).sort(), [
      "active",
      "createdAt",
      "email",
      "roles",
      "userId",
    ]);
  });

  it("carries the public fields through unchanged", () => {
    const user = fullUser();
    assert.deepEqual(toPublicUser(user), {
      userId: "user-1",
      email: "designer@example.com",
      roles: ["game_designer"],
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("includes lastLoginAt when the user has signed in", () => {
    const publicUser = toPublicUser(fullUser({ lastLoginAt: "2026-08-16T09:00:00.000Z" }));
    assert.equal(publicUser.lastLoginAt, "2026-08-16T09:00:00.000Z");
  });

  it("omits lastLoginAt entirely for a user who never has", () => {
    // Omitted rather than sent as undefined or null: a key that is present
    // and empty reads as "we lost it", not "it never happened", and the two
    // render differently in a UI.
    const publicUser = toPublicUser(fullUser());
    assert.equal("lastLoginAt" in publicUser, false);
  });

  it("survives a round trip through JSON without gaining a key", () => {
    // How this value actually reaches a client. An explicit `undefined`
    // would vanish here, hiding an omission bug from every other assertion.
    const publicUser = toPublicUser(fullUser());
    assert.deepEqual(JSON.parse(JSON.stringify(publicUser)), publicUser);
  });

  it("reports a deactivated user as inactive rather than hiding them", () => {
    // An administrator has to be able to see a deactivated account in order
    // to reactivate it.
    assert.equal(toPublicUser(fullUser({ active: false })).active, false);
  });

  it("returns every role a user holds", () => {
    const publicUser = toPublicUser(fullUser({ roles: ["game_designer", "operations"] }));
    assert.deepEqual(publicUser.roles, ["game_designer", "operations"]);
  });

  it("does not mutate the user it was given", () => {
    // Rules out the `delete user.passwordHash` implementation directly: it
    // would pass every leak test above while destroying the caller's copy —
    // and the caller is often mid-write to the database.
    const user = fullUser();
    toPublicUser(user);
    assert.equal(user.passwordHash, "scrypt$never$leaves$the$process");
    assert.equal(user.tokenVersion, 3);
  });

  it("copies the roles array rather than aliasing it", () => {
    // Returning the same reference means a caller can escalate the source
    // record through the "safe" copy. Found by writing this test and
    // checking: it was aliased, and `toPublicUser` now copies.
    const user = fullUser();
    const publicUser = toPublicUser(user);

    assert.notEqual(publicUser.roles, user.roles, "roles must not be the same array reference");

    (publicUser.roles as RoleId[]).push("super_admin");
    assert.deepEqual(user.roles, ["game_designer"], "editing the public copy must not touch the source");
  });
});
