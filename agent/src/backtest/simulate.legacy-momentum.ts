/**
 * RETIRED — kept for reference/audit trail only, not wired to `npm run
 * backtest` (see simulate.ts for the active IndexYieldStrategy backtest).
 *
 * On-chain research (2026-07-11) found every Index stock token quotes only
 * against ETH — no direct stock-to-stock pool — so a rotation like this one
 * simulates is actually two 5%-fee legs through ETH (~9.75% round trip), not
 * the 3% assumed below. That's worse than this file already shows, which is
 * what drove the pivot to IndexYieldStrategy (hold $INDEX, collect its real
 * distribution mechanic) instead of rotating between stock tokens. See
 * meridian-index-yield-mechanics memory.
 *
 * Backtest for Meridian's momentum rotation on The Index — REAL price history.
 *
 * Data: daily closes of the underlying equities for 17 of the 18 Index tickers
 * (data/prices.json, fetched from Yahoo). The Index's tokens are tokenized
 * equities that track their underlying, so underlying closes are a faithful
 * proxy for the token price. Assumptions/limits worth naming:
 *   - Ignores any token premium/discount vs the underlying, and the fact that
 *     the tokens trade 24/7 while the stocks don't (so intraday/overnight gaps
 *     differ). Daily-close granularity.
 *   - SPCX (SpaceX) is excluded — it isn't publicly traded, no real series.
 *   - Window is bounded by CoreWeave's 2025 IPO (the shortest kept history).
 *
 * The Index charges a confirmed 3% fee on every swap (via the Uniswap v4 fee
 * hook), so that's the headline cost; lower costs are shown only to isolate how
 * much the fee alone is responsible for the result.
 *
 * Run: npm run backtest
 */
import { readFileSync } from "node:fs";
import { config } from "../config.js";

interface Fixture { dates: string[]; series: Record<string, number[]>; kept: string[] }
const fixture = JSON.parse(
  readFileSync(new URL("./data/prices.json", import.meta.url), "utf8"),
) as Fixture;

const SYMBOLS = fixture.kept;
const DATES = fixture.dates;
const N_DAYS = DATES.length;
const price = (sym: string, day: number) => fixture.series[sym][day];

interface RunParams {
  lookbackDays: number;
  rotateThresholdPct: number;
  perTradeCostPct: number; // venue swap cost (Index fee + slippage), one-way
  routingBps: number;      // Meridian x402 routing fee
  initialUsd: number;
}

interface RunResult {
  agentNetPct: number;
  agentGrossPct: number;
  trades: number;
  feePaidUsd: number;
  cagrPct: number;
}

const momentum = (sym: string, day: number, lookback: number): number => {
  const back = Math.max(0, day - lookback);
  return price(sym, day) / price(sym, back) - 1;
};

/**
 * Position-aware momentum: hold one name (the leader); rotate into a new leader
 * only when it beats the current holding's momentum by more than the threshold.
 * Cost charged on the full notional at each rotation (a swap is one trade).
 */
function run(p: RunParams): RunResult {
  const oneWayCost = p.perTradeCostPct / 100 + p.routingBps / 10000;
  let holding: string | null = null;
  let units = 0;
  let feePaid = 0;
  let trades = 0;
  let cashAtEntry = p.initialUsd;

  for (let day = p.lookbackDays; day < N_DAYS; day++) {
    const ranked = SYMBOLS.map((s) => ({ s, m: momentum(s, day, p.lookbackDays) })).sort((a, b) => b.m - a.m);
    const leader = ranked[0];

    if (holding === null) {
      const cost = cashAtEntry * oneWayCost;
      feePaid += cost;
      units = (cashAtEntry - cost) / price(leader.s, day);
      holding = leader.s;
      trades++;
      continue;
    }

    const holdingMomentum = momentum(holding, day, p.lookbackDays);
    if (leader.s !== holding && leader.m - holdingMomentum > p.rotateThresholdPct / 100) {
      const value = units * price(holding, day);
      const cost = value * oneWayCost;
      feePaid += cost;
      units = (value - cost) / price(leader.s, day);
      holding = leader.s;
      trades++;
    }
  }

  const finalValue = holding === null ? p.initialUsd : units * price(holding, N_DAYS - 1);
  const agentNetPct = (finalValue / p.initialUsd - 1) * 100;
  const agentGrossPct = ((finalValue + feePaid) / p.initialUsd - 1) * 100;
  const years = N_DAYS / 252;
  const cagrPct = ((finalValue / p.initialUsd) ** (1 / years) - 1) * 100;

  return { agentNetPct, agentGrossPct, trades, feePaidUsd: feePaid, cagrPct };
}

