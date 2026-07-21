// Phase 0 · step 3 — Safe.enableModule(rolesModule). Without this the Roles
// module cannot execute on the Safe. Uses a Safe execTransaction signed with a
// pre-validated signature (valid because the sole owner == msg.sender). Dry-run
// unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const STATE = "_sk-state.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const EXPECTED_OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");

const state = JSON.parse(readFileSync(STATE, "utf8"));
const SAFE = getAddress(state.safe);
const ROLES = getAddress(state.rolesModule);

const account = privateKeyToAccount((process.env.AGENT_SIGNER_PRIVATE_KEY.startsWith("0x") ? "" : "0x") + process.env.AGENT_SIGNER_PRIVATE_KEY);
if (getAddress(account.address) !== EXPECTED_OWNER) { console.error("wrong key"); process.exit(1); }

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

const safeAbi = [
  parseAbiItem("function enableModule(address module)"),
  parseAbiItem("function isModuleEnabled(address module) view returns (bool)"),
  parseAbiItem("function nonce() view returns (uint256)"),
  parseAbiItem("function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)"),
];

if (await pub.readContract({ address: SAFE, abi: safeAbi, functionName: "isModuleEnabled", args: [ROLES] })) {
  console.log(`module already enabled on the Safe — step 3 done.`);
  writeFileSync(STATE, JSON.stringify({ ...state, moduleEnabled: true }, null, 2));
  process.exit(0);
}

const inner = encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ROLES] });
// pre-validated signature: r = owner (left-padded 32B), s = 0 (32B), v = 01
const sig = ("0x" + "000000000000000000000000" + EXPECTED_OWNER.slice(2).toLowerCase() + "0".repeat(64) + "01");

console.log(`Safe:          ${SAFE}`);
console.log(`Roles module:  ${ROLES}`);
console.log(`enableModule via Safe.execTransaction (self-call), pre-validated sig`);

try {
  await pub.simulateContract({ account, address: SAFE, abi: safeAbi, functionName: "execTransaction",
    args: [SAFE, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
  console.log("simulation ok");
} catch (e) { console.error("simulation failed:", e.shortMessage ?? e.message); process.exit(1); }

if (process.env.EXECUTE !== "1") { console.log("\nDRY RUN ok. Re-run with EXECUTE=1."); process.exit(0); }

const hash = await wallet.writeContract({ address: SAFE, abi: safeAbi, functionName: "execTransaction",
  args: [SAFE, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
console.log(`tx: ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") { console.error("REVERTED"); process.exit(1); }

const enabled = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: "isModuleEnabled", args: [ROLES] });
console.log(`\n✓ isModuleEnabled(roles) = ${enabled}`);
if (!enabled) { console.error("module NOT enabled despite success — investigate"); process.exit(1); }
writeFileSync(STATE, JSON.stringify({ ...state, moduleEnabled: true, enableTx: hash }, null, 2));
console.log(`  explorer: https://robinhoodchain.blockscout.com/tx/${hash}`);
