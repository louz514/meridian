// Phase 0 · step 7 — prove REVOCATION. The Safe owner disables the Roles
// module; afterward the same session key can no longer make the Safe do
// anything, not even call the previously-allowed router. Proves the user can
// pull the plug at will. Dry-run unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const ZERO = "0x0000000000000000000000000000000000000000";
const SENTINEL = "0x0000000000000000000000000000000000000001"; // Safe module linked-list head
const EXPECTED_OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");

const state = JSON.parse(readFileSync("_sk-state.json", "utf8"));
const SAFE = getAddress(state.safe);
const ROLES = getAddress(state.rolesModule);
const ROUTER = getAddress(state.allowedTarget);
const ROLE_KEY = state.roleKey;

const owner = privateKeyToAccount((process.env.AGENT_SIGNER_PRIVATE_KEY.startsWith("0x") ? "" : "0x") + process.env.AGENT_SIGNER_PRIVATE_KEY);
if (getAddress(owner.address) !== EXPECTED_OWNER) { console.error("wrong owner key"); process.exit(1); }
const session = privateKeyToAccount(process.env.SPIKE_SESSION_KEY);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });

const safeAbi = [
  parseAbiItem("function disableModule(address prevModule, address module)"),
  parseAbiItem("function isModuleEnabled(address module) view returns (bool)"),
  parseAbiItem("function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)"),
];
const execAbi = [parseAbiItem("function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)")];

// baseline: session key IS authorized on the router right now
const before = await pub.simulateContract({ account: session, address: ROLES, abi: execAbi, functionName: "execTransactionWithRole", args: [ROUTER, 0n, "0x12345678", 0, ROLE_KEY, false] }).then(() => true).catch(() => false);
console.log(`before revocation: session key authorized on router? ${before ? "yes ✓ (as expected)" : "no (unexpected)"}`);

const inner = encodeFunctionData({ abi: safeAbi, functionName: "disableModule", args: [SENTINEL, ROLES] });
const sig = "0x" + "000000000000000000000000" + EXPECTED_OWNER.slice(2).toLowerCase() + "0".repeat(64) + "01";

if (process.env.EXECUTE !== "1") {
  await pub.simulateContract({ account: owner, address: SAFE, abi: safeAbi, functionName: "execTransaction", args: [SAFE, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
  console.log("\nDRY RUN ok (disableModule simulates). Re-run with EXECUTE=1.");
  process.exit(0);
}

console.log("\nowner disabling the Roles module…");
const hash = await wallet.writeContract({ address: SAFE, abi: safeAbi, functionName: "execTransaction", args: [SAFE, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, sig] });
console.log(`  tx: ${hash}`);
if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") { console.error("REVERTED"); process.exit(1); }

const stillEnabled = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: "isModuleEnabled", args: [ROLES] });
const after = await pub.simulateContract({ account: session, address: ROLES, abi: execAbi, functionName: "execTransactionWithRole", args: [ROUTER, 0n, "0x12345678", 0, ROLE_KEY, false] }).then(() => true).catch(() => false);

console.log(`\nafter revocation:`);
console.log(`  isModuleEnabled(roles) = ${stillEnabled}  ${stillEnabled ? "✗ still on" : "✓ disabled"}`);
console.log(`  session key can still act on router? ${after ? "✗ YES (bad)" : "✓ NO — fully neutralized"}`);
console.log(`\n${!stillEnabled && !after ? "✓ REVOCATION WORKS — one owner tx and the session key is dead." : "✗ review above"}`);
writeFileSync("_sk-state.json", JSON.stringify({ ...state, revoked: true, revokeTx: hash }, null, 2));
