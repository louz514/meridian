// The opportunity scanner: lp_score measures each pool's fee flow and
// toxicity across ALL existing LPs, but the question that makes money is
// narrower — given OUR capital, which pool pays US the most right now, and is
// it better than where we're sitting? This ranks every LP-viable pool by our
// expected net $/day (our share of in-range liquidity × the pool's net flow),
// runs throughout the day, and flags when a move is worth its switching cost.
// Report-only by design: it surfaces the best opportunity; moving capital
// stays a deliberate act (the momentum-churn lesson — never chase on a whim).
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address, type Hex } from "viem";
import { appendLedger } from "./ledger.js";
import { getPublicClient } from "./venues/signer.js";
import { lpScores } from "./signals/lpScore.js";
import { openPositions } from "./venues/lpPositions.js";
import { poolCandidates, poolFeePct } from "./venues/stockPools.js";
import { dataPath } from "./dataDir.js";

const SV: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11"; // deployed on Robinhood Chain, but not in the viem chain object
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;
const PAYBACK_DAYS_BAR = 3; // only worth moving if the switch pays for itself within this

// The candidate universe: every ticker × standard fee tier (names match
// lp_score's for the join). Non-existent / dead pools are filtered out at scan
// time (sqrtP === 0, or no fee flow), so this stays broad and self-updating.
const POOLS = poolCandidates();

export interface LpOpportunity {
  pool: string;
  symbol: string;
  ourSharePct: number;
  expectedNetPerDayUsd: number;
  expectedFeesPerDayUsd: number;
  feeTierPct: number;
  viable: boolean;
}
export interface OpportunityScan {
  ts: number;
  capitalUsd: number;
  opportunities: LpOpportunity[];
  best: LpOpportunity | null;
  currentSymbol: string | null;
  recommendation: string;
  note: string;
}

function idFor(token: Address, fee: number, ts: number): Hex {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, ts, NATIVE]));
}

/** Liquidity L we'd mint for `capitalUsd` split into a ±widthPct/2 range at the current price. */
function ourLiquidity(capitalUsd: number, sqrtP: number, widthPct: number, usdgIs0: boolean): number {
  const f = Math.sqrt(1 + widthPct / 200);
  const sA = sqrtP / f, sB = sqrtP * f;
  const half = (capitalUsd / 2) * 1e6; // USDG raw on one side
  return usdgIs0
    ? (half * ((sqrtP / Q96) * (sB / Q96))) / (sB / Q96 - sqrtP / Q96)
    : half / (sqrtP / Q96 - sA / Q96);
}

let cache: OpportunityScan | null = null;
export function latestScan(): OpportunityScan | null {
  return cache;
}

