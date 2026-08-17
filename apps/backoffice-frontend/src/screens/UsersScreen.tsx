import { useEffect, useState } from "react";
import type { RoleId } from "@slots-engine/shared-types";
import { ApiError, api, type ManagedUser } from "../api.js";
import { Badge, Banner, Button, Card, EmptyState, Field, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/** Mirrors the server's own minimum. Checked here purely so a designer gets
 * the answer before a round trip — the server is still the authority. */
const MIN_PASSWORD_LENGTH = 10;

const ROLE_HELP: Record<string, string> = {
  super_admin: "Everything, including managing users",
  game_designer: "Create, edit and publish games",
  operations: "Read the audit log",
  viewer: "Read-only",
};

/** Turns a server error code into something a person can act on. A raw code
 * is accurate and useless; these say what to do instead. */
function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err);
  switch (err.code) {
    case "email_already_registered":
      return "That email already has an account.";
    case "password_too_short":
      return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "last_super_admin":
      return "This is the only administrator left. Promote someone else first, or the backoffice would lock everyone out.";
    case "cannot_deactivate_self":
      return "You cannot deactivate your own account.";
    case "invalid_roles":
      return "Pick at least one valid role.";
    default:
      return err.message;
  }
}

function RolePicker({
  roles,
  available,
  onChange,
}: {
  roles: RoleId[];
  available: RoleId[];
  onChange: (roles: RoleId[]) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {available.map((role) => {
        const on = roles.includes(role);
        return (
          <button
            key={role}
            title={ROLE_HELP[role]}
            onClick={() => onChange(on ? roles.filter((r) => r !== role) : [...roles, role])}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: `1px solid ${on ? t.accent : t.border}`,
              background: on ? `${t.accent}22` : "transparent",
              color: on ? t.text : t.muted,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {role.replace("_", " ")}
          </button>
        );
      })}
    </div>
  );
}

