// LP prospector: scan every Index ticker x standard fee tier for a USDG pool on
// Robinhood Chain, read live depth, and rank what's actually tappable. Answers
// "are there more pools worth making markets in than the 5 we deploy into?"
// Read-only. Run: node _lpprospect.mjs
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"; // StateView
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NATIVE = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;
const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });

// all 18 Index tokens
const TOKENS = {
  AAPL:"0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", AMD:"0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
  AMZN:"0x12f190a9f9d7d37a250758b26824b97ce941bf54", BE:"0x822cc93ffd030293e9842c30bbd678f530701867",
  COIN:"0x6330d8c3178a418788df01a47479c0ce7ccf450b", CRWV:"0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3",
  GOOGL:"0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", INTC:"0xc72b96e0e48ecd4dc75e1e45396e26300bc39681",
  META:"0xc0d6457c16cc70d6790dd43521c899c87ce02f35", MSFT:"0xe93237c50d904957cf27e7b1133b510c669c2e74",
  MU:"0xff080c8ce2e5feadaca0da81314ae59d232d4afd", NVDA:"0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  ORCL:"0xb0992820e760d836549ba69bc7598b4af75dee03", PLTR:"0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
  SNDK:"0xb90a19ff0af67f7779aff50a882a9cff42446400", SPCX:"0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
  TSLA:"0x322f0929c4625ed5bad873c95208d54e1c003b2d", USAR:"0xd917b029c761d264c6a312bbbcda868658ef86a6",
};
const TIERS = [[500,10],[3000,60],[10000,200]]; // 0.05% / 0.3% / 1%
const DEPLOYED = new Set(["AAPL","GOOGL","META","NVDA","TSLA"]);

const idFor = (a,b,fee,ts)=>{const[c0,c1]=a.toLowerCase()<b.toLowerCase()?[a,b]:[b,a];
  return keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"),[c0,c1,fee,ts,NATIVE]));};
const slot0Abi=[parseAbiItem("function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)")];
const liqAbi=[parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];

// USDG (6dp) depth to move price ~2%, from in-range liquidity. USDG is one side;
// depth ≈ L * |1/sqrtP - 1/(sqrtP*sqrt(1.02))| or L*|sqrtP*sqrt(1.02)-sqrtP|
// depending on which currency USDG is. Reported in USDG (~$).
// sqrtP passed in is already sqrtPriceX96/Q96 (plain ratio of raw units).
// Δtoken0_raw = L*(1/sqrtPa - 1/sqrtPb); Δtoken1_raw = L*(sqrtPb - sqrtPa).
// USDG is 6dp, so /1e6 to dollars.
function depthUsd(L, sqrtP, usdgIs0){
  const f=Math.sqrt(1.02);
  const draw = usdgIs0 ? L*(1/sqrtP - 1/(sqrtP*f)) : L*(sqrtP*f - sqrtP);
  return Math.abs(draw)/1e6;
}

const rows=[];
for(const[sym,tok]of Object.entries(TOKENS)){
  for(const[fee,ts]of TIERS){
    const id=idFor(tok,USDG,fee,ts);
    try{
      const[sp]=await client.readContract({address:SV,abi:slot0Abi,functionName:"getSlot0",args:[id]});
      if(BigInt(sp)===0n) continue; // not initialized
      const L=Number(await client.readContract({address:SV,abi:liqAbi,functionName:"getLiquidity",args:[id]}));
      if(L===0) continue;
      const sqrtP=Number(sp)/Q96, usdgIs0=USDG.toLowerCase()<tok.toLowerCase();
      rows.push({sym,tier:`${fee/10000}%`,depth:depthUsd(L,sqrtP,usdgIs0),deployed:DEPLOYED.has(sym)});
    }catch{}
  }
}
rows.sort((a,b)=>b.depth-a.depth);
console.log(`Robinhood Chain · USDG stock pools with live liquidity (${rows.length} found)\n`);
console.log("  SYMBOL  TIER    ~DEPTH(2%)   STATUS");
for(const r of rows){
  const flag = r.deployed ? "deployed" : (r.depth>1500 ? "  ← TAPPABLE (not deployed)" : "thin");
  console.log(`  ${r.sym.padEnd(7)} ${r.tier.padEnd(6)} $${r.depth.toFixed(0).padStart(8)}   ${flag}`);
}
const tappable = rows.filter(r=>!r.deployed && r.depth>1500);
console.log(`\nDeployed into: 5.  New pools clearing a ~$1.5k depth bar: ${tappable.length} (${tappable.map(r=>r.sym+" "+r.tier).join(", ")||"none"})`);
console.log(`Total live USDG stock-pool depth across the chain: ~$${rows.reduce((s,r)=>s+r.depth,0).toFixed(0)}`);
