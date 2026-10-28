// Credentials for reading this server's API once auth is on (an API key exists,
// or SPENDVETO_REQUIRE_AUTH=1): every read except the public ones then needs a
// viewer key. SPENDVETO_INTERNAL_TOKEN is the server's own per-boot token, set
// in its process (server/index.js) so the policy checks it runs in-process can
// read the ledger; SPENDVETO_API_KEY is an operator-minted key
// (`npm run apikey -- viewer`) for the local tools — the agent client, the
// proxy, the MCP server and the CLI. Open mode needs neither.
export function apiAuthHeaders() {
  const key = process.env.SPENDVETO_INTERNAL_TOKEN || process.env.SPENDVETO_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}