export async function scanOpportunities(capitalUsd = 160, widthPct = 2): Promise<OpportunityScan> {
  const client = getPublicClient();
  const score = await lpScores(); // hourly-cached; the expensive part
  const scoreByPool = new Map(score.pools.map((p) => [p.pool, p]));

  // Read all candidates' pool state in ONE multicall with allowFailure: dead /
  // non-existent pools (getSlot0/getLiquidity revert) return a failure status
  // instead of poisoning the whole batch, so real pools still resolve. (Auto-
  // batched readContract does NOT allowFailure, which zeroed everything.)
  const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const contracts = POOLS.flatMap((p) => {
    const id = idFor(p.token, p.fee, p.ts);
    return [
      { address: SV, abi: liqAbi, functionName: "getLiquidity", args: [id] } as const,
      { address: SV, abi: slot0Abi, functionName: "getSlot0", args: [id] } as const,
    ];
  });
  const results = await client.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3 });
  const states = POOLS.map((p, i) => {
    const liq = results[2 * i];
    const slot = results[2 * i + 1];
    const poolL = liq.status === "success" ? Number(liq.result) : 0;
    const sqrtP = slot.status === "success" ? Number((slot.result as readonly [bigint, number, number, number])[0]) : 0;
    return { p, poolL, sqrtP };
  });

  const opps: LpOpportunity[] = [];
  for (const { p, poolL, sqrtP } of states) {
    if (sqrtP === 0) continue; // pool not initialized on this tier — skip
    const usdgIs0 = USDG.toLowerCase() < p.token.toLowerCase();
    const ourL = ourLiquidity(capitalUsd, sqrtP, widthPct, usdgIs0);
    const share = ourL / (poolL + ourL);
    const sc = scoreByPool.get(p.name);
    const netPerDay = sc ? sc.lpNetUsd / score.windowDays : 0;
    const feesPerDay = sc ? sc.feesPerDayUsd : 0;
    opps.push({
      pool: p.name,
      symbol: p.symbol,
      ourSharePct: share * 100,
      expectedNetPerDayUsd: share * netPerDay,
      expectedFeesPerDayUsd: share * feesPerDay,
      feeTierPct: p.fee / 10000,
      viable: netPerDay > 0,
    });
  }
  opps.sort((a, b) => b.expectedNetPerDayUsd - a.expectedNetPerDayUsd);

  const best = opps[0] ?? null;
  const currentSymbol = openPositions()[0]?.symbol ?? null;
  const current = opps.find((o) => o.symbol === currentSymbol) ?? null;

  let recommendation: string;
  if (!best || !best.viable) {
    recommendation = "no pool is currently fee-positive for our size — sit in cash / wait.";
  } else if (!currentSymbol) {
    recommendation = `flat. Best opportunity: ${best.pool} at ~$${best.expectedNetPerDayUsd.toFixed(2)}/day for $${capitalUsd}.`;
  } else if (best.symbol === currentSymbol) {
    recommendation = `holding the best pool (${best.pool}). No move.`;
  } else {
    const gain = best.expectedNetPerDayUsd - (current?.expectedNetPerDayUsd ?? 0);
    // Real round-trip: sell current (its fee) + buy target (its fee) + buffer —
    // the flat 0.6% badly understated it for 1% pools.
    const switchCost = capitalUsd * (poolFeePct(currentSymbol) / 100 + poolFeePct(best.symbol) / 100 + 0.003);
    const paybackDays = gain > 0 ? switchCost / gain : Infinity;
    recommendation =
      paybackDays <= PAYBACK_DAYS_BAR
        ? `CONSIDER MOVING ${currentSymbol} → ${best.symbol}: +$${gain.toFixed(2)}/day, ~$${switchCost.toFixed(2)} switch cost pays back in ${paybackDays.toFixed(1)}d.`
        : `hold ${currentSymbol}. ${best.symbol} leads by only $${gain.toFixed(2)}/day — not worth the ~$${switchCost.toFixed(2)} switch.`;
  }

  const scan: OpportunityScan = {
    ts: Date.now(),
    capitalUsd,
    opportunities: opps,
    best,
    currentSymbol,
    recommendation,
    note: "Expected net $/day = our share of in-range liquidity × the pool's measured (fees − markout)/day. Report-only; moving capital is a deliberate act.",
  };
  cache = scan;
  try {
    appendLedger("lp-opportunities.jsonl", { ts: scan.ts, best: best?.pool ?? null, bestNet: best?.expectedNetPerDayUsd ?? 0, current: currentSymbol, rec: recommendation });
  } catch {}
  return scan;
}

/**
 * Run the scanner throughout the day: every 30 min during market hours (when
 * flow and the opportunity set shift most), hourly otherwise. Read-only, so it
 * runs anywhere the agent runs; it never moves capital on its own.
 */
export function startLpAllocator(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const scan = await scanOpportunities();
      console.error(`[lpAllocator] best: ${scan.best?.pool ?? "none"} ($${scan.best?.expectedNetPerDayUsd.toFixed(2)}/day) — ${scan.recommendation}`);
    } catch (err) {
      console.error(`[lpAllocator] scan failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  };
  const isMarketHours = () => {
    const now = new Date();
    const day = now.getUTCDay();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    return day >= 1 && day <= 5 && mins >= 810 && mins < 1200;
  };
  let last = 0;
  const timer = setInterval(() => {
    const gap = isMarketHours() ? 30 * 60 * 1000 : 60 * 60 * 1000;
    if (Date.now() - last >= gap) {
      last = Date.now();
      void tick();
    }
  }, 5 * 60 * 1000);
  timer.unref?.();
  last = Date.now();
  void tick();
  return timer;
}
