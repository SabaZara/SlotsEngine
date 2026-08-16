import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeMongo } from "../../../game-backend/src/testing/fakeMongo.js";
import {
  countActiveSuperAdmins,
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  revokeSessions,
  seedInitialAdmin,
  setPassword,
  updateUser,
} from "./users.js";
import { verifyPassword } from "./passwords.js";

/**
 * The invariant this file exists for: **every change that alters what a
 * token is allowed to do must bump `tokenVersion`.** A session token carries
 * its own copy of the user's roles, so without the bump a demoted admin
 * keeps administrator access until the token expires on its own — up to
 * eight hours in which the demotion did nothing. `middleware.test.ts`
 * proves the hook rejects a stale version; this file proves the version
 * actually moves.
 *
 * Routes exercise these functions through `/v1/users` today, so a failure
 * there names an endpoint rather than the rule. These name the rule.
 *
 * What these cannot establish: behaviour under a real schema validator or a
 * transaction, since `fakeMongo` models neither — the reason F1 and F9
 * needed a live stack to find.
 */

const setup = () => {
  const { db } = fakeMongo();
  return db as never as Parameters<typeof createUser>[0];
};

const superAdmin = { email: "admin@example.com", password: "correct-horse", roles: ["super_admin" as const] };

describe("createUser", () => {
  it("starts a new user at tokenVersion 0 and active", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    assert.equal(user.tokenVersion, 0);
    assert.equal(user.active, true);
    assert.ok(user.userId, "a userId must be assigned");
  });

  it("stores a hash, never the password", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "correct-horse", roles: ["viewer"] });

    assert.equal(user.passwordHash.includes("correct-horse"), false);
    assert.equal(await verifyPassword("correct-horse", user.passwordHash), true);
    assert.equal(await verifyPassword("wrong-horse", user.passwordHash), false);
  });

  it("normalises the email, so one person is not two accounts", async () => {
    // An admin who is created as "Ana@X.com " and signs in as "ana@x.com"
    // is the same person. Treating them as separate is a lockout that looks
    // like a forgotten password.
    const db = setup();
    const user = await createUser(db, { email: "  Ana@Example.COM  ", password: "pw", roles: ["viewer"] });

    assert.equal(user.email, "ana@example.com");
    assert.ok(await findUserByEmail(db, "ANA@example.com"), "lookup must normalise too");
  });

  it("gives each user a distinct userId", async () => {
    const db = setup();
    const a = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });
    const b = await createUser(db, { email: "b@example.com", password: "pw", roles: ["viewer"] });
    assert.notEqual(a.userId, b.userId);
  });
});

describe("findUserByEmail / findUserById", () => {
  it("finds a user by either key", async () => {
    const db = setup();
    const created = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    assert.equal((await findUserByEmail(db, "a@example.com"))?.userId, created.userId);
    assert.equal((await findUserById(db, created.userId))?.email, "a@example.com");
  });

  it("returns null for someone who does not exist, rather than throwing", async () => {
    const db = setup();
    assert.equal(await findUserByEmail(db, "nobody@example.com"), null);
    assert.equal(await findUserById(db, "no-such-id"), null);
  });

  it("does not leak Mongo's _id into the returned user", async () => {
    // Same class as F16. `_id` is storage detail; a route serialising it
    // hands out an internal identifier for no reason.
    const db = setup();
    const created = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });
    const found = (await findUserById(db, created.userId)) as unknown as Record<string, unknown>;

    assert.equal(found._id, undefined);
  });
});

