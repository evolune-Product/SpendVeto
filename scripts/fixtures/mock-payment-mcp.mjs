// A stand-in payment provider for scripts/verify.mjs: a real MCP server over
// stdio, with Razorpay's tool names and amounts in paise, that appends every
// call it receives to MOCK_MCP_LOG — so the suite can prove a refused call
// never reached the provider. Never a real payment API.
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const LOG = process.env.MOCK_MCP_LOG;
const seen = (tool, args) => LOG && appendFileSync(LOG, JSON.stringify({ tool, args }) + "\n");
const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const server = new McpServer({ name: "mock-razorpay", version: "1.0.0" });

server.registerTool("fetch_payment", { description: "Fetch a payment by id", inputSchema: { payment_id: z.string() } }, async (args) => {
  seen("fetch_payment", args);
  return json({ id: args.payment_id, entity: "payment", amount: 40000, currency: "INR", status: "captured" });
});
server.registerTool("create_refund", { description: "Refund a payment (amount in paise; omit for a full refund)", inputSchema: { payment_id: z.string(), amount: z.number().optional(), notes: z.record(z.string(), z.string()).optional() } }, async (args) => {
  seen("create_refund", args);
  if (args.payment_id === "pay_fail") return { isError: true, content: [{ type: "text", text: "BAD_REQUEST_ERROR: the payment has already been fully refunded" }] };
  return json({ id: `rfnd_${Date.now()}`, entity: "refund", payment_id: args.payment_id, amount: args.amount ?? 40000, currency: "INR", status: "processed" });
});
server.registerTool("create_payment_link", { description: "Create a payment link", inputSchema: { amount: z.number(), description: z.string().optional() } }, async (args) => {
  seen("create_payment_link", args);
  return json({ id: "plink_1", short_url: "https://rzp.io/i/mock", amount: args.amount });
});
server.registerTool("revoke_token", { description: "Revoke a customer's saved payment token", inputSchema: { customer_id: z.string(), token_id: z.string() } }, async (args) => {
  seen("revoke_token", args);
  return json({ deleted: true });
});
server.registerTool("create_brand_new_widget", { description: "A tool no profile knows", inputSchema: { name: z.string().optional() } }, async (args) => {
  seen("create_brand_new_widget", args);
  return json({ ok: true });
});

await server.connect(new StdioServerTransport());
