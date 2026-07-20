// The carry quote: current terms for parking idle dollars in yield-bearing
// RWAs on Robinhood Chain. First venue: Maple Finance's syrupUSDG, whose
// USDG pool was depth-verified at ~$3M (census 2026-07-12) — deep enough
// that any platform agent's size is noise. A revenue tool for agents: real
// credit yield while their strategy waits.
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";

const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Maple syrupUSDG (6 decimals, same as USDG — pool price is the par ratio
// directly). Pool key probed live 2026-07-13: fee 500 (0.05%), tickSpacing 10.
// Exported so the earn surface can build user-signed enter/exit swaps against
// the same verified pool key.
export const SYRUP: Address = "0x40858070814a57fdf33a613ae84fe0a8b4a874f7";
export const SYRUP_POOL_FEE = 500;
export const SYRUP_POOL_TICK_SPACING = 10;
const FEE = SYRUP_POOL_FEE;
const TICK_SPACING = SYRUP_POOL_TICK_SPACING;
const Q96 = 2 ** 96;

function poolId(): `0x${string}` {
  const [c0, c1] = SYRUP.toLowerCase() < USDG.toLowerCase() ? [SYRUP, USDG] : [USDG, SYRUP];
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, FEE, TICK_SPACING, NATIVE]),
  );
}

export async function carryQuote() {
  const client = getPublicClient();
  const id = poolId();
  const [sqrtP] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [id],
  });
  const liq = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")],
    functionName: "getLiquidity",
    args: [id],
  });
  if (sqrtP === 0n) throw new Error("syrupUSDG pool not initialized at the expected key");

  const praw = (Number(sqrtP) / Q96) ** 2; // currency1 raw per currency0 raw
  const syrupIs0 = SYRUP.toLowerCase() < USDG.toLowerCase();
  const usdgPerSyrup = syrupIs0 ? praw : 1 / praw; // both 6 decimals: raw ratio == human ratio

  // Depth at ~2% price impact for USDG going in (buying syrupUSDG).
  const f = Math.sqrt(0.98);
  const s = Number(sqrtP);
  const L = Number(liq);
  const usdgInRaw = syrupIs0 ? (L * (s / f - s)) / Q96 : L * Q96 * (1 / (s * f) - 1 / s);
  const depthUsd = usdgInRaw / 1e6;

  return {
    ts: Date.now(),
    venue: "maple-syrupUSDG",
    token: SYRUP,
    quoteToken: USDG,
    route: "USDG -> syrupUSDG, hookless v4 pool, 0.05% fee",
    priceUsdgPerSyrup: usdgPerSyrup,
    premiumOverParPct: (usdgPerSyrup - 1) * 100,
    poolDepthUsdAt2pct: Math.round(depthUsd),
    feeTierPct: 0.05,
    note:
      "syrupUSDG accrues Maple lending yield into its share price; the pool premium over par reflects accrual. " +
      "Round trip through the pool costs ~0.1% plus impact, so carry pays for itself after days, not hours. " +
      "Underlying risks are real: borrower credit, USDG peg, and contract risk.",
  };
}
