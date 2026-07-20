// Real Uniswap v4 liquidity positions on the depth-verified stock pools —
// the LP side of the business: instead of paying the pool's fee on every
// trade, own a share of the range and collect it. Encoding verified against
// real successful mints on this chain (tx 0x5652c553…, canonical
// PositionManager, standard v4-periphery actions — unlike the router, this
// path is NOT forked).
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiParameters,
  parseAbiItem,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { getPublicClient, getWalletClient, getAgentSigner } from "./signer.js";
import { guardWalletOp, recordWalletOp } from "../risk.js";
import { INDEX_CONTRACTS } from "./indexContracts.js";
import { recordExecution } from "../executionsLog.js";
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";

const POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;

// v4-periphery action ids (verified live on this chain)
const MINT_POSITION = "0x02";
const DECREASE_LIQUIDITY = "0x01";
const SETTLE_PAIR = "0x0d";
const TAKE_PAIR = "0x11";

const POSITIONS_PATH = dataPath("lp-positions.jsonl");

// LP-able pools: same keys as stockPools.POOLS, USDG-quoted.
const LP_POOLS: Record<string, { token: Address; fee: number; tickSpacing: number }> = {
  NVDA: { token: INDEX_CONTRACTS.tokens.NVDA as Address, fee: 3000, tickSpacing: 60 },
  TSLA: { token: INDEX_CONTRACTS.tokens.TSLA as Address, fee: 3000, tickSpacing: 60 },
  META: { token: INDEX_CONTRACTS.tokens.META as Address, fee: 3000, tickSpacing: 60 },
  AAPL: { token: INDEX_CONTRACTS.tokens.AAPL as Address, fee: 10000, tickSpacing: 200 },
  GOOGL: { token: INDEX_CONTRACTS.tokens.GOOGL as Address, fee: 10000, tickSpacing: 200 },
};

const pmAbi = [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")];
const erc20Abi = [
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
];
const permit2Abi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
  parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)"),
];

function poolKeyOf(symbol: string) {
  const p = LP_POOLS[symbol];
  if (!p) throw new Error(`no LP pool config for ${symbol}`);
  const [currency0, currency1] = p.token.toLowerCase() < USDG.toLowerCase() ? [p.token, USDG] : [USDG, p.token];
  return { currency0, currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: NATIVE, token: p.token };
}

export async function poolTick(symbol: string): Promise<number> {
  return (await slot0(symbol)).tick;
}

async function slot0(symbol: string): Promise<{ sqrtP: number; tick: number }> {
  const k = poolKeyOf(symbol);
  const id = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, NATIVE]),
  );
  const [sqrtP, tick] = await getPublicClient().readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [id],
  });
  return { sqrtP: Number(sqrtP), tick: Number(tick) };
}

async function ensureApprovedForPM(token: Address): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const erc20Allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2] });
  if (erc20Allowance < 1n << 128n) {
    const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [PERMIT2, (1n << 256n) - 1n] });
    await client.waitForTransactionReceipt({ hash });
  }
  const [p2] = await client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [signer.address, token, POSITION_MANAGER] });
  if (BigInt(p2) < 1n << 100n) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, POSITION_MANAGER, (1n << 160n) - 1n, expiration],
    });
    await client.waitForTransactionReceipt({ hash });
  }
}

const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick) * Q96;

export interface LpPositionRecord {
  tokenId: string;
  symbol: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  usdgIn: number;
  tokenIn: number;
  mintedAt: number;
  txHash: string;
}

/**
 * Mint a concentrated two-sided range around the current price, sized to the
 * wallet's ACTUAL balances of both currencies (deploys the largest liquidity
 * both sides can support). widthPct is total width, e.g. 4 => ±2%.
 */
