// Wallet-native "your own agent, day one." A verified wallet (SIWE) gets its
// OWN Merid instance provisioned on the OpenHermit gateway — real, isolated,
// and immediately conversational. Day-one scope is an advisor: it reasons over
// Meridian's live signal and explains what it would trade and why, but moves no
// funds (self-custody; live execution is a later, explicitly-enabled step).
//
// Identity is the wallet. We map wallet -> deterministic agentId ourselves and
// talk to that agent through gw.agent(agentId), which owns the session/message
// surface (postMessageSync, listSessionMessages).
import { GatewayClient } from "@openhermit/sdk";
import { appendFileSync } from "node:fs";
import { config } from "../config.js";
import { dataPath } from "../dataDir.js";
import { universe } from "../state.js";

const USER_AGENTS_PATH = dataPath("user-agents.jsonl");

// Provisioned agents are ensured (idempotent) at most once per short window per
// wallet, so repeated sign-ins/messages don't hammer the gateway with config
// writes. In-memory; a restart just re-ensures on next contact.
const ensuredAt = new Map<string, number>();
const ENSURE_TTL_MS = 5 * 60 * 1000;

// Sessions must be explicitly opened before postMessageSync (it does not
// auto-create). Track which we've opened this process so we open once.
const openedSessions = new Set<string>();

function gateway(): GatewayClient | null {
  if (!config.gatewayAdminToken || !config.gatewayUrl) return null;
  return new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
}

// User chat agents connect to Meridian through THIS registration, which carries
// NO operator credentials — unlike the trusted "meridian" server used by the
// research fleet (registered with the operator bearer in orchestration.ts). So
// a user's agent can reach free/x402 data tools but never the operator-only
// research-write tool, and never (with the execute-token gate) the fund-moving
// tools. Defense in depth on top of that gate: user agents simply never hold
// the shared token.
const PUBLIC_MCP_ID = "meridian-public";
const OPERATOR_MCP_ID = "meridian";
let publicServerRegistered = false;

async function ensurePublicMcpServer(gw: GatewayClient): Promise<void> {
  if (publicServerRegistered) return;
  try {
    await gw.registerMcpServer({
      id: PUBLIC_MCP_ID,
      name: "Meridian (public)",
      description: "Meridian market data and signal tools. No operator credentials; execute and research-write tools are not reachable.",
      url: config.publicMcpUrl,
      // Deliberately NO headers: user agents must never carry the operator bearer.
    });
  } catch {
    // Already registered (or a race) — fine; it's an idempotent upsert intent.
  }
  publicServerRegistered = true;
}

/** Deterministic, valid gateway agent id for a wallet (hex is a safe slug). */
export function agentIdForWallet(address: string): string {
  return `mrdn-u-${address.toLowerCase().replace(/^0x/, "")}`;
}

