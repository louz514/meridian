import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dataPath } from "../dataDir.js";
import { SEGMENTS } from "./segments.js";

/**
 * The RWA universe: the aggregated output of the research fleet. Segment
 * research agents (see orchestration.ts) call the `meridian_submit_research`
 * MCP tool to upsert venues here; the read-side `meridian_market_universe`
 * tool serves it to the trading agent. Persisted to rwa-universe.json so
 * data survives process restarts.
 */
export interface Venue {
  name: string;
  url?: string;
  segment?: string;
  chains?: string[];
  tokenizes?: string;
  tvlUsd?: string;
  tvlAsOf?: string;
  yieldPct?: string;
  assetTickers?: string[];
  custodyModel?: string;
  accessModel?: string;
  jurisdiction?: string;
  /** how Meridian can pull data / route liquidity */
  integrationNotes?: string;
  /** rest-api | graphql-subgraph | onchain-contract | oracle | csv-dashboard | none-scrape-only */
  dataSourceType?: string;
  sources?: string[];
  confidence?: "high" | "medium" | "low";

  // --- signal data points (what the sellable signal is actually built on) ---
  // Flows: is capital entering or leaving? The single strongest RWA signal.
  tvlTrend?: "rising" | "falling" | "stable";
  prevTvlUsd?: string;
  /** Yield momentum: direction of the rate, not just its level. */
  yieldTrend?: "rising" | "falling" | "stable";
  prevYieldPct?: string;
  /** Tradability — thin liquidity caps how much signal is actionable. */
  liquidityUsd?: string;
  volumeUsd24h?: string;
  /** Risk surface, e.g. ["depeg-history","redemption-gate","unaudited","single-issuer"]. */
  riskFlags?: string[];
  redemptionTerms?: string;
  feeStructure?: string;
  listingDate?: string;

  // --- deliberation verdict (Tier 2/3 output attached to the venue) ---
  /** 0–100 conviction from the deliberation panel. */
  signalScore?: number;
  signalNote?: string;
  signalAsOf?: string;
  /** set by a verification pass */
  verified?: boolean;
  verifiedTvlUsd?: string;
  verifiedYieldPct?: string;
  verifyNote?: string;
  /** which research agent last wrote this venue, e.g. "rwa-research-treasuries" */
  submittedBy?: string;
  updatedAt?: string;
  /** true when the venue name matches a segment's known-anchor list — i.e. it's
   * something we already knew, not a genuinely new discovery. Set on upsert. */
  isAnchor?: boolean;
}

export interface UniverseFile {
  generatedForYear?: number;
  updatedAt?: string | null;
  segments: string[];
  counts?: Record<string, number>;
  venues: Venue[];
  discoveredButNotEnriched?: { name: string; segment?: string; url?: string }[];
  critic?: unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
// The committed bootstrap seed (read-only, ships inside the image).
const SEED_PATH = join(here, "rwa-universe.json");
// The live store: MUST live on the persistent /data volume, or every redeploy
// (a new container) wipes everything the research swarm has gathered. The old
// default wrote inside the image and silently lost all data on each deploy.
const DB_PATH = process.env.MERIDIAN_UNIVERSE_PATH ?? dataPath("rwa-universe.json");

const norm = (n: string | undefined) => (n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Known-anchor names across every segment (strip parenthetical tickers), used
// to tag whether a submitted venue is something we already knew vs. a genuinely
// new find. Short names (< 4 chars) are skipped to avoid spurious substring hits.
const ANCHOR_KEYS = [
  ...new Set(
    SEGMENTS.flatMap((s) =>
      s.anchors
        .split(",")
        .map((a) => norm(a.replace(/\(.*?\)/g, "")))
        .filter((a) => a.length >= 4),
    ),
  ),
];
function matchesAnchor(name: string): boolean {
  const n = norm(name);
  if (!n) return false;
  return ANCHOR_KEYS.some((a) => n.includes(a) || a.includes(n));
}

class UniverseStore {
  private data: UniverseFile;

  constructor() {
    this.data = this.readFromDisk();
  }

  private readFromDisk(): UniverseFile {
    // Prefer the persistent store; fall back to the committed seed on first
    // boot (before anything has been written to /data).
    for (const path of [DB_PATH, SEED_PATH]) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UniverseFile>;
        return { ...parsed, segments: parsed.segments ?? [], venues: parsed.venues ?? [] };
      } catch {
        /* try next */
      }
    }
    return { segments: [], venues: [] };
  }

  private persist(): void {
    try {
      writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error("[universe] failed to persist rwa-universe.json:", err);
    }
  }

  all(): Venue[] {
    return this.data.venues;
  }

  status() {
    const segmentCounts: Record<string, number> = {};
    for (const v of this.data.venues) {
      const key = v.segment ?? "unknown";
      segmentCounts[key] = (segmentCounts[key] ?? 0) + 1;
    }
    return {
      totalVenues: this.data.venues.length,
      updatedAt: this.data.updatedAt ?? null,
      segmentCounts,
    };
  }

  forChain(chain: string): Venue[] {
    const needle = chain.toLowerCase();
    return this.data.venues.filter((v) => (v.chains ?? []).some((c) => c.toLowerCase().includes(needle)));
  }

  forSegment(segment: string): Venue[] {
    const needle = segment.toLowerCase();
    return this.data.venues.filter((v) => (v.segment ?? "").toLowerCase().includes(needle));
  }

  search(query: string): Venue[] {
    const q = query.toLowerCase();
    return this.data.venues.filter((v) =>
      [v.name, v.segment, v.tokenizes, (v.assetTickers ?? []).join(" "), (v.chains ?? []).join(" ")]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }

  /**
   * Upsert venues by (case/punctuation-insensitive) name. A research agent
   * calls this via the `meridian_submit_research` MCP tool; later submissions
   * for the same venue overwrite earlier fields but keep unset fields.
   */
  upsertMany(venues: Venue[], submittedBy?: string): { upserted: number; total: number } {
    const now = new Date().toISOString();
    const byKey = new Map(this.data.venues.map((v) => [norm(v.name), v] as const));
    for (const incoming of venues) {
      if (!incoming.name) continue;
      const key = norm(incoming.name);
      const existing = byKey.get(key);
      const merged: Venue = {
        ...existing,
        ...incoming,
        submittedBy: submittedBy ?? incoming.submittedBy ?? existing?.submittedBy,
        updatedAt: now,
        isAnchor: matchesAnchor(incoming.name),
      };
      byKey.set(key, merged);
    }
    this.data.venues = [...byKey.values()];
    this.data.updatedAt = now;
    this.persist();
    return { upserted: venues.length, total: this.data.venues.length };
  }
}

let singleton: UniverseStore | null = null;

export function getUniverseStore(): UniverseStore {
  if (!singleton) singleton = new UniverseStore();
  return singleton;
}

/**
 * Whether a venue name is already known to the universe — same normalized-name
 * key the upsert dedupes on, plus the anchor list. The scout-to-earn novelty
 * gate: a bounty accrues only for names this returns false for.
 */
export function isKnownVenue(name: string): boolean {
  const key = norm(name);
  if (!key) return true; // unusable name counts as "not novel"
  if (matchesAnchor(name)) return true;
  return getUniverseStore()
    .all()
    .some((v) => norm(v.name) === key);
}
