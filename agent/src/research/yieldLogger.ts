// Yield sampler: builds the time series we can't read as a single number.
// syrupUSDG on Robinhood Chain is a minimal token (no on-chain NAV/rate — only
// totalSupply/decimals), so its real accrual can only be MEASURED by watching
// the syrupUSDG/USDG pool price drift upward over time. This logs that price
// (plus $INDEX distribution yield) on a cadence and derives a trailing,
// annualized "measured APY" once enough history exists — a real number, not
// Maple's published figure. Read-only; no wallet.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { carryQuote } from "../signals/carry.js";
import { indexYieldData } from "../state.js";

const LOG = "yield-log.jsonl";
const SAMPLE_MS = Number(process.env.YIELD_SAMPLE_MS ?? 60 * 60 * 1000); // hourly
const MIN_BASELINE_MS = 24 * 60 * 60 * 1000; // don't annualize off < 24h (premium noise)

interface YieldRow {
  ts: number;
  syrupPrice?: number;
  syrupPremiumPct?: number;
  syrupDepthUsd?: number;
  measuredSyrupAprPct?: number | null;
  indexPriceUsd?: number;
  indexDistPerDayUsd?: number;
  indexEligibleUsd?: number;
  indexImpliedAprPct?: number | null;
}

function history(): YieldRow[] {
  try {
    const p = dataPath(LOG);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as YieldRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is YieldRow => !!r && typeof r.ts === "number");
  } catch {
    return [];
  }
}

// Annualized growth of the syrup pool price vs the OLDEST sample that is at
// least MIN_BASELINE_MS old. Widens (and stabilizes) as history accumulates.
function measuredSyrupApr(currentPrice: number, rows: YieldRow[]): number | null {
  const now = Date.now();
  const baseline = rows.find((r) => r.syrupPrice && now - r.ts >= MIN_BASELINE_MS);
  if (!baseline || !baseline.syrupPrice) return null;
  const dtYears = (now - baseline.ts) / (365 * 24 * 60 * 60 * 1000);
  if (dtYears <= 0) return null;
  const apr = (Math.pow(currentPrice / baseline.syrupPrice, 1 / dtYears) - 1) * 100;
  return Math.round(apr * 10) / 10;
}

async function sample(): Promise<void> {
  const rows = history();
  const row: YieldRow = { ts: Date.now() };
  try {
    const c: any = await carryQuote();
    row.syrupPrice = c.priceUsdgPerSyrup;
    row.syrupPremiumPct = Math.round(c.premiumOverParPct * 1000) / 1000;
    row.syrupDepthUsd = c.poolDepthUsdAt2pct;
    row.measuredSyrupAprPct = row.syrupPrice ? measuredSyrupApr(row.syrupPrice, rows) : null;
  } catch {
    /* leave syrup fields undefined this cycle */
  }
  try {
    const s: any = await indexYieldData.snapshot();
    const eligUsd = (s.eligibleSupplyTokens || 0) * (s.indexPriceUsd || 0);
    row.indexPriceUsd = s.indexPriceUsd;
    row.indexDistPerDayUsd = s.distributedUsdPerDayRecent;
    row.indexEligibleUsd = Math.round(eligUsd);
    row.indexImpliedAprPct =
      eligUsd > 0 && s.distributedUsdPerDayRecent != null
        ? Math.round(((s.distributedUsdPerDayRecent * 365) / eligUsd) * 1000) / 10
        : null;
  } catch {
    /* leave index fields undefined this cycle */
  }
  appendLedger(LOG, row);
  console.error(
    `[yieldLogger] syrup=${row.syrupPrice?.toFixed(5) ?? "?"} ` +
      `(${row.measuredSyrupAprPct != null ? row.measuredSyrupAprPct + "% measured" : "building history"}) ` +
      `indexAPR=${row.indexImpliedAprPct ?? "?"}%`,
  );
}

/** Latest snapshot + measured APY for /api/ops (and a future paid tool). */
export function yieldSummary(): unknown {
  const rows = history();
  const latest = rows[rows.length - 1] ?? null;
  return {
    samples: rows.length,
    latest,
    note:
      "measuredSyrupAprPct is annualized from the syrupUSDG/USDG pool-price drift (needs >24h history to appear, stabilizes over weeks). indexImpliedAprPct is $INDEX distributions/day over eligible supply value (volume-driven, volatile).",
  };
}

export function startYieldLogger(): NodeJS.Timeout {
  console.log(`[yieldLogger] sampling syrupUSDG + $INDEX yield every ${SAMPLE_MS / 60000}min -> ${LOG}`);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref?.();
  void sample();
  return timer;
}