// Baselines on the same real window.
function buyHold(lookback: number) {
  const rets = SYMBOLS.map((s) => price(s, N_DAYS - 1) / price(s, lookback) - 1);
  return {
    equalPct: (rets.reduce((a, b) => a + b, 0) / rets.length) * 100,
    bestPct: Math.max(...rets) * 100,
    bestSym: SYMBOLS[rets.indexOf(Math.max(...rets))],
    worstPct: Math.min(...rets) * 100,
    worstSym: SYMBOLS[rets.indexOf(Math.min(...rets))],
  };
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

// --------------------------------- report ------------------------------------
const LOOKBACK = 10;
const INITIAL = 10_000;
const ROUTING_BPS = config.bridgeFeeBps;
const INDEX_FEE_PCT = 3.0; // confirmed: 3% Uniswap v4 fee hook on every swap

console.log("");
console.log("Meridian momentum backtest — The Index (REAL underlying-equity prices)");
console.log(`  window ${DATES[0]} → ${DATES[N_DAYS - 1]}  (${N_DAYS} trading days, ~${(N_DAYS / 252).toFixed(1)}y)`);
console.log(`  ${SYMBOLS.length} tickers · ${LOOKBACK}-day momentum · $${INITIAL.toLocaleString()} start`);
console.log(`  Index swap fee: ${INDEX_FEE_PCT}% (confirmed) · Meridian x402 routing: ${ROUTING_BPS} bps`);
console.log("");

const bh = buyHold(LOOKBACK);
console.log("Baselines on this window (context):");
console.log(`  buy & hold, equal-weight : ${pct(bh.equalPct)}`);
console.log(`  buy & hold, best name    : ${pct(bh.bestPct)}  (${bh.bestSym}, unknowable in advance)`);
console.log(`  buy & hold, worst name   : ${pct(bh.worstPct)}  (${bh.worstSym}, unknowable in advance)`);
console.log("");

console.log("A) The real scenario — 3% Index fee, at several rotation thresholds:");
console.log("   " + "threshold".padEnd(22) + "net return   CAGR      gross(no fee)  trades   fees$");
for (const thr of [0, 2, 5, 10]) {
  const r = run({ lookbackDays: LOOKBACK, rotateThresholdPct: thr, perTradeCostPct: INDEX_FEE_PCT, routingBps: ROUTING_BPS, initialUsd: INITIAL });
  console.log(
    "   " +
      `>${thr}% gap`.padEnd(22) +
      pct(r.agentNetPct).padEnd(13) +
      pct(r.cagrPct).padEnd(10) +
      pct(r.agentGrossPct).padEnd(15) +
      r.trades.toString().padEnd(9) +
      `$${r.feePaidUsd.toFixed(0)}`,
  );
}

console.log("");
console.log("B) If the fee were lower (isolating how much the 3% hook alone costs), >2% threshold:");
console.log("   " + "swap cost".padEnd(22) + "net return   trades   fees$");
for (const cost of [0.3, 1.0, 3.0]) {
  const r = run({ lookbackDays: LOOKBACK, rotateThresholdPct: 2, perTradeCostPct: cost, routingBps: ROUTING_BPS, initialUsd: INITIAL });
  console.log(
    "   " +
      `${cost.toFixed(1)}% per swap`.padEnd(22) +
      pct(r.agentNetPct).padEnd(13) +
      r.trades.toString().padEnd(9) +
      `$${r.feePaidUsd.toFixed(0)}`,
  );
}
console.log("");
