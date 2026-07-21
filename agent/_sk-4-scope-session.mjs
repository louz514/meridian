// Phase 0 · step 4 — grant a session key a role and scope it to the swap
// router ONLY. After this the session key can make the Safe call the
// UniversalRouter, and NOTHING else — no token transfers, no owner changes, no
// withdrawals. Owner (house) calls assignRoles + allowTarget directly.
import { createPublicClient, createWalletClient, http, parseAbiItem, getAddress, stringToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const STATE = "_sk-state.json";
const EXPECTED_OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");
const UNIVERSAL_ROUTER = getAddress("0x8876789976dEcBfCbBbe364623C63652db8C0904"); // the ONLY allowed target
const ROLE_KEY = stringToHex("mrd-trade", { size: 32 });
const SEND = 1; // ExecutionOptions.Send

const state = JSON.parse(readFileSync(STATE, "utf8"));
const ROLES = getAddress(state.rolesModule);

const account = privateKeyToAccount((process.env.AGENT_SIGNER_PRIVATE_KEY.startsWith("0x") ? "" : "0x") + process.env.AGENT_SIGNER_PRIVATE_KEY);
if (getAddress(account.address) !== EXPECTED_OWNER) { console.error("wrong key"); process.exit(1); }

// Session key: reuse if present in env, else mint one and store in .env (gitignored).
let sessionPk = process.env.SPIKE_SESSION_KEY;
if (!sessionPk) {
  sessionPk = generatePrivateKey();
  appendFileSync(".env", `\n# throwaway session key for the custody spike (holds no funds, scope-limited)\nSPIKE_SESSION_KEY=${sessionPk}\n`);
  console.log("minted a new session key -> appended SPIKE_SESSION_KEY to .env");
}
const session = privateKeyToAccount(sessionPk);
console.log(`session key address: ${session.address}  (holds no funds; scope is its only power)`);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

const rolesAbi = [
  parseAbiItem("function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)"),
  parseAbiItem("function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)"),
];

console.log(`roleKey: ${ROLE_KEY}`);
console.log(`scope:   allowTarget(${UNIVERSAL_ROUTER})  [ExecutionOptions.Send]  <- the ONLY target`);

if (process.env.EXECUTE !== "1") {
  await pub.simulateContract({ account, address: ROLES, abi: rolesAbi, functionName: "assignRoles", args: [session.address, [ROLE_KEY], [true]] });
  console.log("\nDRY RUN ok (assignRoles simulates). Re-run with EXECUTE=1.");
  process.exit(0);
}

console.log("\nassignRoles(sessionKey)…");
let h = await wallet.writeContract({ address: ROLES, abi: rolesAbi, functionName: "assignRoles", args: [session.address, [ROLE_KEY], [true]] });
if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") { console.error("assignRoles REVERTED"); process.exit(1); }
console.log(`  tx: ${h}`);

console.log("allowTarget(UniversalRouter)…");
h = await wallet.writeContract({ address: ROLES, abi: rolesAbi, functionName: "allowTarget", args: [ROLE_KEY, UNIVERSAL_ROUTER, SEND] });
if ((await pub.waitForTransactionReceipt({ hash: h })).status !== "success") { console.error("allowTarget REVERTED"); process.exit(1); }
console.log(`  tx: ${h}`);

writeFileSync(STATE, JSON.stringify({ ...state, sessionKey: session.address, roleKey: ROLE_KEY, allowedTarget: UNIVERSAL_ROUTER, scopeTx: h }, null, 2));
console.log(`\n✓ session key ${session.address} scoped to the router only. State updated.`);