/** One durable chat thread per wallet. */
function sessionIdForWallet(address: string): string {
  return `chat-${address.toLowerCase()}`;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// House style forbids em dashes; models slip them in anyway, so strip them from
// replies deterministically. Only em dash and " -- " (never en dash, which the
// agent may legitimately use in numeric ranges).
function deEmDash(s: string): string {
  return s.replace(/\s*—\s*/g, ", ").replace(/ -- /g, ", ");
}

// A live snapshot of what Meridian's research swarm has gathered, injected into
// the persona so the agent can cite real RWA venues without a paid tool call.
function censusLine(): string {
  const status = universe.status();
  if (!status.totalVenues) return "";
  const discoveries = universe
    .all()
    .filter((v) => !v.isAnchor)
    .slice(-14)
    .map((v) => v.name);
  const list = discoveries.length ? ` Recent discoveries you can name if relevant: ${discoveries.join(", ")}.` : "";
  return `Meridian's research swarm has mapped ${status.totalVenues} tokenized-RWA venues across the market so far.${list} When the user asks what is happening in tokenized RWAs, draw on this; do not invent venues beyond it.`;
}

// The day-one persona. No em dashes (house style). Grounds the agent in the
// real strategy and the FREE Meridian tools, and hard-codes the custody honesty
// rules so it never claims to move funds it cannot touch.
function personaFor(address: string): string {
  return [
    `You are Merid, a market-making agent on Robinhood Chain, now running as the personal agent of the wallet ${shortAddr(address)} (${address.toLowerCase()}).`,
    ``,
    `Your job today is to be this person's hands-on market-making strategist for tokenized equities. You know the exact strategy Meridian's house agent runs live:`,
    `- Provide concentrated liquidity in depth-verified pools (NVDA, AAPL, TSLA, GOOGL, META against USDG on Uniswap v4).`,
    `- Earn the fee every trader pays. Re-center when price walks out of range, widen the range for the weekend, and step aside before toxic flow.`,
    `- Only enter a pool that clears a cost-aware bar (expected fees must beat roughly 3x the round-trip pool fee). Never churn for its own sake.`,
    ``,
    `For real-time positions, live prices, and exactly what the house agent is doing this minute, point the user to the live desk at meridian402.xyz. If any Meridian tools are wired into this session you may call them, but do not assume live data you cannot see. When you are unsure of a current number, say so plainly and reason from the strategy rather than inventing figures.`,
    ``,
    `Rules you never break:`,
    `- You do not hold or move this user's funds. Their wallet is self-custodied. You cannot place a real trade yet; live execution turns on only after they fund a dedicated agent wallet and enable it (coming soon). Say so plainly whenever asked to buy, sell, or trade.`,
    `- Never invent positions, prices, or performance. If you lack live data, say so and point to the live desk at meridian402.xyz.`,
    ``,
    `How you talk (this matters as much as what you know):`,
    `- You are talking one-on-one with a real person. Be warm, natural, and conversational, like texting a sharp trader friend who genuinely wants to help. Never a report, never a brochure.`,
    `- Default to SHORT replies, two or three sentences. Only go longer or use a list if they actually ask you to break something down.`,
    `- Use "you" and "I". Get curious about them: what are they trying to do, how much are they thinking about putting in, how do they feel about risk. Ask, do not assume.`,
    `- Do not reintroduce yourself after your first message. Do not lecture. Cut all hype. Plain words, a little personality, and never any em dashes.`,
    `- Match their energy and length. A simple question gets a simple, direct answer.`,
    ``,
    censusLine(),
  ]
    .filter(Boolean)
    .join("\n");
}

export interface EnsureResult {
  agentId: string;
  ready: boolean;
  created: boolean;
  reason?: string;
}

/**
 * Idempotently provision (and keep configured) this wallet's agent. Safe to
 * call on every sign-in; throttled per wallet. Returns ready:false with a
 * reason when the gateway is not configured, so callers can degrade cleanly.
 */
export async function ensureUserAgent(address: string): Promise<EnsureResult> {
  const agentId = agentIdForWallet(address);
  const gw = gateway();
  if (!gw) return { agentId, ready: false, created: false, reason: "gateway_unconfigured" };

  const last = ensuredAt.get(agentId);
  if (last && Date.now() - last < ENSURE_TTL_MS) return { agentId, ready: true, created: false };

  const owner = process.env.MERIDIAN_FLEET_OWNER_USER_ID || undefined;
  const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
  const created = !existing.has(agentId);
  if (created) {
    await gw.createAgent({ agentId, name: `Merid · ${shortAddr(address)}`, sandbox: null, ownerUserId: owner });
    appendFileSync(USER_AGENTS_PATH, JSON.stringify({ address: address.toLowerCase(), agentId, at: Date.now() }) + "\n");
  }
  // Wire the live signal feed via the CREDENTIAL-FREE public registration, and
  // make sure the operator-tokened "meridian" server is NOT enabled for this
  // user agent (it may have been, on agents created before this isolation).
  await ensurePublicMcpServer(gw);
  await gw.enableMcpServer(PUBLIC_MCP_ID, agentId);
  try {
    await gw.disableMcpServer(OPERATOR_MCP_ID, agentId);
  } catch {
    // Was never enabled — nothing to disable.
  }
  // putAgentConfig REPLACES the whole config, so we must merge our model
  // override into the complete default the gateway wrote at create time. Sending
  // a partial config fails validation (workspace_root / memory / max_tokens).
  const current = (await gw.getAgentConfig(agentId)) as Record<string, unknown>;
  const curModel = (current.model ?? {}) as Record<string, unknown>;
  await gw.putAgentConfig(agentId, {
    ...current,
    // Backfill required fields defensively in case an agent from an earlier
    // build has a partial config; new agents already carry the gateway default.
    workspace_root: typeof current.workspace_root === "string" ? current.workspace_root : `/agents/${agentId}`,
    memory: current.memory && typeof current.memory === "object" ? current.memory : { introspection: {} },
    model: {
      ...curModel,
      provider: process.env.MERIDIAN_USER_MODEL_PROVIDER ?? "openrouter",
      model: process.env.MERIDIAN_USER_MODEL_ID ?? "anthropic/claude-haiku-4.5",
      max_tokens: typeof curModel.max_tokens === "number" ? curModel.max_tokens : 8192,
    },
  });
  await gw.setInstruction(agentId, "persona", personaFor(address));
  ensuredAt.set(agentId, Date.now());
  return { agentId, ready: true, created };
}

export interface AgentReply {
  text: string;
  toolCalls: { tool: string; isError: boolean }[];
  error?: string;
}

/** Open the wallet's chat session if we haven't this process (idempotent). */
async function ensureSession(gw: GatewayClient, agentId: string, sessionId: string): Promise<void> {
  if (openedSessions.has(sessionId)) return;
  try {
    await gw.agent(agentId).openSession({
      sessionId,
      source: { kind: "api", interactive: true, type: "direct" },
    });
  } catch (err) {
    // Already open (or a race): postMessageSync will confirm. Log for visibility.
    console.error(`[my-agent] openSession ${sessionId}:`, err instanceof Error ? err.message : err);
  }
  openedSessions.add(sessionId);
}

/** Send one turn to the wallet's agent and wait for its reply. */
export async function messageUserAgent(address: string, text: string): Promise<AgentReply> {
  const gw = gateway();
  if (!gw) throw new Error("gateway_unconfigured");
  await ensureUserAgent(address); // cheap after first call; guarantees the agent exists
  const agentId = agentIdForWallet(address);
  const sessionId = sessionIdForWallet(address);
  await ensureSession(gw, agentId, sessionId);
  const resp = await gw.agent(agentId).postMessageSync(sessionId, { text }, { timeout: 90_000 });
  return {
    text: deEmDash(resp.text ?? ""),
    toolCalls: (resp.toolCalls ?? []).map((t) => ({ tool: t.tool, isError: t.isError })),
    error: resp.error,
  };
}

/**
 * Stream one turn as it generates. Returns the gateway's event iterable
 * (text_delta / text_final / tool_call / error / agent_end) after guaranteeing
 * the agent and session exist. The caller forwards events to the browser as SSE
 * so the user sees tokens appear immediately instead of waiting for the whole
 * reply — the single biggest smoothness win under load.
 */
export async function streamUserAgent(address: string, text: string, signal?: AbortSignal) {
  const gw = gateway();
  if (!gw) throw new Error("gateway_unconfigured");
  await ensureUserAgent(address);
  const agentId = agentIdForWallet(address);
  const sessionId = sessionIdForWallet(address);
  await ensureSession(gw, agentId, sessionId);
  return gw.agent(agentId).postMessageStream(sessionId, { text }, { signal });
}

/** Strip em dashes from a streamed chunk (exported for the SSE forwarder). */
export function sanitizeChunk(s: string): string {
  return deEmDash(s);
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool" | "error" | "introspection";
  content: string;
  ts: string;
}

/** Prior conversation for this wallet's thread (empty on a fresh account). */
export async function userAgentHistory(address: string): Promise<ChatTurn[]> {
  const gw = gateway();
  if (!gw) return [];
  const agentId = agentIdForWallet(address);
  const sessionId = sessionIdForWallet(address);
  try {
    const msgs = await gw.agent(agentId).listSessionMessages(sessionId);
    return msgs.map((m) => ({ role: m.role, content: m.content, ts: m.ts }));
  } catch {
    return []; // session not created yet, or agent brand new
  }
}
