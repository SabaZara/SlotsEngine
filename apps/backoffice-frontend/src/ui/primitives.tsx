import { useId } from "react";
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

/**
 * A labelled form row.
 *
 * **Deliberately not a `<label>` wrapper, and it used to be one.** That
 * older shape was wrong in two independent ways, both invisible on screen:
 *
 *   1. **The hint became part of the name.** Everything inside a `<label>`
 *      is its text, so a field labelled "Background" with a hint announced
 *      as "BackgroundDrawn behind the reels. Empty means the built-in
 *      gradient." — the explanation read out as though it were the field's
 *      identity, every time focus landed. A hint is *description*, and the
 *      platform has a separate channel for that.
 *   2. **A wrapping `<label>` binds to exactly one control.** Half the
 *      fields here hold several — "Grid" has a reels box and a rows box,
 *      "Bet options" has one per stake. The label silently attached to the
 *      first, so "Grid" named the reels input and the rows input had no
 *      name at all. No amount of hint-fixing addresses that.
 *
 * So the label and hint are given ids and referenced instead. `role="group"`
 * plus `aria-labelledby` names the whole row however many controls it holds,
 * which is the one shape that is correct for both cases rather than correct
 * for the common one and quietly wrong for the rest.
 *
 * `htmlFor` is deliberately NOT used: it would require every caller to
 * thread an id into whatever it renders, and the multi-control rows have no
 * single element to point at.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;

  return (
    <div
      // `group` rather than nothing, so a row holding several controls is
      // announced as one labelled unit. Note the row's own controls should
      // ALSO carry their own name (see `TextInput`'s `label`): a group name
      // is announced on entering the group, not on focusing each box.
      role="group"
      aria-labelledby={labelId}
      {...(hint ? { "aria-describedby": hintId } : {})}
      style={{ display: "block", marginBottom: 12 }}
    >
      <div
        id={labelId}
        // `aria-hidden` because this text is already consumed as the group's
        // name via `aria-labelledby`. Without it the same words are exposed
        // twice — once as the group name and once as loose text inside it —
        // which reads as a stutter, and makes an accessible-name query
        // ambiguous between the group and the input it labels.
        aria-hidden="true"
        style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7, color: t.muted, marginBottom: 5 }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div id={hintId} style={{ fontSize: 11, color: t.faint, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
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
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  mono?: boolean;
  /**
   * Names this specific input.
   *
   * Needed because `Field` names a *group* rather than a control — a row
   * holding two number boxes ("Grid": reels and rows) has no single element
   * its label could attach to. For a row with one input the group name is
   * usually enough; pass this wherever the individual control needs its own
   * name, which is every row holding more than one.
   */
  label?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      {...(label ? { "aria-label": label } : {})}
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
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  disabled?: boolean;
  /** Names this specific input — see `TextInput`'s `label`. Required in
   * practice for any row holding more than one control, because `Field`
   * names the group and a group name is not announced on focus. */
  label?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      min={min}
      disabled={disabled}
      {...(label ? { "aria-label": label } : {})}
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
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Names this specific select — see `TextInput`'s `label`. */
  label?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      {...(label ? { "aria-label": label } : {})}
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
