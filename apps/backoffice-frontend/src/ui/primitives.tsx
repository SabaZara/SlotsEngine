import type { CSSProperties, ReactNode } from "react";
import { t } from "./tokens.js";

/**
 * The small set of shared components every screen builds from. Kept in one
 * file because they are each a handful of lines and splitting them across
 * nine modules would cost more in navigation than it saves in tidiness.
 */

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const palette: Record<string, CSSProperties> = {
    primary: { background: t.accent, color: t.accentText, border: "none", fontWeight: 600 },
    secondary: { background: "transparent", color: t.text, border: `1px solid ${t.border}` },
    danger: { background: "transparent", color: t.bad, border: `1px solid ${t.bad}66` },
    ghost: { background: "transparent", color: t.muted, border: "1px solid transparent" },
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 14px",
        borderRadius: t.radiusSm,
        fontSize: 13,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        ...palette[variant],
      }}
    >
      {children}
    </button>
  );
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section
      style={{
        background: t.panel,
        border: `1px solid ${t.border}`,
        borderRadius: t.radius,
        padding: 16,
        marginBottom: 16,
      }}
    >
      {(title || actions) && (
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          {title && <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: 0.2 }}>{title}</h2>}
          {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, marginBottom: 5 }}>
        {label}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: t.faint, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  background: t.bg,
  border: `1px solid ${t.border}`,
  borderRadius: t.radiusSm,
  color: t.text,
  fontSize: 13,
  fontFamily: "inherit",
};

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, ...(mono ? { fontFamily: t.mono } : {}) }}
    />
  );
}

/**
 * A number input that reports only *valid* numbers upward.
 *
 * Deliberately keeps its own text state: binding a number directly makes a
 * field impossible to clear or to type "0.9" into, because the intermediate
 * "0." parses to something else and the cursor jumps. The parent sees a
 * number only once one really exists.
 */
export function NumberInput({
  value,
  onChange,
  step,
  min,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      step={step}
      min={min}
      disabled={disabled}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(parsed)) onChange(parsed);
      }}
      style={{ ...inputStyle, fontFamily: t.mono }}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      style={{ ...inputStyle, cursor: disabled ? "default" : "pointer" }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} style={{ background: t.panel }}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const color = { neutral: t.muted, good: t.good, warn: t.warn, bad: t.bad }[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        border: `1px solid ${color}55`,
        color,
        fontSize: 11,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Banner({ tone, children }: { tone: "good" | "warn" | "bad"; children: ReactNode }) {
  const color = { good: t.good, warn: t.warn, bad: t.bad }[tone];
  return (
    <div
      style={{
        border: `1px solid ${color}55`,
        background: `${color}12`,
        color,
        borderRadius: t.radiusSm,
        padding: "10px 12px",
        fontSize: 13,
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div style={{ color: t.faint, fontSize: 13, padding: "20px 0", textAlign: "center" }}>{children}</div>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; badge?: ReactNode }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav style={{ display: "flex", gap: 4, borderBottom: `1px solid ${t.border}`, marginBottom: 16 }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 14px",
            background: "transparent",
            border: "none",
            borderBottom: `2px solid ${active === tab.id ? t.accent : "transparent"}`,
            color: active === tab.id ? t.text : t.muted,
            fontSize: 13,
            fontWeight: active === tab.id ? 600 : 400,
            cursor: "pointer",
          }}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </nav>
  );
}