describe("the tokenVersion bump", () => {
  it("bumps on a role change, so a demotion takes effect at once", async () => {
    // The invariant this whole file is about.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["super_admin"] });

    const updated = await updateUser(db, user.userId, { roles: ["viewer"] });

    assert.deepEqual(updated?.roles, ["viewer"]);
    assert.equal(updated?.tokenVersion, 1, "a demotion that does not bump leaves admin access live for hours");
  });

  it("bumps on deactivation", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    const updated = await updateUser(db, user.userId, { active: false });

    assert.equal(updated?.active, false);
    assert.equal(updated?.tokenVersion, 1);
  });

  it("bumps on a password change, so a reset ends existing sessions", async () => {
    // A reset exists because the old credential may be compromised. Leaving
    // issued tokens valid lets whoever prompted the reset keep their access.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "old-pw", roles: ["viewer"] });

    assert.equal(await setPassword(db, user.userId, "new-pw"), true);

    const after = await findUserById(db, user.userId);
    assert.equal(after?.tokenVersion, 1);
    assert.equal(await verifyPassword("new-pw", after!.passwordHash), true);
    assert.equal(await verifyPassword("old-pw", after!.passwordHash), false);
  });

  it("bumps on an explicit revoke", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    await revokeSessions(db, user.userId);

    assert.equal((await findUserById(db, user.userId))?.tokenVersion, 1);
  });

  it("bumps once per change, never resetting", async () => {
    // Monotonic: a version that can go down would make an old token valid
    // again. Three changes, three increments.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    await updateUser(db, user.userId, { roles: ["operations"] });
    await updateUser(db, user.userId, { active: false });
    await revokeSessions(db, user.userId);

    assert.equal((await findUserById(db, user.userId))?.tokenVersion, 3);
  });

  it("does not bump when the patch changes nothing", async () => {
    // An empty patch is a no-op read, not a silent logout of the user.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    const result = await updateUser(db, user.userId, {});

    assert.equal(result?.tokenVersion, 0);
  });

  it("bumps when a role list is set to the same value", async () => {
    // Deliberately NOT diffed against the current value: comparing arrays
    // to decide whether to revoke is a correctness risk for no benefit, and
    // an unnecessary revoke merely asks someone to sign in again.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    const updated = await updateUser(db, user.userId, { roles: ["viewer"] });

    assert.equal(updated?.tokenVersion, 1);
  });
});

describe("updateUser", () => {
  it("changes only the fields named in the patch", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    const updated = await updateUser(db, user.userId, { active: false });

    assert.deepEqual(updated?.roles, ["viewer"], "roles must survive an active-only patch");
    assert.equal(updated?.email, "a@example.com");
  });

  it("returns null for a user who does not exist", async () => {
    const db = setup();
    assert.equal(await updateUser(db, "no-such-id", { active: false }), null);
  });

  it("returns the state after the change, not before", async () => {
    // `returnDocument: "after"`. Returning the stale document makes a route
    // echo the old roles back to the caller who just changed them.
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    const updated = await updateUser(db, user.userId, { roles: ["operations"] });

    assert.deepEqual(updated?.roles, ["operations"]);
  });

  it("can reactivate a deactivated user", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    await updateUser(db, user.userId, { active: false });
    const reactivated = await updateUser(db, user.userId, { active: true });

    assert.equal(reactivated?.active, true);
    assert.equal(reactivated?.tokenVersion, 2);
  });
});

describe("setPassword", () => {
  it("reports whether it matched anyone", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    assert.equal(await setPassword(db, user.userId, "new-pw"), true);
    assert.equal(await setPassword(db, "no-such-id", "new-pw"), false);
  });

  it("salts, so setting the same password twice stores different hashes", async () => {
    const db = setup();
    const user = await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    await setPassword(db, user.userId, "same-pw");
    const first = (await findUserById(db, user.userId))!.passwordHash;
    await setPassword(db, user.userId, "same-pw");
    const second = (await findUserById(db, user.userId))!.passwordHash;

    assert.notEqual(first, second);
    assert.equal(await verifyPassword("same-pw", second), true);
  });
});

describe("listUsers", () => {
  it("returns every user, newest first", async () => {
    const db = setup();
    // createdAt is an ISO string and the sort is lexicographic on it, which
    // is only correct because ISO-8601 sorts that way. Distinct timestamps
    // are forced here rather than relying on the clock ticking.
    for (const [index, email] of ["a@example.com", "b@example.com", "c@example.com"].entries()) {
      const user = await createUser(db, { email, password: "pw", roles: ["viewer"] });
      await (db as never as { collection: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> } })
        .collection("users")
        .updateOne({ userId: user.userId }, { $set: { createdAt: `2026-0${index + 1}-01T00:00:00.000Z` } });
    }

    const listed = await listUsers(db);

    assert.deepEqual(
      listed.map((u) => u.email),
      ["c@example.com", "b@example.com", "a@example.com"],
    );
  });

  it("returns an empty list rather than throwing when there are no users", async () => {
    assert.deepEqual(await listUsers(setup()), []);
  });

  it("strips _id from every row", async () => {
    const db = setup();
    await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer"] });

    for (const user of await listUsers(db)) {
      assert.equal((user as unknown as Record<string, unknown>)._id, undefined);
    }
  });
});

