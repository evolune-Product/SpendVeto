// Display helpers. JSX escapes text, so there is no esc() any more.
export const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");
export const money = (n) => `$${Number(n || 0).toFixed(4).replace(/0{1,2}$/, "")}`;
// Locale/timezone dependent — only ever called on polled data, which the
// prerender never has, so it can't cause a hydration mismatch.
export const when = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "—");
export const csv = (v) => (v.trim() ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
