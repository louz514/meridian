// Advise-then-approve for the $INDEX distribution-yield position: hold 10,000+
// $INDEX and the 3% hook fee on every pool trade pays you in stock tokens.
// Same custody rules as the carry (earn/carry.ts): this file reads the chain
// and builds raw transactions the USER's own wallet signs; it holds no key.
//
// The pool is ETH-quoted, but a user's idle cash is usually USDG — and the
// funding leg (USDG->ETH, bridge pool, stock UniversalRouter) and the entry leg
// (ETH->$INDEX, The Index's OWN verified router) live on two different routers,
// so they cannot be one atomic transaction. Enter therefore works in rounds:
// short on ETH, prepare returns the funding swap with continueWith:"enter", and
// the caller re-prepares once it lands so the buy is sized against the REAL
// post-conversion balance, never an estimate.
import { encodeFunctionData, parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import {
  buildSwapExactInCalldata,
  hopRate,
  PERMIT2,
  UNIVERSAL_ROUTER as STOCK_ROUTER,
  USDG,
  type RouteHop,
} from "../venues/stockPools.js";
import { buildIndexSwapCalldata, readIndexPerEth, fetchEthUsd } from "../venues/uniswapV4.js";
import { INDEX_CONTRACTS } from "../venues/indexContracts.js";
import { ELIGIBILITY_THRESHOLD_TOKENS } from "../indexYield.js";

const INDEX_TOKEN = INDEX_CONTRACTS.indexToken as Address;
const INDEX_ROUTER = INDEX_CONTRACTS.indexUniversalRouter as Address;
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

// The $INDEX pool's slippage floor: 6%, matching the house path's empirically
// measured bound (a $180 buy showed ~4-4.5% real impact — hook fee + LP fee +
// thin liquidity; see venues/uniswapV4.ts). The funding leg runs the deep 0.05%
// ETH/USDG bridge pool and gets a tight floor. Both env-tunable.
const INDEX_SLIPPAGE_BPS = BigInt(process.env.EARN_INDEX_SLIPPAGE_BPS ?? 600);
const FUND_SLIPPAGE_BPS = BigInt(process.env.EARN_FUND_SLIPPAGE_BPS ?? 100);
// Thin pool: cap per-transaction size well below where impact runs away.
const MAX_AMOUNT_USD = Number(process.env.EARN_INDEX_MAX_USD ?? 1000);
const MIN_AMOUNT_USD = 1;
// ETH kept back for gas across the (up to 2-round) flow. Robinhood Chain is an
// Arbitrum L2 — real costs are far below this; the reserve just prevents a
// max-size funding swap from leaving the wallet unable to sign the entry.
const GAS_RESERVE_ETH = Number(process.env.EARN_GAS_RESERVE_ETH ?? 0.0003);
const SWAP_DEADLINE_SEC = Number(process.env.EARN_SWAP_DEADLINE_SEC ?? 900);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const balanceOfAbi = [parseAbiItem("function balanceOf(address) view returns (uint256)")];
const erc20AllowanceAbi = [parseAbiItem("function allowance(address owner, address spender) view returns (uint256)")];
const erc20ApproveAbi = [parseAbiItem("function approve(address spender, uint256 amount) returns (bool)")];
const permit2AllowanceAbi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
];
const permit2ApproveAbi = [parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)")];

interface PreparedStep {
  kind: "approve-erc20" | "approve-permit2" | "swap";
  description: string;
  to: Address;
  data: Hex;
  value: string;
}

/** The user's live $INDEX position + eligibility, for the opportunities read. */
export async function indexPositionInfo(address: string, indexPriceUsd: number): Promise<Record<string, unknown>> {
  const client = getPublicClient();
  const raw = await client.readContract({
    address: INDEX_TOKEN,
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [address as Address],
  });
  const tokens = Number(raw) / 1e18;
  return {
    tokens,
    valueUsd: tokens * indexPriceUsd,
    eligible: tokens >= ELIGIBILITY_THRESHOLD_TOKENS,
    thresholdTokens: ELIGIBILITY_THRESHOLD_TOKENS,
  };
}

/**
 * Approval steps (ERC20 -> Permit2, Permit2 -> router) still missing for
 * spending `amount` of `token` through `router`. Same freshness rule as the
 * carry: an expired Permit2 grant counts as missing.
 */
