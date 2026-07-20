// Does the ETH/$INDEX pool's 1% LP fee ACTUALLY accrue to LPs? feeGrowthGlobal
// is the on-chain truth: it only grows when swap fees are credited to in-range
// liquidity. Read it now and ~1 day back, convert the delta to USD/day, and
// compare against the Swap-log estimate. Read-only.
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const NATIVE = "0x0000000000000000000000000000000000000000";
const INDEX = "0x56910D4409F3a0C78C64DD8D0545FF0705389870";
const HOOK = "0x2cD91bD228ff4c537031d6b8204782090c84c0cC";
const Q96 = 2 ** 96, Q128 = 2 ** 128;

const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const id = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [NATIVE, INDEX, 10000, 200, HOOK]));

const fggAbi = [parseAbiItem("function getFeeGrowthGlobals(bytes32) view returns (uint256, uint256)")];
const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];
const slotAbi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)")];

const head = await client.getBlockNumber();
const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
const probeB = await client.getBlock({ blockNumber: head - 500000n });
const bps = 500000 / (headTs - Number(probeB.timestamp));
const dayAgo = head - BigInt(Math.round(1 * 86400 * bps));

async function read(block) {
  const [fgg, L] = await Promise.all([
    client.readContract({ address: SV, abi: fggAbi, functionName: "getFeeGrowthGlobals", args: [id], blockNumber: block }),
    client.readContract({ address: SV, abi: liqAbi, functionName: "getLiquidity", args: [id], blockNumber: block }),
  ]);
  return { fgg0: Number(fgg[0]) / Q128, fgg1: Number(fgg[1]) / Q128, L: Number(L) };
}

const [now, past] = await Promise.all([read(head), read(dayAgo)]);
const [sp] = await client.readContract({ address: SV, abi: slotAbi, functionName: "getSlot0", args: [id] });
const indexPerEth = (Number(sp) / Q96) ** 2;
const ethRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?range=1d&interval=1d", { headers: { "User-Agent": "Mozilla/5.0 (Meridian probe)" } });
const ethUsd = (await ethRes.json()).chart.result[0].meta.regularMarketPrice;

// feeGrowth is fees-per-unit-liquidity; × average L ≈ total fees credited.
const avgL = (now.L + past.L) / 2;
const eth0 = (now.fgg0 - past.fgg0) * avgL / 1e18; // token0 = ETH fees
const idx1 = (now.fgg1 - past.fgg1) * avgL / 1e18; // token1 = $INDEX fees
console.log(`L now ${now.L.toExponential(3)}, 1d ago ${past.L.toExponential(3)}`);
console.log(`feeGrowth delta/day: ${eth0.toFixed(4)} ETH (~$${(eth0 * ethUsd).toFixed(0)}) + ${Math.round(idx1).toLocaleString()} $INDEX (~$${(idx1 * (ethUsd / indexPerEth)).toFixed(0)})`);
console.log(`=> total LP fees actually credited: ~$${((eth0 * ethUsd) + idx1 * (ethUsd / indexPerEth)).toFixed(0)}/day`);
