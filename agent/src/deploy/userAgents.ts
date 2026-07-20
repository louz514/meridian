// Profiler reservations -> OpenHermit user agents. Meridian is the funnel;
// every profile reserved on the site becomes an agent provisioned on the
// OpenHermit gateway, wired to the Meridian MCP signal feed (x402-priced).
// That onboarding is deliberately invisible from the frontend: nothing in the
// UI or bundle names the ecosystem, the plumbing lives entirely back here.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { fileURLToPath } from "node:url";
import { provisionFleetSpec, provisionAllFleets, fleetIdFor, type FleetSpec } from "./fleets.js";
import { dataPath } from "../dataDir.js";

const RESERVATIONS_PATH = dataPath("reservations.jsonl");

const MANDATES = ["market-maker", "carry", "signals"] as const;
const POSTURES = { cautious: { perTrade: 50, daily: 150 }, balanced: { perTrade: 180, daily: 360 }, aggressive: { perTrade: 500, daily: 1500 } } as const;

export interface ReservedProfile {
  callsign: string;
  mandate: (typeof MANDATES)[number];
  posture: keyof typeof POSTURES;
  wallet: string | null;
  at: number;
}

export function validateProfile(body: unknown): ReservedProfile | null {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") return null;
  const callsign = typeof b.callsign === "string" && /^MRDN-[A-Z0-9]{1,8}$/.test(b.callsign) ? b.callsign : null;
  const mandate = MANDATES.includes(b.mandate as never) ? (b.mandate as ReservedProfile["mandate"]) : null;
  const posture = typeof b.posture === "string" && b.posture in POSTURES ? (b.posture as ReservedProfile["posture"]) : null;
  const wallet = typeof b.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.wallet) ? b.wallet : null;
  if (!callsign || !mandate || !posture) return null;
  return { callsign, mandate, posture, wallet, at: Date.now() };
}

/** Append-only reservation ledger; survives restarts, drainable later. */
export function recordReservation(p: ReservedProfile): void {
  appendLedger("reservations.jsonl", p);
}

/** A reserved profile IS a fleet of one — same spec, same pipeline. */
export function profileToFleet(p: ReservedProfile): FleetSpec {
  return { fleetId: fleetIdFor(p.wallet, [p.mandate], p.posture), owner: p.wallet, mandates: [p.mandate], posture: p.posture, at: p.at };
}

/**
 * Provision one reserved profile via the fleet pipeline (fleets.ts). Without
 * an admin token this logs the plan and returns "queued" (the ledgers are
 * the source of truth; drain with `npm run provision-reserved` once the
 * token is set).
 */
export async function provisionUserAgent(p: ReservedProfile): Promise<"provisioned" | "queued"> {
  return provisionFleetSpec(profileToFleet(p));
}

/** Drain the reservation ledger against the gateway (run after setting GATEWAY_ADMIN_TOKEN). */
export async function provisionAllReserved(): Promise<void> {
  if (!existsSync(RESERVATIONS_PATH)) {
    console.log("[deploy] no reservations yet");
    return;
  }
  const lines = readFileSync(RESERVATIONS_PATH, "utf8").trim().split("\n").filter(Boolean);
  const latestByCallsign = new Map<string, ReservedProfile>();
  for (const l of lines) {
    try {
      const p = JSON.parse(l) as ReservedProfile;
      latestByCallsign.set(p.callsign, p);
    } catch {}
  }
  console.log(`[deploy] ${latestByCallsign.size} unique reserved profile(s)`);
  for (const p of latestByCallsign.values()) {
    try {
      await provisionUserAgent(p);
    } catch (err) {
      console.error(`[deploy] ✗ ${p.callsign}:`, err instanceof Error ? err.message : err);
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Drain both ledgers: single-profile reservations and multi-mandate fleets.
  provisionAllReserved()
    .then(() => provisionAllFleets())
    .catch((err) => {
      console.error("[deploy] crashed:", err);
      process.exit(1);
    });
}
