// Capital flows in and out of the house wallet.
//
// WHY: performance.ts reported `netUsd = currentUsd - INCEPTION.totalUsd`, with
// no notion of deposits or withdrawals, so every dollar moved in or out was
// booked as profit or loss. On 2026-07-22 a deliberate 0.0754 ETH withdrawal
// showed up as a loss, and the public track record read -99.67% while the book
// had done nothing of the sort. A track record that cannot separate "we lost
// money" from "we moved money" is worse than no track record, and this one is
// published.
//
// Trading moves value THROUGH the wallet constantly, so the only flows that
// count are transfers with an outside party: plain native sends (empty input)
// and ERC-20 transfers whose counterparty is not a protocol contract. Read from
// the indexed explorer, because scanning 12 days of 0.1s blocks is ~10M blocks.
const EXPLORER_API = process.env.MERIDIAN_EXPLORER_API ?? "https://robinhoodchain.blockscout.com/api";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** Protocol contracts: value moving to or from these is trading, not a flow. */
const PROTOCOL = new Set([
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // PoolManager
  "0x8876789976decbfcbbbe364623c63652db8c0904", // UniversalRouter
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
  "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", // StateView
]);

export interface CapitalFlows {
  ethInUsd: number;
  ethOutUsd: number;
  usdgInUsd: number;
  usdgOutUsd: number;
  /** Deposits minus withdrawals: the capital actually put at risk. */
  netContributedUsd: number;
  transfers: number;
  asOf: number;
  degraded?: string;
}

let cache: { at: number; flows: CapitalFlows } | null = null;
const CACHE_MS = 10 * 60_000;

const q = async (params: string): Promise<any[]> => {
  const res = await fetch(`${EXPLORER_API}?${params}`, { signal: AbortSignal.timeout(20_000) });
  const j = (await res.json()) as { result?: unknown };
  return Array.isArray(j.result) ? j.result : [];
};

/**
 * Net capital contributed to the house wallet, in USD.
 *
 * Degrades rather than throws: if the explorer is unreachable the caller still
 * gets a value, flagged, because a broken P&L is more dangerous than a stale one.
 */
export async function capitalFlows(wallet: string, ethUsd: number): Promise<CapitalFlows> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.flows;
  const w = wallet.toLowerCase();
  const out: CapitalFlows = {
    ethInUsd: 0, ethOutUsd: 0, usdgInUsd: 0, usdgOutUsd: 0,
    netContributedUsd: 0, transfers: 0, asOf: Date.now(),
  };

  try {
    // Native: a plain send has empty input. Anything with calldata is a contract
    // interaction, i.e. trading, and must not count as a deposit or withdrawal.
    for (const t of await q(`module=account&action=txlist&address=${w}&page=1&offset=1000`)) {
      const input = String(t.input ?? "0x");
      const value = Number(t.value ?? 0);
      if (value <= 0 || (input !== "0x" && input !== "")) continue;
      if (String(t.isError ?? "0") !== "0") continue;
      const usd = (value / 1e18) * ethUsd;
      if (String(t.to ?? "").toLowerCase() === w) out.ethInUsd += usd;
      else out.ethOutUsd += usd;
      out.transfers++;
    }

    for (const t of await q(`module=account&action=tokentx&address=${w}&page=1&offset=1000`)) {
      if (String(t.contractAddress ?? "").toLowerCase() !== USDG) continue;
      const incoming = String(t.to ?? "").toLowerCase() === w;
      const counterparty = String((incoming ? t.from : t.to) ?? "").toLowerCase();
      if (PROTOCOL.has(counterparty)) continue; // trading leg, not a capital flow
      const usd = Number(t.value ?? 0) / 1e6;
      if (incoming) out.usdgInUsd += usd;
      else out.usdgOutUsd += usd;
      out.transfers++;
    }
  } catch (err) {
    out.degraded = `explorer unreachable: ${String((err as Error)?.message ?? err).slice(0, 120)}`;
  }

  out.netContributedUsd = out.ethInUsd + out.usdgInUsd - out.ethOutUsd - out.usdgOutUsd;
  cache = { at: Date.now(), flows: out };
  return out;
}