async function missingApprovalSteps(owner: Address, token: Address, router: Address, amount: bigint, label: string): Promise<PreparedStep[]> {
  const client = getPublicClient();
  const [erc20Allowance, [permit2Amount, permit2Expiration]] = await Promise.all([
    client.readContract({ address: token, abi: erc20AllowanceAbi, functionName: "allowance", args: [owner, PERMIT2] }),
    client.readContract({ address: PERMIT2, abi: permit2AllowanceAbi, functionName: "allowance", args: [owner, token, router] }),
  ]);
  const steps: PreparedStep[] = [];
  if (erc20Allowance < amount) {
    steps.push({
      kind: "approve-erc20",
      description: `Allow Permit2 to move your ${label} (one-time)`,
      to: token,
      data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [PERMIT2, (1n << 256n) - 1n] }),
      value: "0",
    });
  }
  const fresh = Number(permit2Expiration) > Math.floor(Date.now() / 1000) + 2 * SWAP_DEADLINE_SEC;
  if (BigInt(permit2Amount) < amount || !fresh) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    steps.push({
      kind: "approve-permit2",
      description: "Authorize the swap router through Permit2 (expires in 30 days)",
      to: PERMIT2,
      data: encodeFunctionData({ abi: permit2ApproveAbi, functionName: "approve", args: [token, router, (1n << 160n) - 1n, expiration] }),
      value: "0",
    });
  }
  return steps;
}

/**
 * Build the transactions to enter (toward eligibility) or fully exit the
 * $INDEX position. Enter may return an incomplete round (the USDG->ETH funding
 * swap) with continueWith:"enter" — the caller re-prepares after it lands.
 * Exit is all-or-nothing by design: a partial exit that drops the holding
 * under 10,000 tokens silently stops all distributions, which is exactly the
 * kind of foot-gun this surface exists to prevent.
 */
