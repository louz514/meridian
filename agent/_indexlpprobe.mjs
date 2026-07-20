// Read-only probe: is LPing the ETH/$INDEX hook pool a real play?
// Measures (1) live in-range liquidity + depth, (2) the hook's declared
// permission flags (address low bits — v4 encodes powers there), (3) REAL
// swap volume from PoolManager logs over ~2.5 days, (4) the fee share a
// $500 concentrated position would earn at several widths, and (5) whether
// a mint through our standard PositionManager actually lands in this HOOKED
// pool, via eth_call simulation (one-sided ETH-only range so it needs no
// $INDEX balance). Nothing here signs or sends. Run:
//   set -a; source .env; set +a; node _indexlpprobe.mjs
import { createPublicClient, http, keccak256, encodeAbiParameters, encodePacked, encodeFunctionData, parseAbiParameters, parseAbiItem } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951"; // PoolManager
const POSM = "0x58daec3116aae6d93017baaea7749052e8a04fa7"; // PositionManager
const NATIVE = "0x0000000000000000000000000000000000000000";
const INDEX = "0x56910D4409F3a0C78C64DD8D0545FF0705389870";
const HOOK = "0x2cD91bD228ff4c537031d6b8204782090c84c0cC";
const FEE = 10000, TS = 200, FEE_RATE = 0.01; // 1% LP tier, verified on-chain
const WALLET = process.env.MERIDIAN_WALLET_ADDRESS || "0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c";
const Q96 = 2 ** 96;
const CAPITAL = 500; // hypothetical position size for the fee-share table
const LOOKBACK_DAYS = 2.5;

const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });

