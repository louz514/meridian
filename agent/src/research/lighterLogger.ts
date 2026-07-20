// Read-only sampler for the Lighter zk-orderbook perp venue on Robinhood Chain
// (the venue behind rwa.wtf; discovered 2026-07-17). Logs a compact snapshot of
// every market — price, 24h volume, open interest, Lighter-native funding, and
// Binance's reference funding for the same symbol — so we accumulate the time
// series needed to judge carry trades and venue momentum BEFORE any capital
// decision. No wallet, no writes anywhere but our own ledger.
//
// Why log external funding too: Lighter's native rates currently sit at uniform
// baselines (stocks 0.0032%/hr, crypto 0.0096%/hr), so the tradeable signal is
// (a) when native rates start moving off baseline and (b) the cross-venue gap
// (e.g. Binance paying 0.12%/hr on SNDK while Lighter pays baseline).
import { appendLedger } from "../ledger.js";

const API = process.env.LIGHTER_API_BASE ?? "https://api.rh.lighter.xyz";
const SAMPLE_MS = Number(process.env.LIGHTER_SAMPLE_MS ?? 30 * 60 * 1000);

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function sample(): Promise<void> {
  const ts = Date.now();
  try {
    const [stats, funding] = await Promise.all([getJson("/api/v1/exchangeStats"), getJson("/api/v1/funding-rates")]);
    const fLighter = new Map<string, number>();
    const fBinance = new Map<string, number>();
    for (const f of funding.funding_rates ?? []) {
      if (f.exchange === "lighter") fLighter.set(f.symbol, Number(f.rate));
      else if (f.exchange === "binance") fBinance.set(f.symbol, Number(f.rate));
    }
    // Compact tuple per market: [sym, last, vol24, trades, oi?, fundLighter?, fundBinance?]
    const m = (stats.order_book_stats ?? []).map((o: any) => [
      o.symbol,
      Number(o.last_trade_price) || 0,
      Math.round(Number(o.daily_quote_token_volume) || 0),
      Number(o.daily_trades_count) || 0,
      fLighter.get(o.symbol) ?? null,
      fBinance.get(o.symbol) ?? null,
    ]);
    appendLedger("lighter-log.jsonl", { ts, venue: "lighter-rh", markets: m.length, m });
    console.error(`[lighterLogger] sampled ${m.length} markets`);
  } catch (err) {
    appendLedger("lighter-log.jsonl", { ts, error: String(err).slice(0, 160) });
    console.error(`[lighterLogger] sample failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Start the sampler in-process (env-gated in index.ts, same pattern as basisLogger). */
export function startLighterLogger(): NodeJS.Timeout {
  console.log(`[lighterLogger] sampling Lighter-on-Robinhood every ${SAMPLE_MS / 60000}min -> lighter-log.jsonl`);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref?.();
  void sample();
  return timer;
}
