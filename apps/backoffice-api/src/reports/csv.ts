/**
 * CSV serialisation, RFC 4180.
 *
 * Hand-written rather than a dependency, because the whole job is one
 * escaping rule and a join — and the rule is the part worth being able to
 * read: a field containing a comma, a quote or a newline is wrapped in
 * quotes, and internal quotes are doubled.
 *
 * The reason this matters more than it looks: a transaction export is what
 * someone reconciles money against. A field that breaks out of its column
 * does not produce a visibly broken file — it produces a file that opens
 * cleanly in a spreadsheet with the values in the wrong columns.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown): string => {
    // `null` and `undefined` both become empty rather than the strings
    // "null"/"undefined", which is what `String()` would produce and what
    // a reconciliation would then read as data.
    const text = value === undefined || value === null ? "" : String(value);
    // `\r` is included alongside `\n`: a lone carriage return is a line
    // break to Excel, so a field containing one would split a row.
    return /["\n\r,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}
