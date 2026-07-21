// Phase 0 · step 9 — POSITIVE proof: the session key executes a REAL swap of
// the Safe's funds through the router (USDG -> ETH), output back to the Safe.
// The key can trade, and (from steps 5/7) can do nothing else. Reuses the
// codebase's own swap encoder. Dry-run unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { buildSwapExactInCalldata, hopRate, USDG, UNIVERSAL_ROUTER } from "./src/venues/stockPools.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");

const state = JSON.parse(readFileSync("_sk-state.json", "utf8"));
const SAFE = getAddress(state.safe), ROLES = getAddress(state.rolesModule), ROLE_KEY = state.roleKey as `0x${string}`;

const owner = privateKeyToAccount(((process.env.AGENT_SIGNER_PRIVATE_KEY!.startsWith("0x") ? "" : "0x") + process.env.AGENT_SIGNER_PRIVATE_KEY) as `0x${string}`);
const session = privateKeyToAccount(process.env.SPIKE_SESSION_KEY as `0x${string}`);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const ownerW = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });
const sessionW = createWalletClient({ account: session, chain: CHAIN, transport: http(RPC) });

const bal = (t: `0x${string}`, who: `0x${string}`) => t === NATIVE
  ? pub.getBalance({ address: who })
  : pub.readContract({ address: t, abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")], functionName: "balanceOf", args: [who] });

const execAbi = [parseAbiItem("function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)")];

// Build a USDG -> ETH swap of 5 USDG, output to the Safe. 2% slippage floor.
const amountIn = 5_000000n; // 5 USDG (6 decimals)
const route = [{ outputCurrency: NATIVE, fee: 500, tickSpacing: 10 }];
const rate = await hopRate(USDG as `0x${string}`, route[0] as any);
const minOut = BigInt(Math.floor(Number(amountIn) * rate * 0.98));
const swap = buildSwapExactInCalldata({ currencyIn: USDG as `0x${string}`, route: route as any, amountIn, amountOutMinimum: minOut, recipient: SAFE });

const [safeUsdg0, safeEth0, sessEth] = await Promise.all([bal(USDG as `0x${string}`, SAFE), bal(NATIVE, SAFE), bal(NATIVE, session.address)]);
console.log(`Safe before:  ${Number(safeUsdg0) / 1e6} USDG,  ${Number(safeEth0) / 1e18} ETH`);
console.log(`session gas:  ${Number(sessEth) / 1e18} ETH  (${session.address})`);
console.log(`swap:         5 USDG -> ETH, minOut ${Number(minOut) / 1e18} ETH, output to Safe`);

if (process.env.EXECUTE !== "1") {
  console.log("\nDRY RUN — re-run with EXECUTE=1 to fund gas + execute the session-key swap.");
  process.exit(0);
}

// Fund the session key with a little gas if it's short.
if (sessEth < 300000000000000n) {
  console.log("\nfunding session key gas (0.0005 ETH)…");
  const h = await ownerW.sendTransaction({ to: session.address, value: 500000000000000n });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  ✓ ${h}`);
}

console.log("\nsession key executing the swap via the Roles module…");
const hash = await sessionW.writeContract({ address: ROLES, abi: execAbi, functionName: "execTransactionWithRole", args: [swap.to, 0n, swap.data, 0, ROLE_KEY, true] });
console.log(`  tx: ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") { console.error("  SWAP REVERTED"); process.exit(1); }

const [safeUsdg1, safeEth1] = await Promise.all([bal(USDG as `0x${string}`, SAFE), bal(NATIVE, SAFE)]);
console.log(`\nSafe after:   ${Number(safeUsdg1) / 1e6} USDG,  ${Number(safeEth1) / 1e18} ETH`);
const usdgSpent = Number(safeUsdg0 - safeUsdg1) / 1e6, ethGained = Number(safeEth1 - safeEth0) / 1e18;
console.log(`delta:        -${usdgSpent.toFixed(6)} USDG,  +${ethGained.toFixed(8)} ETH`);
console.log(`\n${usdgSpent > 0 && ethGained > 0 ? "✓ LIVE TRADE — the session key moved the Safe's funds through the router, output to the Safe." : "✗ balances didn't change as expected — review"}`);
console.log(`  explorer: https://robinhoodchain.blockscout.com/tx/${hash}`);
