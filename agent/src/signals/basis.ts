// The basis feed: live gap between 24/7 on-chain pool prices and the real
// equity market's prints, per depth-verified ticker. This is a revenue tool
// for agents on the platform — the pools trade around the clock while NYSE
// doesn't, so the gap (and its convergence at the open) is a tradable signal.
import { poolPricesUsd, TRADABLE_SYMBOLS } from "../venues/stockPools.js";

export interface BasisRow {
  symbol: string;
  poolUsd: number;
  marketUsd: number;
  basisPct: number;
  marketState: string;
  marketTime: number;
}

async function marketQuote(symbol: string): Promise<{ price: number; time: number; state: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (Meridian)" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const meta = ((await res.json()) as any)?.chart?.result?.[0]?.meta;
    if (typeof meta?.regularMarketPrice !== "number") return null;
    return { price: meta.regularMarketPrice, time: meta.regularMarketTime ?? 0, state: meta.marketState ?? "?" };
  } catch {
    return null;
  }
}

/** One full basis snapshot across the tradable universe. */
export async function basisSnapshot(): Promise<{ ts: number; rows: BasisRow[]; note: string }> {
  const [pool, quotes] = await Promise.all([
    poolPricesUsd(),
    Promise.all(TRADABLE_SYMBOLS.map(async (s) => [s, await marketQuote(s)] as const)),
  ]);
  const rows: BasisRow[] = [];
  for (const [symbol, q] of quotes) {
    const poolUsd = pool[symbol];
    if (!q || poolUsd == null || !Number.isFinite(poolUsd)) continue;
    rows.push({
      symbol,
      poolUsd,
      marketUsd: q.price,
      basisPct: ((poolUsd - q.price) / q.price) * 100,
      marketState: q.state,
      marketTime: q.time,
    });
  }
  rows.sort((a, b) => a.basisPct - b.basisPct);
  return {
    ts: Date.now(),
    rows,
    note:
      "basisPct < 0 means the on-chain pool trades below the last real-market print. " +
      "Off-hours the market side is the previous close; convergence risk runs both directions.",
  };
}
