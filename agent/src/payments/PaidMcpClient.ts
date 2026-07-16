// The consumer side of the payment rail: call a priced MCP tool, and if the
// server answers with a 402 challenge, pay it on-chain and retry — the full
// x402 loop with no human in it. This is what turns the tool catalog into a
// working economy: any agent with a funded wallet can use this (or replicate
// its ~40 lines) to buy Meridian signals autonomously.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { X402Client } from "./X402Client.js";
import type { X402Requirements } from "./PaymentGate.js";
import { config } from "../config.js";

export interface PaidCallResult {
  content: unknown;
  paid: boolean;
  /** on-chain tx hash of the settlement when a payment was made */
  paymentTx?: string;
}

function extractChallenge(message: string): X402Requirements | null {
  const start = message.indexOf('{"x402Version"');
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start)) as X402Requirements;
  } catch {
    // The JSON may be embedded with trailing text; walk to the balanced close.
    let depth = 0;
    for (let i = start; i < message.length; i++) {
      if (message[i] === "{") depth++;
      if (message[i] === "}") depth--;
      if (depth === 0) {
        try {
          return JSON.parse(message.slice(start, i + 1)) as X402Requirements;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

async function callOnce(url: string, bearer: string | undefined, tool: string, args: Record<string, unknown>, paymentHeader?: string) {
  const headers: Record<string, string> = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: "meridian-paid-client", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: tool, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Call `tool` on the MCP server at `url`; transparently settle a 402
 * challenge in USDG on Robinhood Chain and retry. One payment buys one call.
 */
export async function paidToolCall(opts: {
  tool: string;
  args?: Record<string, unknown>;
  url?: string;
  bearer?: string;
}): Promise<PaidCallResult> {
  const url = opts.url ?? config.publicMcpUrl;
  const bearer = opts.bearer ?? config.mcpToken;
  const args = opts.args ?? {};

  try {
    const result = await callOnce(url, bearer, opts.tool, args);
    return { content: result.content, paid: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const challenge = extractChallenge(message);
    if (!challenge) throw err; // not a payment problem — surface it

    const payer = new X402Client(config.x402FacilitatorUrl);
    const header = await payer.settleChallenge(challenge);
    const paymentTx = JSON.parse(Buffer.from(header, "base64").toString("utf8")).txHash as string;
    const result = await callOnce(url, bearer, opts.tool, args, header);
    return { content: result.content, paid: true, paymentTx };
  }
}
