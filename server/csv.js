// CSV cells an agent can influence (a resource path, a model name, a reason,
// a tag) must not open with a spreadsheet formula: Excel and Sheets execute a
// cell that starts with = + - @ (or a tab/CR ahead of one) — =HYPERLINK(...)
// in an exported ledger is a phishing link with the operator's trust behind
// it. OWASP's fix is a leading apostrophe, which the spreadsheet shows as
// text. Plain numbers (a negative amount) pass through untouched.
export function neutralizeFormula(value) {
  const s = String(value ?? "");
  if (!/^[=+\-@\t\r]/.test(s) || /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s)) return s;
  return `'${s}`;
}

// One cell, quoted only when it needs to be (FOCUS export style).
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = neutralizeFormula(typeof value === "object" ? JSON.stringify(value) : String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
