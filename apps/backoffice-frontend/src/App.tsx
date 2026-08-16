import { useCallback, useEffect, useState } from "react";
import { api, setSessionLostHandler, setSessionToken, type SessionUser } from "./api.js";
import { Badge, Button } from "./ui/primitives.js";
import { t } from "./ui/tokens.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { GameListScreen } from "./screens/GameListScreen.js";
import { GameBuilderScreen } from "./screens/GameBuilderScreen.js";
import { AuditScreen } from "./screens/AuditScreen.js";
import { UsersScreen } from "./screens/UsersScreen.js";

type Route = { name: "games" } | { name: "game"; gameId: string } | { name: "audit" } | { name: "users" };

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [route, setRoute] = useState<Route>({ name: "games" });

  /**
   * Any 401 anywhere returns to the login screen.
   *
   * Registered once here rather than handled per screen: a revoked session
   * is not a screen-level error, and eleven screens each reimplementing the
   * redirect is eleven chances to forget one.
   */
  const handleSessionLost = useCallback(() => {
    setUser(null);
    setRoute({ name: "games" });
  }, []);

  useEffect(() => {
    setSessionLostHandler(handleSessionLost);
  }, [handleSessionLost]);

  if (!user) return <LoginScreen onAuthenticated={setUser} />;

  // super_admin passes every guard, mirroring the API's own rule so the UI
  // never offers an action the server would refuse.
  const canEdit = user.roles.includes("game_designer") || user.roles.includes("super_admin");
  const canAudit = user.roles.includes("operations") || user.roles.includes("super_admin");
  // Managing access is the operation that grants every other operation, so
  // it is administrator-only — matching the API exactly, since a nav item
  // leading to a 403 is worse than no nav item.
  const canManageUsers = user.roles.includes("super_admin");

  const logout = async () => {
    // Revokes every token issued to this user, not just this tab's — a
    // logout that only forgets the token locally is not a logout if the
    // token has already been copied.
    await api.logout().catch(() => undefined);
    setSessionToken(null);
    setUser(null);
  };

  const navItem = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        borderBottom: `2px solid ${active ? t.accent : "transparent"}`,
        color: active ? t.text : t.muted,
        padding: "6px 2px",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.text }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "12px 24px",
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        <strong style={{ fontSize: 14 }}>Slots Engine</strong>
        <nav style={{ display: "flex", gap: 16 }}>
          {navItem("Games", route.name === "games" || route.name === "game", () => setRoute({ name: "games" }))}
          {canManageUsers && navItem("Users", route.name === "users", () => setRoute({ name: "users" }))}
          {canAudit && navItem("Audit", route.name === "audit", () => setRoute({ name: "audit" }))}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: t.muted }}>{user.email}</span>
          {user.roles.map((role) => (
            <Badge key={role}>{role.replace("_", " ")}</Badge>
          ))}
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        {route.name === "games" && (
          <GameListScreen canEdit={canEdit} onOpen={(gameId) => setRoute({ name: "game", gameId })} />
        )}
        {route.name === "game" && (
          <GameBuilderScreen gameId={route.gameId} canEdit={canEdit} onBack={() => setRoute({ name: "games" })} />
        )}
        {route.name === "users" && <UsersScreen currentUserId={user.userId} />}
        {route.name === "audit" && <AuditScreen />}
      </main>
    </div>
  );
}
