import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { RoleId, User } from "@slots-engine/shared-types";
import { hashPassword } from "./passwords.js";

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  // Normalised to lower case on both write and read: an admin who signs up
  // as "Ana@x.com" and logs in as "ana@x.com" is the same person, and
  // treating them as two accounts is a lockout waiting to happen.
  const doc = await db.collection("users").findOne({ email: email.trim().toLowerCase() });
  return doc ? ({ ...doc, _id: undefined } as unknown as User) : null;
}

export async function createUser(
  db: Db,
  input: { email: string; password: string; roles: RoleId[] },
): Promise<User> {
  const user: User = {
    userId: randomUUID(),
    email: input.email.trim().toLowerCase(),
    passwordHash: await hashPassword(input.password),
    roles: input.roles,
    active: true,
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
  };
  await db.collection("users").insertOne({ ...user });
  return user;
}

/**
 * Seeds the first administrator, and only ever the first.
 *
 * Guarded on the collection being completely empty rather than on this
 * specific email being absent: a re-seed after someone has renamed or
 * removed the bootstrap account would otherwise quietly recreate a known
 * login with a known password on a live system.
 *
 * Refuses to run in production without an explicit password, so a
 * deployment cannot silently come up with a default credential.
 */
export async function seedInitialAdmin(db: Db): Promise<{ created: boolean; email?: string }> {
  if ((await db.collection("users").countDocuments({}, { limit: 1 })) > 0) {
    return { created: false };
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "No users exist and BOOTSTRAP_ADMIN_PASSWORD is not set — refusing to seed an administrator with a default password in production.",
      );
    }
    await createUser(db, { email, password: "admin", roles: ["super_admin"] });
    return { created: true, email };
  }

  await createUser(db, { email, password, roles: ["super_admin"] });
  return { created: true, email };
}

/** Invalidates every token already issued to a user — the mechanism behind
 * "log out everywhere" and behind deactivation taking effect immediately. */
export async function revokeSessions(db: Db, userId: string): Promise<void> {
  await db.collection("users").updateOne({ userId }, { $inc: { tokenVersion: 1 } });
}

export async function findUserById(db: Db, userId: string): Promise<User | null> {
  const doc = await db.collection("users").findOne({ userId });
  return doc ? ({ ...doc, _id: undefined } as unknown as User) : null;
}

/** Newest first. Returns full documents; every route that serves these maps
 * through `toPublicUser` so a hash can never leave the service. */
export async function listUsers(db: Db): Promise<User[]> {
  const docs = await db.collection("users").find({}).sort({ createdAt: -1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest as unknown as User);
}

/**
 * Changes a user's roles and/or active flag.
 *
 * **Any change here bumps `tokenVersion`**, which invalidates every token
 * already issued to that user. This is the part the shape of this feature
 * most easily gets wrong: a signed token carries its own copy of the roles,
 * so without the bump a demoted admin keeps administrator access until their
 * token expires — up to eight hours during which the demotion did nothing.
 * Deactivation has exactly the same problem. Revoking is therefore not an
 * extra step a caller may forget; it is part of the update.
 */
export async function updateUser(
  db: Db,
  userId: string,
  patch: { roles?: RoleId[]; active?: boolean },
): Promise<User | null> {
  const changes: Record<string, unknown> = {};
  if (patch.roles !== undefined) changes.roles = patch.roles;
  if (patch.active !== undefined) changes.active = patch.active;
  if (Object.keys(changes).length === 0) return findUserById(db, userId);

  const updated = await db
    .collection("users")
    .findOneAndUpdate({ userId }, { $set: changes, $inc: { tokenVersion: 1 } }, { returnDocument: "after" });

  if (!updated) return null;
  const { _id, ...rest } = updated;
  return rest as unknown as User;
}

/**
 * Sets a new password and revokes existing sessions.
 *
 * The revocation matters as much as the change: a password reset exists
 * precisely because the old credential may be compromised, and leaving
 * already-issued tokens valid would let whoever prompted the reset keep
 * their access.
 */
export async function setPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const result = await db
    .collection("users")
    .updateOne({ userId }, { $set: { passwordHash: await hashPassword(password) }, $inc: { tokenVersion: 1 } });
  return result.matchedCount > 0;
}

/** How many active administrators exist. Used to refuse the change that
 * would lock everyone out — see the route. */
export async function countActiveSuperAdmins(db: Db, excludingUserId?: string): Promise<number> {
  return db.collection("users").countDocuments({
    roles: "super_admin",
    active: { $ne: false },
    ...(excludingUserId ? { userId: { $ne: excludingUserId } } : {}),
  });
}
