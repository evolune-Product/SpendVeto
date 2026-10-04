// One API, any rail. Every payment rail plugs in behind the same contract:
// { id, name, status, note, pay({ tool, account, chain, baseUrl }) → data }.
// The governance pipeline (policy → approval → pay) never cares which rail
// settles — that is the whole positioning, and this file is where it is true.
// Roadmap slots are declared but refuse honestly: no adapter pretends.
import x402Simulate from "./x402-simulate.js";
import x402Live from "./x402-testnet.js";
import safeAllowance from "./safe-allowance.js";

const roadmapRail = (id, name, note) => ({
  id,
  name,
  status: "roadmap",
  note,
  async pay() {
    throw new Error(
      `the "${id}" rail adapter is not implemented yet — it is a funded-roadmap slot behind the same pay() contract; x402 settles today (simulate + Base Sepolia)`
    );
  },
});

export const RAILS = [
  x402Simulate,
  x402Live,
  roadmapRail("google-ap2", "Google AP2", "mandate-based agent payments — adapter slot"),
  roadmapRail("openai-acp", "OpenAI ACP", "agentic checkout — adapter slot"),
  roadmapRail("npci-upi-agent", "NPCI UPI (Unified Agent Protocol / UPI Circle)", "India — governed today via /api/upi/evaluate; settlement is a slot: NPCI's agent protocol is not live and needs RBI approval. SpendVeto decides, it never initiates UPI"),
  roadmapRail("eu-sepa-pisp", "EU SEPA (PSD2 Open Banking / PISP)", "Eurozone — governed today via /api/eu/evaluate (RTS Strong Customer Authentication exemptions, SEPA Direct Debit pre-notification); settlement is a slot: initiating a SEPA payment requires PISP authorisation under a national competent authority, which SpendVeto does not hold. SpendVeto decides, it never initiates SEPA"),
  roadmapRail("uk-faster-payments-pisp", "UK Faster Payments (Open Banking / PISP)", "UK — governed today via /api/uk/evaluate (Confirmation of Payee, PSR APP fraud reimbursement exposure); settlement is a slot: initiating a Faster Payments transaction requires PISP authorisation from the FCA, which SpendVeto does not hold. SpendVeto decides, it never initiates Faster Payments"),
  roadmapRail("br-pix-automatico", "Brazil Pix (Pix Automático / Open Finance)", "Brazil — governed today via /api/br/evaluate (BCB nighttime limit, Pix Automático scheduling and retry rules); settlement is a slot: initiating Pix requires registration as a BCB-regulated participant, which SpendVeto does not hold. SpendVeto decides, it never initiates Pix"),
  roadmapRail("us-ach-nacha", "US ACH (Nacha Operating Rules)", "United States — governed today via /api/us/evaluate (Nacha WEB debit account validation, Regulation E consumer-authorization rules); settlement is a slot: originating an ACH entry requires an Originating Depository Financial Institution relationship, which SpendVeto does not hold. SpendVeto decides, it never originates ACH entries"),
  roadmapRail("stripe-mpp", "Stripe Machine Payments", "fiat machine payments — adapter slot"),
  safeAllowance,
];

export function getRail(id) {
  return RAILS.find((r) => r.id === id);
}

// Metadata-only view for APIs/UIs — never leaks the pay functions.
export function railsCatalog() {
  return RAILS.map(({ id, name, status, note }) => ({ id, name, status, note }));
}
