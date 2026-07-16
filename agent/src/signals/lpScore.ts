// LP opportunity scoring: for each depth-verified pool, measure real fee
// flow and real markout (post-trade price drift against LPs) from on-chain
// swap events. fees - markout is what LPs actually earned — the number that
// decides whether providing liquidity beats trading. Validated 2026-07-13:
// same 2.5-day window where the momentum trader lost $13, NVDA-pool LPs
// earned +$2,730 (fees $1,084, markout NEGATIVE — flow was mean-reverting).
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { poolCandidates } from "../venues/stockPools.js";

const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;
const MARKOUT_HORIZON_S = 1800; // 30-minute markout, the standard MM yardstick here

// The full on-chain stock universe (every ticker × standard tier), not a fixed
// five — so a pool that has newly gained flow surfaces on its own. Pools with no
// swaps in the window are dropped from the report below.
const POOLS: [string, string, number, number, number][] = poolCandidates().map(
  (c) => [c.name, c.token, c.fee, c.ts, c.feeRate],
);

const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export interface LpPoolScore {
  pool: string;
  swaps: number;
  volumeUsd: number;
  feesUsd: number;
  /** positive = informed flow bleeding LPs; negative = mean-reverting flow (LPs gain beyond fees) */
  markoutUsd: number;
  lpNetUsd: number;
  feesPerDayUsd: number;
  verdict: "fees beat toxicity" | "toxic: fees lose";
}

export interface LpScoreReport {
  ts: number;
  windowDays: number;
  markoutHorizonMinutes: number;
  pools: LpPoolScore[];
  note: string;
}

let cache: { at: number; report: LpScoreReport } | null = null;
const CACHE_MS = 60 * 60 * 1000; // the scan reads days of logs — hourly refresh is plenty

function idFor(token: string, fee: number, ts: number): Hex {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0 as Address, c1 as Address, fee, ts, NATIVE]),
  );
}

/** The cached report if the scan has run recently — for surfaces (like the public console) that must never block a minute on a cold scan. */
export function lpScoresIfCached(): LpScoreReport | null {
  return cache && Date.now() - cache.at < CACHE_MS ? cache.report : null;
}

export async function lpScores(windowDays = 2.5): Promise<LpScoreReport> {
  if (cache && Date.now() - cache.at < CACHE_MS && cache.report.windowDays === windowDays) return cache.report;

  const client = getPublicClient();
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const probe = await client.getBlock({ blockNumber: head - 500_000n });
  const bps = 500_000 / (headTs - Number(probe.timestamp));
  const fromBlock = head - BigInt(Math.round(windowDays * 86400 * bps));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;

  // Discover which candidate pools actually exist on-chain first (one
  // multicall), so we only scan flow for real pools — a 70-id getLogs topic
  // filter is rejected by the RPC, but the handful that exist is fine.
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const slot0s = await client.multicall({
    contracts: POOLS.map((p) => ({ address: STATE_VIEW, abi: slot0Abi, functionName: "getSlot0", args: [idFor(p[1], p[2], p[3])] }) as const),
    allowFailure: true,
    multicallAddress: MULTICALL3,
  });
  const active = POOLS.filter((_, i) => {
    const r = slot0s[i];
    return r.status === "success" && Number((r.result as readonly [bigint, number, number, number])[0]) > 0;
  });

  const wanted = new Map(active.map((p) => [idFor(p[1], p[2], p[3]).toLowerCase(), p[0]]));
  const swaps = new Map<string, { t: number; px: number; usd: number; dir: number }[]>(active.map((p) => [p[0], []]));

  let from = fromBlock;
  let step = 200_000n;
  while (from <= head) {
    const to = from + step - 1n > head ? head : from + step - 1n;
    try {
      const logs = await client.getLogs({
        address: POOL_MANAGER,
        event: swapEvent,
        args: { id: [...wanted.keys()] as Hex[] },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const name = wanted.get((l.args.id as string).toLowerCase())!;
        const pool = POOLS.find((p) => p[0] === name)!;
        const tokenIs0 = pool[1].toLowerCase() < USDG.toLowerCase();
        const praw = (Number(l.args.sqrtPriceX96) / Q96) ** 2;
        const px = (tokenIs0 ? praw : 1 / praw) * 1e12;
        const usdgAmt = tokenIs0 ? l.args.amount1! : l.args.amount0!;
        swaps.get(name)!.push({ t: blockTs(l.blockNumber), px, usd: Math.abs(Number(usdgAmt)) / 1e6, dir: 0 });
      }
      from = to + 1n;
    } catch {
      if (step > 25_000n) {
        step /= 2n;
        continue;
      }
      throw new Error("swap-event scan failing even at small ranges");
    }
  }

  const pools: LpPoolScore[] = [];
  for (const [name, , , , feeRate] of active) {
    const s = swaps.get(name)!.sort((a, b) => a.t - b.t);
    if (s.length === 0) continue; // no swaps in the window → not an active pool, skip
    for (let i = 1; i < s.length; i++) s[i].dir = Math.sign(s[i].px - s[i - 1].px);
    let fees = 0,
      markout = 0,
      vol = 0;
    for (let i = 1; i < s.length; i++) {
      const sw = s[i];
      vol += sw.usd;
      fees += sw.usd * feeRate;
      if (sw.dir === 0) continue;
      const tTarget = sw.t + MARKOUT_HORIZON_S;
      let later: (typeof s)[number] | null = null;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j].t <= tTarget) later = s[j];
        else break;
      }
      if (!later) continue;
      markout += sw.dir * ((later.px - sw.px) / sw.px) * sw.usd;
    }
    const net = fees - markout;
    pools.push({
      pool: name,
      swaps: s.length,
      volumeUsd: Math.round(vol),
      feesUsd: Math.round(fees * 100) / 100,
      markoutUsd: Math.round(markout * 100) / 100,
      lpNetUsd: Math.round(net * 100) / 100,
      feesPerDayUsd: Math.round((fees / windowDays) * 100) / 100,
      verdict: net > 0 ? "fees beat toxicity" : "toxic: fees lose",
    });
  }
  pools.sort((a, b) => b.lpNetUsd - a.lpNetUsd);

  const report: LpScoreReport = {
    ts: Date.now(),
    windowDays,
    markoutHorizonMinutes: MARKOUT_HORIZON_S / 60,
    pools,
    note:
      "lpNetUsd = fees - 30min markout across ALL existing LPs in the window. Negative markout means flow " +
      "mean-reverted (LPs earned beyond fees). Your share of future flow depends on your share of in-range " +
      "liquidity; depth is thin here, so small capital can be a large share. Overnight/weekend repricings are " +
      "the main toxicity risk — pull ranges before NYSE closes.",
  };
  cache = { at: Date.now(), report };
  return report;
}
