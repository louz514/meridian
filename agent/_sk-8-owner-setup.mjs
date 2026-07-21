// Phase 0 · step 8 — owner setup for the live-swap proof. Re-enables the Roles
// module (revoked in step 7) and sets the Safe's swap approvals (USDG->Permit2,
// Permit2->router). These are OWNER actions: the session key is scoped to the
// router only and provably CANNOT approve tokens — which is the point. Dry-run
// unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const ZERO = "0x0000000000000000000000000000000000000000";
const OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const ROUTER = getAddress("0x8876789976dEcBfCbBbe364623C63652db8C0904");
const MAX256 = (1n << 256n) - 1n, MAX160 = (1n << 160n) - 1n;

const state = JSON.parse(readFileSync("_sk-state.json", "utf8"));
const SAFE = getAddress(state.safe), ROLES = getAddress(state.rolesModule);

const owner = privateKeyToAccount((process.env.AGENT_SIGNER_PRIVATE_KEY.startsWith("0x") ? "" : "0x") + process.env.AGENT_SIGNER_PRIVATE_KEY);
if (getAddress(owner.address) !== OWNER) { console.error("wrong owner key"); process.exit(1); }

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });

const safeAbi = [
  parseAbiItem("function enableModule(address module)"),
  parseAbiItem("function isModuleEnabled(address module) view returns (bool)"),
  parseAbiItem("function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)"),
];
const erc20 = [parseAbiItem("function approve(address spender, uint256 amount) returns (bool)")];
const permit2 = [parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)")];
const sig = "0x" + "000000000000000000000000" + OWNER.slice(2).toLowerCase() + "0".repeat(64) + "01";

// A Safe transaction (owner-signed, pre-validated) that calls `to` with `data`.
async function safeExec(label, to, data) {
  console.log(`  ${label}…`);
  const hash = await wallet.writeContract({ address: SAFE, abi: safeAbi, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`    ✓ ${hash}`);
}

const enabled = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: "isModuleEnabled", args: [ROLES] });
console.log(`module enabled now? ${enabled}`);

if (process.env.EXECUTE !== "1") {
  // sanity: the enableModule Safe tx simulates
  const inner = encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ROLES] });
  if (!enabled) await pub.simulateContract({ account: owner, address: SAFE, abi: safeAbi, functionName: "execTransaction", args: [SAFE, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
  console.log("\nDRY RUN ok. Re-run with EXECUTE=1 to (re-)enable + approve.");
  process.exit(0);
}

if (!enabled) await safeExec("re-enable module", SAFE, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ROLES] }));
const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
await safeExec("Safe approves USDG -> Permit2", USDG, encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, MAX256] }));
await safeExec("Safe approves Permit2 -> router", PERMIT2, encodeFunctionData({ abi: permit2, functionName: "approve", args: [USDG, ROUTER, MAX160, exp] }));

console.log("\n✓ owner setup complete: module enabled, Safe approvals set. Ready for the session-key swap.");
writeFileSync("_sk-state.json", JSON.stringify({ ...state, ownerSetup: true }, null, 2));