export async function prepareIndexYield(params: { address: string; amountUsd: number; direction: "enter" | "exit" }): Promise<Record<string, unknown>> {
  const { address, direction } = params;
  if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
  if (direction !== "enter" && direction !== "exit") throw new Error("direction must be enter or exit");
  const owner = address as Address;
  const client = getPublicClient();

  const [ethUsd, indexPerEth] = await Promise.all([fetchEthUsd(), readIndexPerEth()]);
  const indexPriceUsd = ethUsd / indexPerEth;

  if (direction === "exit") {
    const balance = await client.readContract({ address: INDEX_TOKEN, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] });
    if (balance === 0n) throw new Error("no payout position to exit");
    const steps = await missingApprovalSteps(owner, INDEX_TOKEN, INDEX_ROUTER, balance, "payout position");
    const tokens = Number(balance) / 1e18;
    const expectedOutEth = tokens / indexPerEth;
    const minOut = BigInt(Math.round(expectedOutEth * 1e18)) * (10_000n - INDEX_SLIPPAGE_BPS) / 10_000n;
    const swap = buildIndexSwapCalldata({
      zeroForOne: false,
      amountIn: balance, // exact wei — a float round-trip here can overshoot the real balance and revert
      amountOutMinimum: minOut,
      deadlineSec: Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC,
    });
    steps.push({
      kind: "swap",
      description: "Sell your full payout position back to ETH",
      to: swap.to,
      data: swap.data,
      value: swap.value.toString(),
    });
    return {
      ok: true,
      kind: "index-yield",
      chainId: 4663,
      direction,
      complete: true,
      amountInTokens: tokens,
      amountInUsd: tokens * indexPriceUsd,
      expectedOutEth,
      steps,
      note: "Exits the FULL position (a partial exit below the eligibility bar would silently stop payouts). The 3% fee applies on the way out too.",
    };
  }

  // ---- enter ----
  const amountUsd = Number(params.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_AMOUNT_USD) throw new Error(`amountUsd must be at least $${MIN_AMOUNT_USD}`);
  if (amountUsd > MAX_AMOUNT_USD) throw new Error(`amountUsd above the $${MAX_AMOUNT_USD.toLocaleString()} per-transaction cap (the pool is thin — impact grows fast with size)`);

  const [ethRaw, usdgRaw, indexRaw] = await Promise.all([
    client.getBalance({ address: owner }),
    client.readContract({ address: USDG, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: INDEX_TOKEN, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] }),
  ]);
  const ethBalance = Number(ethRaw) / 1e18;
  const usdgBalance = Number(usdgRaw) / 1e6;
  const currentTokens = Number(indexRaw) / 1e18;

  const ethNeeded = amountUsd / ethUsd;
  const spendableEth = ethBalance - GAS_RESERVE_ETH;

  // Eligibility picture at this size: the floor uses the slippage-bound minimum
  // out, so "you'd reach eligibility" is a guarantee, not an estimate.
  const projectedTokensFloor = ethNeeded * indexPerEth * Number(10_000n - INDEX_SLIPPAGE_BPS) / 10_000;
  const deficit = Math.max(0, ELIGIBILITY_THRESHOLD_TOKENS - currentTokens);
  const suggestedUsd = deficit > 0 ? Math.ceil((deficit / indexPerEth) * ethUsd / (Number(10_000n - INDEX_SLIPPAGE_BPS) / 10_000) * 1.02) : 0;
  const eligibility = {
    thresholdTokens: ELIGIBILITY_THRESHOLD_TOKENS,
    currentTokens,
    projectedTokensFloor,
    reachesThreshold: currentTokens + projectedTokensFloor >= ELIGIBILITY_THRESHOLD_TOKENS,
    suggestedUsd,
  };

  if (spendableEth >= ethNeeded) {
    const amountIn = BigInt(Math.round(ethNeeded * 1e18));
    const minOut = BigInt(Math.round(ethNeeded * indexPerEth * 1e18)) * (10_000n - INDEX_SLIPPAGE_BPS) / 10_000n;
    const swap = buildIndexSwapCalldata({
      zeroForOne: true,
      amountIn,
      amountOutMinimum: minOut,
      deadlineSec: Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC,
    });
    return {
      ok: true,
      kind: "index-yield",
      chainId: 4663,
      direction,
      complete: true,
      amountInUsd: amountUsd,
      expectedTokens: ethNeeded * indexPerEth,
      minTokens: Number(minOut) / 1e18,
      eligibility,
      steps: [
        {
          kind: "swap",
          description: `Open the payout position with ${ethNeeded.toFixed(5)} ETH`,
          to: swap.to,
          data: swap.data,
          value: swap.value.toString(),
        } satisfies PreparedStep,
      ],
      note: "The 3% entry fee funds the very payouts you'll receive; it plus pool fees and impact sit inside the 6% slippage floor. Payouts land as stock tokens in your wallet.",
    };
  }

  // Not enough ETH: fund it from USDG through the deep bridge pool first.
  const shortfallUsd = (ethNeeded - spendableEth) * ethUsd * 1.01; // 1% buffer so the re-prepare doesn't come up short again
  if (usdgBalance < shortfallUsd) {
    throw new Error(
      `not enough to enter at $${amountUsd.toFixed(0)}: this needs ~${ethNeeded.toFixed(5)} ETH and the wallet has ${Math.max(0, spendableEth).toFixed(5)} spendable ETH + ${usdgBalance.toFixed(2)} USDG`,
    );
  }
  const usdgIn = BigInt(Math.round(shortfallUsd * 1e6));
  const fundRoute: RouteHop[] = [{ outputCurrency: NATIVE, fee: 500, tickSpacing: 10 }]; // the same 0.05% ETH/USDG bridge pool every house ETH-entry uses
  const rate = await hopRate(USDG, fundRoute[0]);
  const minOut = BigInt(Math.round(Number(usdgIn) * rate)) * (10_000n - FUND_SLIPPAGE_BPS) / 10_000n;
  const steps = await missingApprovalSteps(owner, USDG, STOCK_ROUTER, usdgIn, "USDG");
  const fundSwap = buildSwapExactInCalldata({
    currencyIn: USDG,
    route: fundRoute,
    amountIn: usdgIn,
    amountOutMinimum: minOut,
    recipient: owner,
    deadlineSec: Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC,
  });
  steps.push({
    kind: "swap",
    description: `Convert ${(Number(usdgIn) / 1e6).toFixed(2)} USDG to ETH (funding step)`,
    to: fundSwap.to,
    data: fundSwap.data,
    value: fundSwap.value.toString(),
  });
  return {
    ok: true,
    kind: "index-yield",
    chainId: 4663,
    direction,
    complete: false,
    continueWith: "enter",
    amountInUsd: amountUsd,
    eligibility,
    steps,
    note: "The payout pool is ETH-quoted, so this round converts USDG to ETH first. Once it lands, the entry is prepared against your real ETH balance.",
  };
}
