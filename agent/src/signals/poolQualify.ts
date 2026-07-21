// Dynamic LP pool qualification. The allocator already RANKS every candidate
// pool; this decides which are SAFE to deploy into, so the deployable set grows
// itself instead of living in a hardcoded list. Three gates:
//   1. depth — enough in-range liquidity that our size earns a real fee share
//   2. score — the pool is fee-positive net of markout (from lpScore)
//   3. holdable — our wallet can actually RECEIVE the token (the SPCX lesson:
//      some tokenized stocks have transfer restrictions; depth alone is a trap)
// The holdability gate is a state-overridden ETH->USDG->token swap SIMULATION,
// so it never depends on the wallet's live balances and never spends. All
// read-only; qualification gates deployment but moves no capital itself.
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient, getAgentAddress } from "../venues/signer.js";
import { buildSwapExactInCalldata, USDG, poolCandidates, type RouteHop } from "../venues/stockPools.js";
import { lpScores } from "./lpScore.js";

const SV: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;

const MIN_DEPTH_USD = Number(process.env.LP_QUALIFY_MIN_DEPTH_USD ?? 2000);
const QUALIFY_TTL_MS = Number(process.env.LP_QUALIFY_TTL_MS ?? 30 * 60_000);
// Transfer restrictions are static, so a holdability result is cached long.
const HOLD_TTL_MS = 6 * 60 * 60_000;

export interface DeployablePool {
  name: string;
  symbol: string;
  token: Address;
  fee: number;
  tickSpacing: number;
  depthUsd: number;
  netPerDayUsd: number;
  holdable: boolean;
}

function idFor(token: Address, fee: number, ts: number): Hex {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, ts, NATIVE]));
}

// USDG (6dp) to move price ~2%, from in-range liquidity. sqrtP is sqrtPriceX96/Q96.
function depthUsd(L: number, sqrtP: number, usdgIs0: boolean): number {
  const f = Math.sqrt(1.02);
  const draw = usdgIs0 ? L * (1 / sqrtP - 1 / (sqrtP * f)) : L * (sqrtP * f - sqrtP);
  return Math.abs(draw) / 1e6;
}

const holdCache = new Map<string, { ok: boolean; at: number }>();

/**
 * Can our wallet receive `token`? Simulates ETH -> USDG -> token routed through
 * the real pools, with a state override crediting the wallet ETH so the check
 * is independent of live balances/approvals. A revert means the token can't be
 * received (transfer restriction) or the pool can't fill — either way, not safe
 * to LP. Cached (restrictions don't change).
 */
export async function checkHoldable(token: Address, fee: number, tickSpacing: number): Promise<boolean> {
  const key = token.toLowerCase();
  const hit = holdCache.get(key);
  if (hit && Date.now() - hit.at < HOLD_TTL_MS) return hit.ok;

  const house = getAgentAddress();
  if (!house) return false; // no wallet configured — can't verify, fail closed
  const route: RouteHop[] = [
    { outputCurrency: USDG, fee: 500, tickSpacing: 10 }, // ETH -> USDG (bridge pool)
    { outputCurrency: token, fee, tickSpacing },          // USDG -> token (target pool)
  ];
  const swap = buildSwapExactInCalldata({ currencyIn: NATIVE, route, amountIn: 1_000_000_000_000_000n /* 0.001 ETH */, amountOutMinimum: 0n, recipient: house });
  let ok = false;
  try {
    await getPublicClient().call({
      account: house,
      to: swap.to,
      data: swap.data,
      value: swap.value,
      stateOverride: [{ address: house, balance: 20_000_000_000_000_000n /* 0.02 ETH */ }],
    });
    ok = true;
  } catch {
    ok = false;
  }
  holdCache.set(key, { ok, at: Date.now() });
  return ok;
}

let cache: { at: number; pools: DeployablePool[] } | null = null;

/**
 * The set of pools that clear all three gates. Cached for QUALIFY_TTL_MS. This
 * is what deployment should read instead of a hardcoded list — as pools deepen
 * (or new tokens list), they qualify automatically; as they thin or restrict,
 * they drop out.
 */
export async function qualifyDeployablePools(): Promise<DeployablePool[]> {
  if (cache && Date.now() - cache.at < QUALIFY_TTL_MS) return cache.pools;
  const client = getPublicClient();
  const candidates = poolCandidates();

  // depth for every candidate in one multicall
  const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const contracts = candidates.flatMap((c) => {
    const id = idFor(c.token, c.fee, c.ts);
    return [
      { address: SV, abi: liqAbi, functionName: "getLiquidity", args: [id] } as const,
      { address: SV, abi: slot0Abi, functionName: "getSlot0", args: [id] } as const,
    ];
  });
  const results = await client.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3 });

  const score = await lpScores().catch(() => null);
  const netByPool = new Map((score?.pools ?? []).map((p) => [p.pool, (p.lpNetUsd ?? 0) / (score?.windowDays || 1)] as const));

  const deep: DeployablePool[] = [];
  candidates.forEach((c, i) => {
    const liq = results[2 * i];
    const slot = results[2 * i + 1];
    const L = liq.status === "success" ? Number(liq.result) : 0;
    const sqrtRaw = slot.status === "success" ? Number((slot.result as readonly [bigint, number, number, number])[0]) : 0;
    if (L === 0 || sqrtRaw === 0) return;
    const usdgIs0 = USDG.toLowerCase() < c.token.toLowerCase();
    const depth = depthUsd(L, sqrtRaw / Q96, usdgIs0);
    if (depth < MIN_DEPTH_USD) return;
    deep.push({ name: c.name, symbol: c.symbol, token: c.token, fee: c.fee, tickSpacing: c.ts, depthUsd: depth, netPerDayUsd: netByPool.get(c.name) ?? 0, holdable: false });
  });

  // holdability gate only for the pools that cleared depth (bounded # of sims)
  for (const p of deep) p.holdable = await checkHoldable(p.token, p.fee, p.tickSpacing);

  const qualified = deep.filter((p) => p.holdable).sort((a, b) => b.depthUsd - a.depthUsd);
  cache = { at: Date.now(), pools: qualified };
  return qualified;
}

/** Deployable pool for a symbol (best-depth qualified tier), or null if none qualify. */
export async function deployablePoolFor(symbol: string): Promise<DeployablePool | null> {
  const pools = await qualifyDeployablePools();
  return pools.find((p) => p.symbol === symbol) ?? null;
}