export async function mintRange(params: { symbol: string; widthPct: number }): Promise<LpPositionRecord> {
  const { symbol, widthPct } = params;
  guardWalletOp(`lp-mint ${symbol}`); // global runaway breaker (counts every deploy attempt)
  recordWalletOp(0, "lp-mint");
  const k = poolKeyOf(symbol);
  const signer = getAgentSigner()!;
  const client = getPublicClient();
  const { sqrtP, tick } = await slot0(symbol);

  const halfTicks = Math.log(1 + widthPct / 200) / Math.log(1.0001);
  const ts = k.tickSpacing;
  const tickLower = Math.floor((tick - halfTicks) / ts) * ts;
  const tickUpper = Math.ceil((tick + halfTicks) / ts) * ts;

  const [bal0Raw, bal1Raw] = await Promise.all(
    [k.currency0, k.currency1].map((c) =>
      client.readContract({ address: c, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
    ),
  );
  // Keep a whisper of headroom so maxes never bind on rounding.
  const amt0 = Number(bal0Raw) * 0.995;
  const amt1 = Number(bal1Raw) * 0.995;

  const sC = Math.min(Math.max(sqrtP, sqrtAtTick(tickLower)), sqrtAtTick(tickUpper));
  const sA = sqrtAtTick(tickLower);
  const sB = sqrtAtTick(tickUpper);
  // In-range: currency0 fills [current..upper], currency1 fills [lower..current].
  const lFrom0 = (amt0 * ((sC / Q96) * (sB / Q96))) / (sB / Q96 - sC / Q96);
  const lFrom1 = amt1 / (sC / Q96 - sA / Q96);
  // Extra 1% haircut on the final liquidity: the pool pulls amounts at
  // EXECUTION-time price, not calc-time price, and the first live re-center
  // reverted exactly here — price drifted mid-rally and the needed amount
  // busted the balance cap. Headroom buys ~±1.5% of drift tolerance.
  const liquidity = BigInt(Math.floor(Math.min(lFrom0, lFrom1) * 0.99));
  if (liquidity <= 0n) throw new Error("insufficient balances for any liquidity in this range");

  await ensureApprovedForPM(k.currency0);
  await ensureApprovedForPM(k.currency1);

  const mintParams = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
    [
      [k.currency0, k.currency1, k.fee, k.tickSpacing, NATIVE],
      tickLower,
      tickUpper,
      liquidity,
      bal0Raw, // amountMax caps: never spend beyond the wallet's real balances
      bal1Raw,
      signer.address,
      "0x",
    ],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [k.currency0, k.currency1]);
  const actions = encodePacked(["bytes1", "bytes1"], [MINT_POSITION, SETTLE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [mintParams, settleParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`mint reverted: ${hash}`);

  // tokenId from the ERC721 mint Transfer(0x0 -> us) on the PositionManager.
  const transferTopic = keccak256(toBytes("Transfer(address,address,uint256)"));
  const mintLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === POSITION_MANAGER.toLowerCase() && l.topics[0] === transferTopic && BigInt(l.topics[1]!) === 0n,
  );
  const tokenId = mintLog ? BigInt(mintLog.topics[3]!).toString() : "unknown";

  const [after0, after1] = await Promise.all(
    [k.currency0, k.currency1].map((c) =>
      client.readContract({ address: c, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
    ),
  );
  const usdgIsC0 = k.currency0.toLowerCase() === USDG.toLowerCase();
  const usdgIn = Number((usdgIsC0 ? bal0Raw : bal1Raw) - (usdgIsC0 ? after0 : after1)) / 1e6;
  const tokenIn = Number((usdgIsC0 ? bal1Raw : bal0Raw) - (usdgIsC0 ? after1 : after0)) / 1e18;

  const record: LpPositionRecord = {
    tokenId,
    symbol,
    tickLower,
    tickUpper,
    liquidity: liquidity.toString(),
    usdgIn,
    tokenIn,
    mintedAt: Date.now(),
    txHash: hash,
  };
  appendLedger("lp-positions.jsonl", record);
  recordExecution({ ts: Date.now(), kind: "lp-mint", fromSymbol: "USDG", toSymbol: symbol, amountUsd: usdgIn * 2, success: true, txHash: hash });
  return record;
}

/** Positions minted but not yet closed (closure rows share the same file). */
export function openPositions(): LpPositionRecord[] {
  if (!existsSync(POSITIONS_PATH)) return [];
  const minted = new Map<string, LpPositionRecord>();
  const closed = new Set<string>();
  for (const line of readFileSync(POSITIONS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.closedAt) closed.add(String(r.tokenId));
      else if (r.tokenId) minted.set(String(r.tokenId), r as LpPositionRecord);
    } catch {}
  }
  return [...minted.values()].filter((p) => !closed.has(String(p.tokenId)));
}

export interface LpPositionValue extends LpPositionRecord {
  inRange: boolean;
  usdgAmount: number;
  tokenAmount: number;
  tokenPriceUsd: number;
  valueUsd: number;
  rangePct: number;
}

/** Open positions marked to current pool state: what the range holds right now and its USD value (excl. uncollected fees). */
export async function lpPositionsWithValue(): Promise<LpPositionValue[]> {
  const out: LpPositionValue[] = [];
  for (const p of openPositions()) {
    const k = poolKeyOf(p.symbol);
    const { sqrtP, tick } = await slot0(p.symbol);
    const L = Number(p.liquidity);
    const sA = sqrtAtTick(p.tickLower);
    const sB = sqrtAtTick(p.tickUpper);
    const sC = Math.min(Math.max(sqrtP, sA), sB);
    const amount0 = L * Q96 * (1 / sC - 1 / sB);
    const amount1 = (L * (sC - sA)) / Q96;
    const usdgIs0 = k.currency0.toLowerCase() === USDG.toLowerCase();
    const usdgAmount = (usdgIs0 ? amount0 : amount1) / 1e6;
    const tokenAmount = (usdgIs0 ? amount1 : amount0) / 1e18;
    const praw = (sqrtP / Q96) ** 2; // currency1 raw per currency0 raw
    const tokenPriceUsd = (usdgIs0 ? 1 / praw : praw) * 1e12;
    out.push({
      ...p,
      inRange: tick >= p.tickLower && tick < p.tickUpper,
      usdgAmount,
      tokenAmount,
      tokenPriceUsd,
      valueUsd: usdgAmount + tokenAmount * tokenPriceUsd,
      rangePct: (1.0001 ** ((p.tickUpper - p.tickLower) / 2) - 1) * 100,
    });
  }
  return out;
}

/**
 * Realize accrued fees WITHOUT closing the position: a zero-liquidity decrease
 * sweeps the owed fees, TAKE_PAIR sends them to the wallet, and the position's
 * liquidity and range are untouched (it keeps earning). Measured as the real
 * balance delta across both currencies.
 */
/** USD value of fees owed but not yet collected on a position — drives auto-collect. */
export async function uncollectedFeesUsd(p: LpPositionRecord): Promise<number> {
  const k = poolKeyOf(p.symbol);
  const client = getPublicClient();
  const poolId = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, NATIVE]),
  );
  const salt = `0x${BigInt(p.tokenId).toString(16).padStart(64, "0")}` as Hex;
  const posKey = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [POSITION_MANAGER, p.tickLower, p.tickUpper, salt]));
  const [liq, last0, last1] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getPositionInfo(bytes32,bytes32) view returns (uint128,uint256,uint256)")],
    functionName: "getPositionInfo",
    args: [poolId, posKey],
  });
  const [now0, now1] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)")],
    functionName: "getFeeGrowthInside",
    args: [poolId, p.tickLower, p.tickUpper],
  });
  const [sqrtP] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [poolId],
  });
  const L = Number(liq);
  const fee0 = (Number(BigInt(now0) - BigInt(last0)) * L) / 2 ** 128;
  const fee1 = (Number(BigInt(now1) - BigInt(last1)) * L) / 2 ** 128;
  const usdgIs0 = k.currency0.toLowerCase() === USDG.toLowerCase();
  const tokenUsd = ((usdgIs0 ? 1 / ((Number(sqrtP) / Q96) ** 2) : (Number(sqrtP) / Q96) ** 2)) * 1e12;
  return (usdgIs0 ? fee0 : fee1) / 1e6 + ((usdgIs0 ? fee1 : fee0) / 1e18) * tokenUsd;
}