export function UsersScreen({ currentUserId }: { currentUserId: string }) {
  /**
   * Changing your own roles revokes your own token, so the next request
   * bounces you to the login screen with no explanation — it looks like the
   * app broke. Warning first turns a baffling logout into a deliberate
   * choice. It is a confirmation rather than a block because it is a
   * legitimate thing to do; only removing the *last* administrator is
   * genuinely refused, and the server enforces that.
   */
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [available, setAvailable] = useState<RoleId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRoles, setNewRoles] = useState<RoleId[]>([]);

  /** Which user's password is being reset, if any. Editing roles happens
   * inline; a password reset is destructive enough to deserve its own
   * deliberate step. */
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = async () => {
    try {
      const result = await api.listUsers();
      setUsers(result.users);
      setAvailable(result.roles);
      setError(null);
    } catch (err) {
      // Only super_admin may manage users, so a 403 here is the role split
      // working rather than a fault.
      setError(
        err instanceof ApiError && err.status === 403
          ? "Managing users is restricted to administrators."
          : explain(err),
      );
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await load();
    } catch (err) {
      setError(explain(err));
    }
  };

  return (
    <>
      <Card
        title="Users"
        actions={
          users && !creating ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New user
            </Button>
          ) : undefined
        }
      >
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="good">{notice}</Banner>}

        {creating && (
          <div style={{ border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusSm, padding: 14, marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
              <Field label="Email">
                <TextInput label="Email" type="email" value={newEmail} onChange={setNewEmail} placeholder="designer@example.com" />
              </Field>
              <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols.`}>
                <TextInput label="Password" type="password" value={newPassword} onChange={setNewPassword} />
              </Field>
            </div>
            <Field label="Roles">
              <RolePicker roles={newRoles} available={available} onChange={setNewRoles} />
            </Field>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button
                variant="primary"
                disabled={!newEmail.trim() || newPassword.length < MIN_PASSWORD_LENGTH || newRoles.length === 0}
                onClick={() =>
                  void act(async () => {
                    await api.createUser(newEmail.trim(), newPassword, newRoles);
                    setCreating(false);
                    setNewEmail("");
                    setNewPassword("");
                    setNewRoles([]);
                  }, "User created.")
                }
              >
                Create
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {users === null && !error && <EmptyState>Loading…</EmptyState>}

        {users?.map((user) => {
          const isSelf = user.userId === currentUserId;
          return (
            <div
              key={user.userId}
              style={{
                borderTop: `1px solid ${t.border}`,
                padding: "12px 0",
                opacity: user.active ? 1 : 0.55,
              }}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ minWidth: 210 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span>{user.email}</span>
                    {isSelf && <Badge>you</Badge>}
                    {!user.active && <Badge tone="bad">deactivated</Badge>}
                  </div>
                  <div style={{ fontSize: 11, color: t.faint }}>
                    {user.lastLoginAt ? `last signed in ${new Date(user.lastLoginAt).toLocaleString()}` : "never signed in"}
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 240 }}>
                  <RolePicker
                    roles={user.roles}
                    available={available}
                    onChange={(roles) => {
                      // Deselecting the last role is never a meaningful
                      // intent — a user with no roles can sign in and do
                      // nothing, which reads as a broken account rather
                      // than a deliberate one. Refused here so the person
                      // gets the useful answer ("deactivate them instead")
                      // rather than the server's generic "pick a valid
                      // role", which describes the request rather than
                      // what they were trying to achieve.
                      if (roles.length === 0) {
                        setNotice(null);
                        setError("A user needs at least one role. To remove their access entirely, deactivate the account.");
                        return;
                      }
                      if (
                        isSelf &&
                        !window.confirm(
                          "Changing your own roles signs you out of every session, including this one. Continue?",
                        )
                      ) {
                        return;
                      }
                      void act(
                        () => api.updateUser(user.userId, { roles }),
                        "Roles updated — that user has been signed out everywhere.",
                      );
                    }}
                  />
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <Button onClick={() => setResetting(resetting === user.userId ? null : user.userId)}>
                    Reset password
                  </Button>
                  <Button
                    variant={user.active ? "danger" : "secondary"}
                    disabled={isSelf && user.active}
                    title={isSelf && user.active ? "You cannot deactivate your own account" : undefined}
                    onClick={() =>
                      void act(
                        () => api.updateUser(user.userId, { active: !user.active }),
                        user.active
                          ? "Account deactivated and signed out everywhere."
                          : "Account reactivated.",
                      )
                    }
                  >
                    {user.active ? "Deactivate" : "Reactivate"}
                  </Button>
                </div>
              </div>

              {resetting === user.userId && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <div style={{ width: 240 }}>
                    {/* Named rather than relying on the placeholder, which
                        disappears the moment a character is typed — so a
                        screen reader user loses the only description of the
                        field exactly when they start using it. The user's
                        email is in the name because this row repeats per
                        user and "New password" alone would be ambiguous
                        about whose. */}
                    <TextInput
                      label={`New password for ${user.email}`}
                      type="password"
                      value={resetPassword}
                      onChange={setResetPassword}
                      placeholder={`New password (${MIN_PASSWORD_LENGTH}+ characters)`}
                    />
                  </div>
                  <Button
                    variant="primary"
                    disabled={resetPassword.length < MIN_PASSWORD_LENGTH}
                    onClick={() =>
                      void act(async () => {
                        await api.setUserPassword(user.userId, resetPassword);
                        setResetting(null);
                        setResetPassword("");
                      }, "Password set — that user has been signed out everywhere.")
                    }
                  >
                    Set password
                  </Button>
                  <Button variant="ghost" onClick={() => setResetting(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </Card>

      {users && (
        <div style={{ fontSize: 12, color: t.faint, lineHeight: 1.6 }}>
          Changing roles, deactivating an account or resetting a password all sign that user out everywhere
          immediately. A session token carries its own copy of the roles, so without that a demoted administrator would
          keep their access until the token expired on its own.
        </div>
      )}
    </>
  );
}
