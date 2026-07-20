// LP backtest for the ETH/$INDEX hook pool: replay the REAL swap history over
// a hypothetical $500 concentrated position at several widths, and compute
// fees earned minus impermanent loss vs simply holding the deposited tokens.
// The Swap event stream carries post-swap sqrtPrice AND live in-range
// liquidity, so per-swap fee shares use the actual competing liquidity at that
// moment, and swap direction is inferred from price movement (no sign-
// convention guessing). Model calibration: total modeled LP fees are checked
// against the feeGrowthGlobal-measured ~$4.9k/day ground truth.
// Approximations, stated: fees ignore partial range-crossings within one swap,
// our hypothetical liquidity is assumed not to change the path, and both the
// LP and hold legs are valued at FINAL pool prices in USD (same numeraire, so
// market beta cancels; what remains is fees vs IL). Read-only.
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";
const INDEX = "0x56910D4409F3a0C78C64DD8D0545FF0705389870";
const HOOK = "0x2cD91bD228ff4c537031d6b8204782090c84c0cC";
const FEE_RATE = 0.01;
const Q96 = 2 ** 96;
const CAPITAL = 500;
const LOOKBACK_DAYS = Number(process.env.LP_BT_DAYS ?? 5);
const WIDTHS = [10, 20, 50]; // total width %, i.e. ±5 / ±10 / ±25

const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [NATIVE, INDEX, 10000, 200, HOOK]));

// ---- fetch the swap path ----------------------------------------------------
const head = await client.getBlockNumber();
const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
const probeB = await client.getBlock({ blockNumber: head - 500000n });
const bps = 500000 / (headTs - Number(probeB.timestamp));
const fromBlock = head - BigInt(Math.round(LOOKBACK_DAYS * 86400 * bps));
const swapEvent = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");

const events = [];
let from = fromBlock, step = 300000n;
while (from <= head) {
  const to = from + step - 1n > head ? head : from + step - 1n;
  try {
    const logs = await client.getLogs({ address: PM, event: swapEvent, args: { id: [id] }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      events.push({
        block: Number(l.blockNumber),
        a0: Number(l.args.amount0) / 1e18,
        a1: Number(l.args.amount1) / 1e18,
        r: Number(l.args.sqrtPriceX96) / Q96, // post-swap sqrt(price_raw)
        L: Number(l.args.liquidity),
        tick: Number(l.args.tick),
      });
    }
    from = to + 1n;
  } catch { if (step > 25000n) { step /= 2n; continue; } from = to + 1n; }
}
events.sort((x, y) => x.block - y.block);
if (events.length < 100) { console.log(`only ${events.length} swaps — not enough path`); process.exit(1); }

const ethRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?range=1d&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (Meridian probe)" } });
const ethUsd = (await ethRes.json()).chart.result[0].meta.regularMarketPrice;

const first = events[0], last = events[events.length - 1];
const days = (last.block - first.block) / bps / 86400;
const px = (r) => r * r; // INDEX per ETH, raw
const indexUsdAt = (r) => ethUsd / px(r);
console.log(`== path: ${events.length} swaps over ${days.toFixed(1)}d ==`);
console.log(`$INDEX ${indexUsdAt(first.r).toFixed(5)} -> ${indexUsdAt(last.r).toFixed(5)} USD (${(((indexUsdAt(last.r) / indexUsdAt(first.r)) - 1) * 100).toFixed(1)}%)`);
const ticks = events.map((e) => e.tick);
console.log(`tick range ${Math.min(...ticks)}..${Math.max(...ticks)} (entry ${first.tick}) — full span ${(((1.0001 ** (Math.max(...ticks) - Math.min(...ticks))) - 1) * 100).toFixed(1)}%`);

// ---- per-swap fee model + calibration ---------------------------------------
// Direction from price movement: sqrtPrice DOWN => token0 (ETH) was the input.
// Fee = 1% of the input amount, credited pro-rata to in-range liquidity.
function swapFees(prevR, e) {
  const ethIn = e.r <= prevR;
  const amtIn = Math.abs(ethIn ? e.a0 : e.a1);
  return { ethIn, fee: amtIn * FEE_RATE }; // in input-token units
}
let modelFee0 = 0, modelFee1 = 0;
{
  let prevR = first.r;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const { ethIn, fee } = swapFees(prevR, e);
    if (ethIn) modelFee0 += fee; else modelFee1 += fee;
    prevR = e.r;
  }
}
const modeledPerDay = (modelFee0 * ethUsd + modelFee1 * indexUsdAt(last.r)) / days;
console.log(`\nmodel calibration: modeled ALL-LP fees ~$${modeledPerDay.toFixed(0)}/day (feeGrowth ground truth was ~$4.9k/day) — ratio ${(modeledPerDay / 4923).toFixed(2)}x`);

// ---- position replay --------------------------------------------------------
for (const widthPct of WIDTHS) {
  const f = Math.sqrt(1 + widthPct / 100); // sqrt of full width factor => ± half
  const r0 = first.r;
  const rA = r0 / f, rB = r0 * f;
  const indexUsd0 = indexUsdAt(r0);
  // $250 each side at entry
  const amt0dep = (CAPITAL / 2) / ethUsd; // ETH
  const amt1dep = (CAPITAL / 2) / indexUsd0; // INDEX
  const L0 = (amt0dep * 1e18 * (r0 * rB)) / (rB - r0);
  const L1 = (amt1dep * 1e18) / (r0 - rA);
  const ourL = Math.min(L0, L1);
  // exact deposit for ourL (leftover stays in the wallet on both legs — cancels)
  const dep0 = (ourL * (rB - r0)) / (r0 * rB) / 1e18;
  const dep1 = (ourL * (r0 - rA)) / 1e18;

  let fee0 = 0, fee1 = 0, inRangeSwaps = 0;
  let prevR = first.r;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const { ethIn, fee } = swapFees(prevR, e);
    const inRange = e.r > rA && e.r < rB;
    if (inRange) {
      inRangeSwaps++;
      const share = ourL / (e.L + ourL);
      if (ethIn) fee0 += fee * share; else fee1 += fee * share;
    }
    prevR = e.r;
  }

  // final position composition at last price
  const rC = Math.min(Math.max(last.r, rA), rB);
  const pos0 = (ourL * (rB - rC)) / (rC * rB) / 1e18;
  const pos1 = (ourL * (rC - rA)) / 1e18;
  const indexUsdEnd = indexUsdAt(last.r);
  const posVal = pos0 * ethUsd + pos1 * indexUsdEnd;
  const holdVal = dep0 * ethUsd + dep1 * indexUsdEnd;
  const feesUsd = fee0 * ethUsd + fee1 * indexUsdEnd;
  const il = posVal - holdVal; // negative = impermanent loss
  const net = feesUsd + il;
  const deposited = dep0 * ethUsd + dep1 * indexUsd0;
  console.log(`\n±${widthPct / 2}%  (deposited ~$${deposited.toFixed(0)})`);
  console.log(`  in range for ${((inRangeSwaps / (events.length - 1)) * 100).toFixed(0)}% of swaps`);
  console.log(`  fees earned   ~$${feesUsd.toFixed(2)}  (${(feesUsd / days).toFixed(2)}/day)`);
  console.log(`  IL vs hold    ~$${il.toFixed(2)}`);
  console.log(`  NET           ~$${net.toFixed(2)} over ${days.toFixed(1)}d  => ~${((net / deposited / days) * 365 * 100).toFixed(0)}% APR net of IL`);
}
