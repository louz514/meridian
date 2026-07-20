// Deterministic opportunity scanner. Reads ONLY the samplers' measured ledgers
// (yield / lighter / basis) and reports what they observed — ranked, tagged by
// whether Meridian can actually access the opportunity, and annotated with data
// freshness and honest caveats. It never sources a number itself and never
// invents one: if a metric hasn't been measured yet, it says so. This is the
// grounded "find the best opportunities" layer, built on top of constant
// deterministic monitoring rather than an always-on LLM.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";

const TTL_MS = 60_000;

type Kind = "yield" | "basis" | "funding" | "lp";
interface Opportunity {
  kind: Kind;
  label: string;
  venue: string;
  metric: string; // the measured number, or an explicit "not measured yet" note
  metricValue: number | null; // numeric for ranking; null when unmeasured
  accessible: boolean; // can Meridian actually act on this, permissionlessly, today?
  accessNote?: string; // why not, when inaccessible
  depthUsd?: number | null;
  dataAgeMin: number | null;
  caveats: string[];
}

function readRows(file: string): any[] {
  try {
    const p = dataPath(file);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const ageMin = (ts?: number) => (typeof ts === "number" ? Math.round((Date.now() - ts) / 60000) : null);

let cache: { at: number; payload: unknown } | null = null;

export function opportunitiesSnapshot(): unknown {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.payload;
  const ops: Opportunity[] = [];

  // ---- yield sources (syrupUSDG + $INDEX), from yield-log ----
  const yl = readRows("yield-log.jsonl");
  const yLast = yl[yl.length - 1];
  if (yLast) {
    ops.push({
      kind: "yield",
      label: "Hold syrupUSDG (Maple credit)",
      venue: "syrupUSDG/USDG v4 pool",
      metric: yLast.measuredSyrupAprPct != null ? `${yLast.measuredSyrupAprPct}% measured APY` : `APY pending (need >24h history; ${yl.length} sample(s) so far)`,
      metricValue: yLast.measuredSyrupAprPct ?? null,
      accessible: true,
      depthUsd: yLast.syrupDepthUsd ?? null,
      dataAgeMin: ageMin(yLast.ts),
      caveats: ["exit only via the AMM pool (no on-chain NAV redeem here)", "borrower credit / USDG peg / contract risk"],
    });
    if (yLast.indexImpliedAprPct != null) {
      // trend needs two measured points >= ~6h apart
      const prior = yl.find((r) => r.indexImpliedAprPct != null && yLast.ts - r.ts >= 6 * 3600_000);
      const trend = prior ? (yLast.indexImpliedAprPct > prior.indexImpliedAprPct * 1.05 ? "rising" : yLast.indexImpliedAprPct < prior.indexImpliedAprPct * 0.95 ? "falling" : "flat") : "unknown";
      ops.push({
        kind: "yield",
        label: "$INDEX distribution",
        venue: "The Index",
        metric: `${yLast.indexImpliedAprPct}% implied APR (trend: ${trend})`,
        metricValue: yLast.indexImpliedAprPct,
        accessible: true,
        depthUsd: yLast.indexEligibleUsd ?? null,
        dataAgeMin: ageMin(yLast.ts),
        caveats: ["6% round-trip (3% entry + 3% exit)", "distributions are volume-driven, not durable", "single-product concentration risk"],
      });
    }
  }

  // ---- basis (spot vs NYSE), from basis-log: one row per ticker per sample ----
  const bl = readRows("basis-log.jsonl").filter((r) => typeof r.basisPct === "number");
  if (bl.length) {
    const newestTs = bl[bl.length - 1].ts;
    const latest = bl.filter((r) => r.ts === newestTs);
    const top = latest.sort((a, b) => Math.abs(b.basisPct) - Math.abs(a.basisPct))[0];
    if (top) {
      ops.push({
        kind: "basis",
        label: `Basis: ${top.symbol} pool vs NYSE`,
        venue: `${top.symbol}/USDG v4 pool`,
        metric: `${top.basisPct.toFixed(2)}% (pool ${top.poolUsd?.toFixed?.(2)} vs NYSE ${top.nyseUsd}, mkt ${top.nyseState})`,
        metricValue: Math.abs(top.basisPct),
        accessible: true,
        dataAgeMin: ageMin(top.ts),
        caveats: ["convergence is a directional bet at the open, not riskless", "thin spot depth caps size (~$hundreds-low-thousands)"],
      });
    }
  }

  // ---- perp funding (Lighter), from lighter-log — OBSERVED but NOT accessible ----
  const ll = readRows("lighter-log.jsonl").filter((r) => Array.isArray(r.m));
  const lLast = ll[ll.length - 1];
  if (lLast) {
    // biggest Lighter-native funding magnitude among markets (m = [sym,last,vol,trades,fundLighter,fundBinance])
    const withF = (lLast.m as any[]).filter((x) => typeof x[4] === "number");
    const top = withF.sort((a, b) => Math.abs(b[4]) - Math.abs(a[4]))[0];
    if (top) {
      ops.push({
        kind: "funding",
        label: `Perp funding: ${top[0]}`,
        venue: "Lighter (Robinhood Chain)",
        metric: `${(top[4] * 24 * 365 * 100).toFixed(0)}% annualized (per-hour ${top[4]})`,
        metricValue: Math.abs(top[4] * 24 * 365 * 100),
        accessible: false,
        accessNote: "Lighter trading is geo-blocked (code 20558); observed only",
        dataAgeMin: ageMin(lLast.ts),
        caveats: ["funding-period convention unverified; annualization assumes hourly", "not actionable from a restricted jurisdiction"],
      });
    }
  }

  // ---- stable-pair LP: depth is real, fee-APR is NOT measured yet ----
  if (yLast?.syrupDepthUsd) {
    ops.push({
      kind: "lp",
      label: "Stable-pair LP (USDe/USDG, syrupUSDG/USDG)",
      venue: "Uniswap v4",
      metric: "fee-APR NOT measured (needs pool-volume sampling)",
      metricValue: null,
      accessible: true,
      dataAgeMin: null,
      caveats: ["pools are deep + permissionless, but fee income is unmeasured", "the AMM's fee yield depends on volume, which is thin (flow is on the orderbook)"],
    });
  }

  // rank: accessible first, then measured-numeric desc within that, unmeasured last
  ops.sort((a, b) => {
    if (a.accessible !== b.accessible) return a.accessible ? -1 : 1;
    const av = a.metricValue ?? -1;
    const bv = b.metricValue ?? -1;
    return bv - av;
  });

  const topAccessibleMeasured = ops.find((o) => o.accessible && o.metricValue != null) ?? null;
  const payload = {
    asOf: Date.now(),
    method: "deterministic scan over measured sampler ledgers; reports only observed numbers, never sourced or invented",
    headline: topAccessibleMeasured
      ? `${topAccessibleMeasured.label}: ${topAccessibleMeasured.metric}`
      : "no measured, accessible opportunity yet (samplers still building history)",
    opportunities: ops,
  };
  cache = { at: Date.now(), payload };
  return payload;
}