// ---- 1. pool state ----------------------------------------------------------
const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [NATIVE, INDEX, FEE, TS, HOOK]));
const [sqrtPRaw, tick] = await client.readContract({
  address: SV, abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)")],
  functionName: "getSlot0", args: [id],
});
const L = Number(await client.readContract({
  address: SV, abi: [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")],
  functionName: "getLiquidity", args: [id],
}));
const s = Number(sqrtPRaw);
const indexPerEth = (s / Q96) ** 2;

const ethRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?range=1d&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (Meridian probe)" } });
const ethUsd = (await ethRes.json()).chart.result[0].meta.regularMarketPrice;
const indexUsd = ethUsd / indexPerEth;

// ETH needed to move the price 2% in each direction, from live in-range L.
const fDown = Math.sqrt(0.98), fUp = Math.sqrt(1.02);
const ethInFor2pctDown = (L * Q96 * (1 / (s * fDown) - 1 / s)) / 1e18; // ETH in (buy INDEX)
const indexInFor2pctUp = (L * (s * fUp - s)) / Q96 / 1e18; // INDEX in (sell INDEX)
console.log(`== pool state ==`);
console.log(`sqrtPrice ok, tick ${tick}, in-range L ${L.toExponential(3)}`);
console.log(`$INDEX ~$${indexUsd.toFixed(5)} (ETH $${ethUsd.toFixed(0)})`);
console.log(`depth: ~$${(ethInFor2pctDown * ethUsd).toFixed(0)} of ETH buys move price 2%; ~$${(indexInFor2pctUp * indexUsd).toFixed(0)} of $INDEX sells move it 2%`);

// ---- 2. hook flags ----------------------------------------------------------
const FLAGS = [
  [13, "BEFORE_INITIALIZE"], [12, "AFTER_INITIALIZE"],
  [11, "BEFORE_ADD_LIQUIDITY"], [10, "AFTER_ADD_LIQUIDITY"],
  [9, "BEFORE_REMOVE_LIQUIDITY"], [8, "AFTER_REMOVE_LIQUIDITY"],
  [7, "BEFORE_SWAP"], [6, "AFTER_SWAP"], [5, "BEFORE_DONATE"], [4, "AFTER_DONATE"],
  [3, "BEFORE_SWAP_RETURNS_DELTA"], [2, "AFTER_SWAP_RETURNS_DELTA"],
  [1, "AFTER_ADD_LIQ_RETURNS_DELTA"], [0, "AFTER_REMOVE_LIQ_RETURNS_DELTA"],
];
const bits = Number(BigInt(HOOK) & 0x3fffn);
const set = FLAGS.filter(([b]) => bits & (1 << b)).map(([, n]) => n);
console.log(`\n== hook flags (address low bits) ==`);
console.log(set.join(", ") || "none");
console.log(`liquidity hooks: ${set.some((n) => n.includes("LIQUIDITY") || n.includes("LIQ")) ? "PRESENT — LP ops intercepted" : "ABSENT — LP ops are standard v4"}`);

// ---- 3. real volume from Swap logs ------------------------------------------
const head = await client.getBlockNumber();
const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
const probeB = await client.getBlock({ blockNumber: head - 500000n });
const bps = 500000 / (headTs - Number(probeB.timestamp));
const fromBlock = head - BigInt(Math.round(LOOKBACK_DAYS * 86400 * bps));
const swapEvent = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
let volEth = 0, swaps = 0, from = fromBlock, step = 300000n;
while (from <= head) {
  const to = from + step - 1n > head ? head : from + step - 1n;
  try {
    const logs = await client.getLogs({ address: PM, event: swapEvent, args: { id: [id] }, fromBlock: from, toBlock: to });
    for (const l of logs) { volEth += Math.abs(Number(l.args.amount0)) / 1e18; swaps++; }
    from = to + 1n;
  } catch { if (step > 25000n) { step /= 2n; continue; } from = to + 1n; }
}
const volUsdDay = (volEth * ethUsd) / LOOKBACK_DAYS;
const lpFeesDay = volUsdDay * FEE_RATE;
console.log(`\n== measured volume (${LOOKBACK_DAYS}d of Swap logs) ==`);
console.log(`${swaps} swaps, ETH-side ~$${Math.round(volUsdDay).toLocaleString()}/day -> LP fees ~$${lpFeesDay.toFixed(0)}/day at ${FEE_RATE * 100}%`);

// ---- 4. fee share for a $500 position ---------------------------------------
console.log(`\n== $${CAPITAL} two-sided position, share of in-range L ==`);
for (const widthPct of [10, 20, 50]) {
  const f = Math.sqrt(1 + widthPct / 200); // ± half-width
  const sA = s / f, sB = s * f;
  const amt0 = ((CAPITAL / 2) / ethUsd) * 1e18; // ETH side, raw
  const amt1 = ((CAPITAL / 2) / indexUsd) * 1e18; // INDEX side, raw
  const L0 = (amt0 * ((s / Q96) * (sB / Q96))) / (sB / Q96 - s / Q96);
  const L1 = amt1 / (s / Q96 - sA / Q96);
  const our = Math.min(L0, L1);
  const share = our / (L + our);
  const perDay = lpFeesDay * share;
  console.log(`±${widthPct / 2}%: share ${(share * 100).toFixed(1)}% -> ~$${perDay.toFixed(2)}/day (~${((perDay * 365 / CAPITAL) * 100).toFixed(0)}% APR before IL)`);
}

// ---- 5. mint simulation (eth_call, no state change) --------------------------
// One-sided range fully ABOVE current tick: needs only currency0 (native ETH),
// which the house wallet holds a little of — no $INDEX required to prove the
// mint path works in a HOOKED pool.
const tickLower = (Math.floor(tick / TS) + 2) * TS;
const tickUpper = tickLower + 2 * TS;
const sqrtAtTick = (t) => Math.sqrt(1.0001 ** t) * Q96;
const ethSim = 0.0005 * 1e18;
const sA2 = sqrtAtTick(tickLower), sB2 = sqrtAtTick(tickUpper);
const simL = BigInt(Math.floor((ethSim * ((sA2 / Q96) * (sB2 / Q96))) / (sB2 / Q96 - sA2 / Q96) * 0.99));
const mintParams = encodeAbiParameters(
  parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
  [[NATIVE, INDEX, FEE, TS, HOOK], tickLower, tickUpper, simL, BigInt(Math.round(ethSim * 1.05)), 0n, WALLET, "0x"],
);
const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [NATIVE, INDEX]);
const actions = encodePacked(["bytes1", "bytes1"], ["0x02", "0x0d"]); // MINT_POSITION, SETTLE_PAIR
const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [mintParams, settleParams]]);
const data = encodeFunctionData({
  abi: [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")],
  functionName: "modifyLiquidities",
  args: [unlockData, BigInt(Math.floor(Date.now() / 1000) + 300)],
});
console.log(`\n== mint simulation (one-sided ~0.0005 ETH, ticks ${tickLower}..${tickUpper}) ==`);
try {
  await client.call({ account: WALLET, to: POSM, data, value: BigInt(Math.round(ethSim * 1.05)) });
  console.log("MINT SIMULATION OK — the hooked pool accepts standard PositionManager mints");
} catch (e) {
  console.log("MINT SIMULATION REVERTED:", e?.shortMessage ?? e?.message ?? e);
}