export async function collectFees(params: { tokenId: string; symbol: string }): Promise<{ txHash: Hex; usdgCollected: number; tokenCollected: number }> {
  const k = poolKeyOf(params.symbol);
  const signer = getAgentSigner()!;
  const client = getPublicClient();
  const bal = (t: Address) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] });
  const [usdgBefore, tokenBefore] = await Promise.all([bal(USDG), bal(k.token)]);

  const decreaseParams = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
    [BigInt(params.tokenId), 0n, 0n, 0n, "0x"], // 0 liquidity removed → only fees move
  );
  const takeParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [k.currency0, k.currency1, signer.address]);
  const actions = encodePacked(["bytes1", "bytes1"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [decreaseParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`collect reverted: ${hash}`);

  const [usdgAfter, tokenAfter] = await Promise.all([bal(USDG), bal(k.token)]);
  const usdgCollected = Number(usdgAfter - usdgBefore) / 1e6;
  const tokenCollected = Number(tokenAfter - tokenBefore) / 1e18;
  recordExecution({ ts: Date.now(), kind: "lp-collect", fromSymbol: params.symbol, toSymbol: "USDG", amountUsd: usdgCollected, success: true, txHash: hash });
  return { txHash: hash, usdgCollected, tokenCollected };
}

/** The most recent minted position (open or closed) — tells auto-recovery which pool we were last in and roughly how much was deployed. */
export function lastMintedPosition(): { symbol: string; depositUsd: number } | null {
  if (!existsSync(POSITIONS_PATH)) return null;
  let last: LpPositionRecord | null = null;
  for (const line of readFileSync(POSITIONS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.symbol && r.usdgIn != null) last = r as LpPositionRecord; // a mint row (closure rows have no symbol/usdgIn)
    } catch {}
  }
  return last ? { symbol: last.symbol, depositUsd: last.usdgIn * 2 } : null; // balanced mint ≈ 2× the USDG side
}

/** Pull a position: remove all (or part of) its liquidity and take both currencies back to the wallet. */
export async function withdrawPosition(params: { tokenId: string; symbol: string; liquidity: string }): Promise<{ txHash: Hex }> {
  const k = poolKeyOf(params.symbol);
  const signer = getAgentSigner()!;
  const decreaseParams = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
    [BigInt(params.tokenId), BigInt(params.liquidity), 0n, 0n, "0x"],
  );
  const takeParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [k.currency0, k.currency1, signer.address]);
  const actions = encodePacked(["bytes1", "bytes1"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [decreaseParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`withdraw reverted: ${hash}`);
  appendLedger("lp-positions.jsonl", { tokenId: params.tokenId, closedAt: Date.now(), txHash: hash });
  recordExecution({ ts: Date.now(), kind: "lp-exit", fromSymbol: params.symbol, toSymbol: "USDG", amountUsd: 0, success: true, txHash: hash });
  return { txHash: hash };
}
