import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { ROLE_IDS, toPublicUser, type RoleId } from "@slots-engine/shared-types";
import { requireRole } from "../auth/middleware.js";
import {
  countActiveSuperAdmins,
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  setPassword,
  updateUser,
} from "../auth/users.js";
import { writeAuditLog } from "../audit/log.js";

/**
 * Managing who can get into the backoffice is the most sensitive thing this
 * API does — it is the operation that grants every other operation — so it
 * is restricted to `super_admin` alone. `requireRole()` with no roles listed
 * means exactly that: nobody satisfies the list, and only the always-passes
 * `super_admin` gets through.
 */
const CAN_MANAGE_USERS = requireRole();

/** A password too short to resist an offline attack on a leaked hash. Not a
 * complexity rule — length is what actually matters, and arbitrary
 * character requirements mostly produce predictable substitutions. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * A type predicate that narrows on the *valid* case. Writing it the other
 * way round — `invalidRoles(x): x is RoleId[]` — reads naturally at the call
 * site and is exactly backwards: it would tell the compiler the value is a
 * valid role array precisely when it isn't.
 */
function isValidRoles(roles: unknown): roles is RoleId[] {
  return Array.isArray(roles) && roles.length > 0 && roles.every((r) => ROLE_IDS.includes(r as RoleId));
}

export function registerUserRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/users", { preHandler: [CAN_MANAGE_USERS] }, async (_request, reply) => {
    const users = await listUsers(db);
    // Mapped through `toPublicUser` rather than returned raw: the stored
    // document carries a password hash, and a projection someone forgets to
    // apply is how that leaves the building.
    return reply.send({ users: users.map(toPublicUser), roles: ROLE_IDS });
  });

  app.post<{ Body: { email?: string; password?: string; roles?: RoleId[] } }>(
    "/v1/users",
    { preHandler: [CAN_MANAGE_USERS] },
    async (request, reply) => {
      const { email, password, roles } = request.body ?? {};

      if (!email?.trim()) return reply.code(400).send({ error: "email_required" });
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: "password_too_short", minLength: MIN_PASSWORD_LENGTH });
      }
      if (!isValidRoles(roles)) return reply.code(400).send({ error: "invalid_roles", allowed: ROLE_IDS });
      if (await findUserByEmail(db, email)) {
        return reply.code(409).send({ error: "email_already_registered" });
      }

      const user = await createUser(db, { email, password, roles });
      await writeAuditLog(db, {
        actorUserId: request.user!.userId,
        action: "user.create",
        entityType: "user",
        entityId: user.userId,
        // The roles granted are the point of the record. The password is
        // never logged, in any form.
        diff: { email: user.email, roles },
      });
      return reply.code(201).send({ user: toPublicUser(user) });
    },
  );

  app.put<{ Params: { userId: string }; Body: { roles?: RoleId[]; active?: boolean } }>(
    "/v1/users/:userId",
    { preHandler: [CAN_MANAGE_USERS] },
    async (request, reply) => {
      const { userId } = request.params;
      const { roles, active } = request.body ?? {};

      if (roles !== undefined && !isValidRoles(roles)) {
        return reply.code(400).send({ error: "invalid_roles", allowed: ROLE_IDS });
      }

      const target = await findUserById(db, userId);
      if (!target) return reply.code(404).send({ error: "user_not_found" });

      // Checked before the last-administrator guard below, because when both
      // apply this is the more specific and more actionable answer: the two
      // overlap whenever a sole administrator deactivates themselves, and
      // "you cannot deactivate yourself" tells them what to do next in a way
      // that "there must be one administrator" does not.
      if (active === false && userId === request.user!.userId) {
        return reply.code(409).send({ error: "cannot_deactivate_self" });
      }

      // Refuse the change that would leave nobody able to administer the
      // system. Recovering from that needs direct database access, which is
      // exactly the situation an admin UI exists to avoid — so it is
      // blocked here rather than warned about in the UI, where it would be
      // one misclick away.
      const losesAdmin =
        (roles !== undefined && target.roles.includes("super_admin") && !roles.includes("super_admin")) ||
        (active === false && target.roles.includes("super_admin"));
      if (losesAdmin && (await countActiveSuperAdmins(db, userId)) === 0) {
        return reply.code(409).send({ error: "last_super_admin" });
      }

      const updated = await updateUser(db, userId, {
        ...(roles !== undefined ? { roles } : {}),
        ...(active !== undefined ? { active } : {}),
      });
      if (!updated) return reply.code(404).send({ error: "user_not_found" });

      await writeAuditLog(db, {
        actorUserId: request.user!.userId,
        action: "user.update",
        entityType: "user",
        entityId: userId,
        diff: {
          ...(roles !== undefined ? { fromRoles: target.roles, toRoles: roles } : {}),
          ...(active !== undefined ? { fromActive: target.active, toActive: active } : {}),
          // Recorded because it is a real consequence a reviewer should see:
          // this change signed the user out everywhere.
          sessionsRevoked: true,
        },
      });

      return reply.send({ user: toPublicUser(updated) });
    },
  );

  app.post<{ Params: { userId: string }; Body: { password?: string } }>(
    "/v1/users/:userId/password",
    { preHandler: [CAN_MANAGE_USERS] },
    async (request, reply) => {
      const { password } = request.body ?? {};
      if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: "password_too_short", minLength: MIN_PASSWORD_LENGTH });
      }
      if (!(await setPassword(db, request.params.userId, password))) {
        return reply.code(404).send({ error: "user_not_found" });
      }

      await writeAuditLog(db, {
        actorUserId: request.user!.userId,
        action: "user.password_reset",
        entityType: "user",
        entityId: request.params.userId,
        diff: { sessionsRevoked: true },
      });

      return reply.send({ passwordSet: true });
    },
  );
}