describe("countActiveSuperAdmins", () => {
  it("counts only active super admins", async () => {
    const db = setup();
    await createUser(db, superAdmin);
    await createUser(db, { email: "two@example.com", password: "pw", roles: ["super_admin"] });
    await createUser(db, { email: "viewer@example.com", password: "pw", roles: ["viewer"] });

    assert.equal(await countActiveSuperAdmins(db), 2);
  });

  it("stops counting an admin once they are deactivated", async () => {
    const db = setup();
    const one = await createUser(db, superAdmin);
    await createUser(db, { email: "two@example.com", password: "pw", roles: ["super_admin"] });

    await updateUser(db, one.userId, { active: false });

    assert.equal(await countActiveSuperAdmins(db), 1);
  });

  it("stops counting an admin once they are demoted", async () => {
    const db = setup();
    const one = await createUser(db, superAdmin);
    await createUser(db, { email: "two@example.com", password: "pw", roles: ["super_admin"] });

    await updateUser(db, one.userId, { roles: ["viewer"] });

    assert.equal(await countActiveSuperAdmins(db), 1);
  });

  it("excludes a named user, which is how the last-admin guard asks its question", async () => {
    // The route needs "would anyone still be an admin if I changed THIS
    // one?", so the subject has to be excluded from their own count.
    const db = setup();
    const only = await createUser(db, superAdmin);

    assert.equal(await countActiveSuperAdmins(db), 1);
    assert.equal(
      await countActiveSuperAdmins(db, only.userId),
      0,
      "demoting the only admin must be visible as leaving zero",
    );
  });

  it("counts an admin whose record has no active field at all", async () => {
    // The query is `active: { $ne: false }`, not `active: true`, and the
    // difference only shows on a document predating the field: `$ne` counts
    // it, an equality does not. Getting this wrong makes the last-admin
    // guard believe there are zero administrators and refuse every change —
    // or, worse, permit the one that locks everyone out.
    const db = setup();
    await (db as never as { collection: (n: string) => { insertOne: (d: unknown) => Promise<unknown> } })
      .collection("users")
      .insertOne({ userId: "legacy", email: "legacy@example.com", roles: ["super_admin"], tokenVersion: 0 });

    assert.equal(await countActiveSuperAdmins(db), 1);
  });

  it("counts an admin holding several roles", async () => {
    const db = setup();
    await createUser(db, { email: "a@example.com", password: "pw", roles: ["viewer", "super_admin"] });

    assert.equal(await countActiveSuperAdmins(db), 1);
  });
});

describe("seedInitialAdmin", () => {
  it("creates the first administrator when the collection is empty", async () => {
    const db = setup();
    const result = await seedInitialAdmin(db);

    assert.equal(result.created, true);
    const admin = await findUserByEmail(db, result.email!);
    assert.deepEqual(admin?.roles, ["super_admin"]);
  });

  it("does nothing when any user already exists", async () => {
    // Guarded on the collection being empty, not on this email being
    // absent: re-seeding after someone renamed or removed the bootstrap
    // account would otherwise quietly recreate a known login with a known
    // password on a live system.
    const db = setup();
    await createUser(db, { email: "someone@example.com", password: "pw", roles: ["viewer"] });

    assert.deepEqual(await seedInitialAdmin(db), { created: false });
    assert.equal((await listUsers(db)).length, 1);
  });

  it("uses BOOTSTRAP_ADMIN_PASSWORD when it is set", async () => {
    const db = setup();
    const saved = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "a-chosen-password";
    try {
      const result = await seedInitialAdmin(db);
      const admin = await findUserByEmail(db, result.email!);
      assert.equal(await verifyPassword("a-chosen-password", admin!.passwordHash), true);
    } finally {
      if (saved === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
      else process.env.BOOTSTRAP_ADMIN_PASSWORD = saved;
    }
  });

  it("refuses to seed a default password in production", async () => {
    // A deployment must not silently come up with a known credential.
    const db = setup();
    const savedEnv = process.env.NODE_ENV;
    const savedPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    process.env.NODE_ENV = "production";
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    try {
      await assert.rejects(() => seedInitialAdmin(db), /BOOTSTRAP_ADMIN_PASSWORD/);
      assert.deepEqual(await listUsers(db), [], "nothing may be created when it refuses");
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
      if (savedPassword !== undefined) process.env.BOOTSTRAP_ADMIN_PASSWORD = savedPassword;
    }
  });
});
