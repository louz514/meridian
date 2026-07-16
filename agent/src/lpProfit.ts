// Realized LP profit accounting — ground truth, not the allocator's optimistic
// burst estimates. The number that actually matters at our size:
//
//   net = fees COLLECTED (realized) − taker fees PAID to churn (rebalance/
//         re-center swaps) ; plus uncollected fees still accruing in-range.
//
// Fees collected are exact (lp-collect records = USDG swept). Taker fees paid
// are ESTIMATED from each swap's size × the pool's fee tier (the fee is taken
// on the swapped amount): an lp-mint swaps ~half the position to the stock
// side; a liquidation sells the whole holding; a rotation is two legs. Gas is
// excluded (tiny on this chain) and noted as such.
import { readAllExecutions } from "./executionsLog.js";
import { poolFeePct } from "./venues/stockPools.js";
import { openPositions, uncollectedFeesUsd } from "./venues/lpPositions.js";

export interface LpProfit {
  windowLabel: string;
  feesCollectedUsd: number;
  uncollectedAccruedUsd: number;
  takerFeesPaidUsd: number;
  netRealizedUsd: number; // collected − paid (gas excluded)
  netWithUncollectedUsd: number; // + fees still owed in-range
  collects: number;
  swaps: number;
}

function feeFrac(symbol?: string): number {
  return symbol ? poolFeePct(symbol) / 100 : 0;
}

function accountFor(sinceMs: number, label: string, uncollected: number): LpProfit {
  const execs = readAllExecutions().filter((r) => r.success && r.ts >= sinceMs);
  let feesCollected = 0;
  let takerPaid = 0;
  let collects = 0;
  let swaps = 0;
  for (const r of execs) {
    if (r.kind === "lp-collect") {
      feesCollected += r.amountUsd || 0;
      collects++;
    } else if (r.kind === "lp-mint") {
      // amountUsd = full position (both sides); the swap was ~half, to the stock.
      takerPaid += (r.amountUsd / 2) * feeFrac(r.toSymbol);
      swaps++;
    } else if (r.kind === "liquidation") {
      takerPaid += (r.amountUsd || 0) * feeFrac(r.fromSymbol);
      swaps++;
    } else if (r.kind === "rotation" || r.kind === "entry") {
      takerPaid += (r.amountUsd || 0) * feeFrac(r.toSymbol);
      swaps++;
    }
  }
  const netRealized = feesCollected - takerPaid;
  return {
    windowLabel: label,
    feesCollectedUsd: round(feesCollected),
    uncollectedAccruedUsd: round(uncollected),
    takerFeesPaidUsd: round(takerPaid),
    netRealizedUsd: round(netRealized),
    netWithUncollectedUsd: round(netRealized + uncollected),
    collects,
    swaps,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * All-time and last-24h realized LP profit. Uncollected accrued (read on-chain
 * from open positions) is attributed to the all-time window.
 */
export async function lpProfit(): Promise<{ allTime: LpProfit; last24h: LpProfit; note: string }> {
  let uncollected = 0;
  for (const p of openPositions()) {
    try {
      uncollected += await uncollectedFeesUsd(p);
    } catch {
      /* skip on read failure */
    }
  }
  const now = Date.now();
  return {
    allTime: accountFor(0, "all-time", uncollected),
    last24h: accountFor(now - 24 * 60 * 60 * 1000, "last-24h", 0),
    note: "netRealized = fees collected − estimated taker fees paid on rebalance/re-center swaps. Gas excluded (small on this chain). Taker fees are estimated from swap size × pool fee tier. Uncollected = fees still owed in-range (counted once, in all-time).",
  };
}
