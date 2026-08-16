import { useState } from "react";
import { ApiError, api, setSessionToken, type SessionUser } from "../api.js";
import { Banner, Button, Field, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

export function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.login(email, password);
      setSessionToken(token);
      onAuthenticated(user);
    } catch (err) {
      // The API deliberately returns the same answer for a wrong password
      // and an unknown account, so this message stays vague on purpose —
      // being more specific here would undo that.
      setError(err instanceof ApiError && err.status === 401 ? "Those credentials were not accepted." : "Could not reach the backoffice.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 20 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{
          width: "100%",
          maxWidth: 340,
          background: t.panel,
          border: `1px solid ${t.border}`,
          borderRadius: t.radius,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 17, margin: "0 0 4px" }}>Slots Engine</h1>
        <p style={{ fontSize: 12, color: t.muted, margin: "0 0 20px" }}>Backoffice</p>

        {error && <Banner tone="bad">{error}</Banner>}

        <Field label="Email">
          <TextInput type="email" value={email} onChange={setEmail} placeholder="admin@example.com" />
        </Field>
        <Field label="Password">
          <TextInput type="password" value={password} onChange={setPassword} />
        </Field>

        <div style={{ marginTop: 16 }}>
          <Button type="submit" variant="primary" disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>

        <p style={{ fontSize: 11, color: t.faint, marginTop: 18, lineHeight: 1.5 }}>
          Sessions live in memory only and are lost on refresh — a bearer token in browser storage is readable by
          anything else on the page and outlives the person using it.
        </p>
      </form>
    </div>
  );
}
