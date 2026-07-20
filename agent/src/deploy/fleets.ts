// Fleet deployment on OpenHermit: one agent per mandate, shared risk posture.
// Two paths, same spec:
//   hosted  — provisioned on OUR gateway (tenant-facing API comes later; the
//             Profiler's single-profile reservations already flow through
//             here as fleets of one)
//   export  — a self-host bundle the user runs against THEIR OpenHermit
//             gateway, holding their own keys and paying for the Meridian
//             MCP feed via x402. Contains no Meridian secrets by design.
import { GatewayClient } from "@openhermit/sdk";
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { config } from "../config.js";
import { dataPath } from "../dataDir.js";

const FLEETS_PATH = dataPath("fleets.jsonl");

// Mandate ids match the site's Profiler. "momentum"/"basis" were retired
// 2026-07-14 in favor of the measured taxonomy: market-maker (the flagship,
// the playbook the house agent runs live), carry, and signals (basis-class
// research trading behind cost-aware bars).
export const MANDATES = ["market-maker", "carry", "signals"] as const;
export type Mandate = (typeof MANDATES)[number];
export const POSTURES = {
  cautious: { perTrade: 50, daily: 150 },
  balanced: { perTrade: 180, daily: 360 },
  aggressive: { perTrade: 500, daily: 1500 },
} as const;
export type Posture = keyof typeof POSTURES;

export interface FleetSpec {
  fleetId: string;
  owner: string | null; // wallet address, when bound
  mandates: Mandate[]; // 1-3, one agent each
  posture: Posture;
  at: number;
}

function djb2(s: string): string {
  let h = 5381;
  for (const c of s) h = (h * 33) ^ c.charCodeAt(0);
  return (h >>> 0).toString(36).toUpperCase().slice(0, 6);
}

/** Deterministic for the same owner+shape, so re-exports don't mint new fleets. */
export function fleetIdFor(owner: string | null, mandates: Mandate[], posture: Posture): string {
  return `mrdn-fleet-${djb2(`${owner ?? "anon"}:${[...mandates].sort().join("+")}:${posture}`).toLowerCase()}`;
}

export function validateFleet(body: unknown): FleetSpec | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") return null;
  const raw = Array.isArray(b.mandates) ? b.mandates : [];
  const mandates = [...new Set(raw.filter((m): m is Mandate => MANDATES.includes(m as never)))];
  const posture = typeof b.posture === "string" && b.posture in POSTURES ? (b.posture as Posture) : null;
  const owner = typeof b.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.wallet) ? b.wallet : null;
  if (mandates.length < 1 || mandates.length > 3 || !posture) return null;
  return { fleetId: fleetIdFor(owner, mandates, posture), owner, mandates, posture, at: Date.now() };
}

// Signal-fleet cadences: how often each mandate's agent wakes to evaluate.
// Market-making needs range checks through market hours; carry re-checks
// yields daily; signals cares about the NYSE open (13:25 UTC, weekdays).
const SCHEDULES: Record<Mandate, { cron: string; prompt: string }> = {
  "market-maker": {
    cron: "*/30 13-20 * * 1-5",
    prompt: "Check LP conditions via meridian_lp_score and the meridian market tools: which pools are fee-positive, whether ranges would sit in-range, and record your placement read with reasoning. Do not execute.",
  },
  carry: {
    cron: "0 13 * * *",
    prompt: "Re-check yield-bearing RWA venues via the meridian MCP tools and record whether idle capital placement should change. Do not execute trades.",
  },
  signals: {
    cron: "25 13 * * 1-5",
    prompt: "Compare on-chain pool prices against the incoming NYSE open via the meridian MCP tools and record the convergence read. Do not execute trades.",
  },
};

function instructionFor(mandate: Mandate, spec: FleetSpec): string {
  const caps = POSTURES[spec.posture];
  const mandateLine =
    mandate === "market-maker"
      ? "Mandate: market making — concentrated liquidity in depth-verified pools, earning fees, with re-center and weekend-pull discipline."
      : mandate === "carry"
        ? "Mandate: yield carry — track yield-bearing RWAs from the Meridian feed for idle-capital placement."
        : "Mandate: signal trading — track the gap between 24/7 pool prices and real-market prints, acting only past cost-aware bars.";
  return (
    `You are one agent of Meridian fleet ${spec.fleetId}. ${mandateLine} ` +
    `Hard risk caps for this fleet: $${caps.perTrade} per trade, $${caps.daily} per day; never plan beyond them. ` +
    `Market data, tradable universe, and routes come from the meridian MCP server. ` +
    `You observe, evaluate, and record decisions${spec.owner ? ` for owner ${spec.owner}` : ""}; ` +
    `you never execute until the owner completes funding and explicitly enables live trading.`
  );
}

export interface AgentPlan {
  agentId: string;
  name: string;
  instruction: string;
  schedule: { id: string; cron: string; prompt: string };
}

export function planFleet(spec: FleetSpec): AgentPlan[] {
  return spec.mandates.map((m) => ({
    agentId: `${spec.fleetId}-${m}`,
    name: `Meridian ${spec.fleetId.replace("mrdn-fleet-", "").toUpperCase()} · ${m}`,
    instruction: instructionFor(m, spec),
    schedule: { id: `${spec.fleetId}-${m}-tick`, cron: SCHEDULES[m].cron, prompt: SCHEDULES[m].prompt },
  }));
}

export function recordFleet(spec: FleetSpec, kind: "hosted" | "export"): void {
  appendLedger("fleets.jsonl", { ...spec, kind });
}

