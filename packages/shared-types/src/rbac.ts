/**
 * Roles are coarse on purpose. A fine-grained permission matrix is easy to
 * add and hard to reason about; four roles that map to real jobs can be
 * held in someone's head, and a reviewer can tell at a glance who is
 * allowed to move money-relevant config.
 */
export type RoleId = "super_admin" | "game_designer" | "operations" | "viewer";

export const ROLE_IDS: RoleId[] = ["super_admin", "game_designer", "operations", "viewer"];

export interface User {
  userId: string;
  email: string;
  /** bcrypt hash. Never returned by any route — see `toPublicUser`. */
  passwordHash: string;
  roles: RoleId[];
  active: boolean;
  /**
   * Incremented to invalidate every token already issued to this user.
   * A JWT is otherwise stateless, so without this a deactivated user's
   * token stays valid until it expires on its own — which for an admin
   * surface is exactly the wrong failure mode. Every authenticated request
   * re-checks this against the token's embedded copy.
   */
  tokenVersion: number;
  createdAt: string;
  lastLoginAt?: string;
}

/** The shape safe to return over the API — no hash, ever. */
export interface PublicUser {
  userId: string;
  email: string;
  roles: RoleId[];
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    userId: user.userId,
    email: user.email,
    roles: user.roles,
    active: user.active,
    createdAt: user.createdAt,
    ...(user.lastLoginAt !== undefined ? { lastLoginAt: user.lastLoginAt } : {}),
  };
}

/**
 * One immutable record of who changed what. Append-only: an audit log a
 * user can edit is not an audit log.
 */
export interface AuditLogEntry {
  entryId: string;
  actorUserId: string;
  /** Dotted action name, e.g. "game.publish", "user.deactivate". */
  action: string;
  entityType: string;
  entityId: string;
  /** Action-specific detail — what changed, from what, to what. */
  diff?: Record<string, unknown>;
  timestamp: string;
}
