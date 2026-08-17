import { Field, NumberInput, TextInput } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Mirrors `BonusParamSpec` in `@slots-engine/math-engine`.
 *
 * Declared structurally rather than imported so the frontend does not take a
 * build dependency on the engine package. The shape is checked at runtime by
 * `/v1/bonus-modules` returning it, and the risk of the two drifting is the
 * reason `paramSchema` lives on the module in the first place — this type is
 * a description of a wire format, not a second source of truth.
 */
export interface BonusParamSpec {
  key: string;
  label: string;
  type: "number" | "integer" | "numberList";
  defaultValue: number | number[];
  min?: number;
  max?: number;
  help: string;
}

/**
 * Parses a comma- or space-separated list of numbers.
 *
 * Kept separate and exported so it can be tested without a DOM: a reward
 * table typed as text is the one input here that can be silently wrong, and
 * the module's own guard **drops non-numeric entries and then falls back to
 * its default if nothing survives**. So `"2, 3, x, 5"` does not fail — it
 * quietly becomes a different table, or the default table, and the game pays
 * out under numbers nobody chose.
 *
 * Returning the invalid entries rather than throwing lets the form say which
 * one is wrong while keeping the rest of the edit.
 */
export function parseNumberList(raw: string): { values: number[]; invalid: string[] } {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const values: number[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const parsed = Number(part);
    // `Number("")` is 0 and `Number(" ")` is 0, both already filtered above.
    // What remains is a genuine non-number, which must be reported rather
    // than dropped — dropping is exactly what the module does, and it is
    // what makes the failure silent.
    if (Number.isFinite(parsed)) values.push(parsed);
    else invalid.push(part);
  }
  return { values, invalid };
}

/**
 * Whether a value is outside what the module will accept.
 *
 * Returns the reason rather than a boolean, because the form's job here is
 * to explain. **Every module silently substitutes its default for anything
 * malformed** — no publish fails, no error surfaces, and the game simply
 * plays under different numbers. Saying so at the point of entry is the only
 * place this is catchable.
 */
export function violation(spec: BonusParamSpec, value: number): string | null {
  if (!Number.isFinite(value)) return `not a number — the module will use ${formatDefault(spec)}`;
  if (spec.type === "integer" && !Number.isInteger(value)) {
    return `must be a whole number — the module will round or ignore this`;
  }
  if (spec.min !== undefined && value < spec.min) {
    return `below the minimum of ${spec.min} — the module will use ${formatDefault(spec)}`;
  }
  if (spec.max !== undefined && value > spec.max) {
    return `above the maximum of ${spec.max} — the module will use ${formatDefault(spec)}`;
  }
  return null;
}

export function formatDefault(spec: BonusParamSpec): string {
  return Array.isArray(spec.defaultValue) ? spec.defaultValue.join(", ") : String(spec.defaultValue);
}

/**
 * A form for one bonus module's parameters, built from the engine's own
 * schema.
 *
 * This is F24's follow-up. That bug made every module *selectable* and left
 * its parameters a free-form JSON blob — so a designer could reach
 * `freeSpins` and still had no way to learn it reads `spinCount`,
 * `winMultiplier`, `retriggerSpins`, `maxRetriggers` and `assumedBaseRtp`.
 *
 * The schema is fetched, never hardcoded, for the reason F24 records: a list
 * kept in a second place drifts, and nothing fails when it does.
 *
 * **A module with no schema keeps the JSON editor** rather than showing an
 * empty form. An empty form would read as "this module takes no parameters",
 * which is a different and false statement.
 */
export function BonusParamsForm({
  schema,
  params,
  onChange,
}: {
  schema: BonusParamSpec[];
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  if (schema.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 11, color: t.muted, marginBottom: 4 }}>
          Parameters <span style={{ color: t.faint }}>· this module publishes no schema, so these are raw JSON</span>
        </div>
        <TextInput
          label="Parameters as raw JSON"
          mono
          value={JSON.stringify(params)}
          onChange={(value) => {
            try {
              onChange(JSON.parse(value) as Record<string, unknown>);
            } catch {
              /* keep the previous value until the text parses */
            }
          }}
        />
      </div>
    );
  }

  const set = (key: string, value: unknown): void => onChange({ ...params, [key]: value });

  /** Removing the key entirely rather than storing a blank is deliberate:
   * the module's fallback triggers on absence, so an empty field must mean
   * "use the default" and not "use zero". */
  const clear = (key: string): void => {
    const { [key]: _removed, ...rest } = params;
    onChange(rest);
  };

  return (
    <div>
      {schema.map((spec) => {
        const raw = params[spec.key];
        const isSet = raw !== undefined && raw !== null;

        if (spec.type === "numberList") {
          const current = Array.isArray(raw) ? (raw as unknown[]) : [];
          const text = current.join(", ");
          const { invalid } = parseNumberList(text);
          const nonNumeric = current.filter((v) => typeof v !== "number");

          return (
            <Field
              key={spec.key}
              label={spec.label}
              hint={isSet ? spec.help : `${spec.help} Default: ${formatDefault(spec)}.`}
            >
              <TextInput
                label={spec.label}
                mono
                value={text}
                placeholder={formatDefault(spec)}
                onChange={(value) => {
                  const parsed = parseNumberList(value);
                  if (value.trim() === "") clear(spec.key);
                  else set(spec.key, parsed.values);
                }}
              />
              {(invalid.length > 0 || nonNumeric.length > 0) && (
                <div style={{ fontSize: 11, color: t.warn, marginTop: 4 }}>
                  Ignored: {[...invalid, ...nonNumeric.map(String)].join(", ")} — the module drops entries it cannot read.
                </div>
              )}
            </Field>
          );
        }

        const numeric = typeof raw === "number" ? raw : Number.NaN;
        const problem = isSet ? violation(spec, numeric) : null;

        return (
          <Field
            key={spec.key}
            label={spec.label}
            hint={isSet ? spec.help : `${spec.help} Default: ${formatDefault(spec)}.`}
          >
            <NumberInput
              label={spec.label}
              value={numeric}
              step={spec.type === "integer" ? 1 : 0.01}
              min={spec.min}
              onChange={(value) => set(spec.key, value)}
            />
            {problem && <div style={{ fontSize: 11, color: t.warn, marginTop: 4 }}>{problem}</div>}
          </Field>
        );
      })}
    </div>
  );
}