/** Provision a fleet on OUR gateway. Queue-honest without an admin token. */
export async function provisionFleetSpec(spec: FleetSpec): Promise<"provisioned" | "queued"> {
  const plans = planFleet(spec);
  if (!config.gatewayAdminToken) {
    for (const p of plans) console.error(`[fleet-deploy] queued ${p.agentId} (no gateway token)`);
    return "queued";
  }
  const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
  // Gateway schedules need an owning user (admin-mode has no auth.userId);
  // fleet agents are owned by the platform operator's gateway user.
  const owner = process.env.MERIDIAN_FLEET_OWNER_USER_ID || undefined;
  const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
  for (const p of plans) {
    if (!existing.has(p.agentId)) {
      await gw.createAgent({ agentId: p.agentId, name: p.name, sandbox: null, ownerUserId: owner });
    }
    await gw.enableMcpServer("meridian", p.agentId);
    // Pin the model so a provisioned agent can actually run its reasoning.
    // Cheap signal work → Haiku-class via OpenRouter (the key set on the
    // gateway). Overridable per deployment.
    await gw.putAgentConfig(p.agentId, {
      model: {
        provider: process.env.MERIDIAN_FLEET_MODEL_PROVIDER ?? "openrouter",
        model: process.env.MERIDIAN_FLEET_MODEL_ID ?? "anthropic/claude-haiku-4.5",
      },
    });
    await gw.setInstruction(p.agentId, "fleet-profile", p.instruction);
    await gw.createSchedule(p.agentId, {
      type: "cron",
      id: p.schedule.id,
      cronExpression: p.schedule.cron,
      prompt: p.schedule.prompt,
      ...(owner ? { createdBy: owner } : {}),
    } as Parameters<GatewayClient["createSchedule"]>[1]);
    console.error(`[fleet-deploy] ✓ ${p.agentId}`);
  }
  return "provisioned";
}

/**
 * Self-host bundle: everything a user needs to run this fleet on their own
 * OpenHermit gateway. Deliberately contains NO Meridian secrets — the MCP
 * registration carries no bearer token; their agents pay per call via x402
 * from their own payer wallet.
 */
export function exportBundle(spec: FleetSpec): Record<string, string> {
  const plans = planFleet(spec);
  // publicMcpUrl can be configured empty in dev; an exported bundle must
  // always point somewhere real, so fall back to the production endpoint.
  const mcpUrl = config.publicMcpUrl || "https://api.meridian402.xyz/mcp";

  const provision = `// Provision Meridian fleet ${spec.fleetId} on YOUR OpenHermit gateway.
// Usage: OPENHERMIT_GATEWAY_URL=... GATEWAY_ADMIN_TOKEN=... node provision.mjs
import { GatewayClient } from "@openhermit/sdk";
import { readFileSync } from "node:fs";

const { mcpUrl, agents } = JSON.parse(readFileSync(new URL("./fleet.json", import.meta.url), "utf8"));
const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });

await gw.registerMcpServer({
  id: "meridian",
  name: "Meridian",
  description: "Tokenized-RWA market data, universe, and routing (x402-priced per call)",
  url: mcpUrl,
});

const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
for (const a of agents) {
  if (!existing.has(a.agentId)) await gw.createAgent({ agentId: a.agentId, name: a.name, sandbox: null });
  await gw.enableMcpServer("meridian", a.agentId);
  await gw.setInstruction(a.agentId, "fleet-profile", a.instruction);
  await gw.createSchedule(a.agentId, { type: "cron", id: a.schedule.id, cronExpression: a.schedule.cron, prompt: a.schedule.prompt });
  console.log("provisioned", a.agentId);
}
console.log("fleet ${spec.fleetId} is live on your gateway");
`;

  const readme = `# Meridian fleet ${spec.fleetId}

${plans.length} agent(s): ${spec.mandates.join(", ")} · posture: ${spec.posture}${spec.owner ? ` · owner ${spec.owner}` : ""}

Run this fleet on your own infrastructure. Your keys never leave your machine;
your agents pay for the Meridian signal feed per call via x402.

1. Run an OpenHermit gateway (quickstart: https://github.com/HCF-STUDIOS/openhermit).
2. npm install
3. OPENHERMIT_GATEWAY_URL=<your gateway> GATEWAY_ADMIN_TOKEN=<your admin token> node provision.mjs

The fleet observes and records decisions on its schedules. Execution stays off
until you fund an agent wallet and enable it yourself.
`;

  return {
    "fleet.json": JSON.stringify({ fleetId: spec.fleetId, mcpUrl, posture: spec.posture, caps: POSTURES[spec.posture], agents: plans }, null, 2),
    "provision.mjs": provision,
    "package.json": JSON.stringify({ name: spec.fleetId, private: true, type: "module", dependencies: { "@openhermit/sdk": "^0.7.0" } }, null, 2),
    "README.md": readme,
  };
}

/** Drain the fleet ledger against the gateway (hosted entries only). */
export async function provisionAllFleets(): Promise<void> {
  if (!existsSync(FLEETS_PATH)) {
    console.log("[fleet-deploy] no fleets recorded yet");
    return;
  }
  const lines = readFileSync(FLEETS_PATH, "utf8").trim().split("\n").filter(Boolean);
  const hosted = new Map<string, FleetSpec>();
  for (const l of lines) {
    try {
      const f = JSON.parse(l) as FleetSpec & { kind?: string };
      if (f.kind !== "export") hosted.set(f.fleetId, f);
    } catch {}
  }
  console.log(`[fleet-deploy] ${hosted.size} hosted fleet(s) recorded`);
  for (const f of hosted.values()) {
    try {
      await provisionFleetSpec(f);
    } catch (err) {
      console.error(`[fleet-deploy] ✗ ${f.fleetId}:`, err instanceof Error ? err.message : err);
    }
  }
}
