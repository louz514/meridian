// Phase 0 · step 2 — clone a Zodiac Roles v2.1 module for the Safe, via the
// Module Proxy Factory. owner = house EOA (so the spike can configure scopes
// directly; in production this would be the user's Safe/EOA). avatar & target
// = the Safe, i.e. the module acts ON the Safe's behalf. Dry-run unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbiItem, getAddress, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const STATE = "_sk-state.json";

const MPF = getAddress("0x000000000000aDdB49795b0f9bA5BC298cDda236");         // Zodiac Module Proxy Factory
const ROLES_MASTERCOPY = getAddress("0x9646fDAD06d3e24444381f44362a3B0eB343D337"); // Roles 2.1.0
const EXPECTED_OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c");

if (!existsSync(STATE)) { console.error("no _sk-state.json — run step 1 first"); process.exit(1); }
const state = JSON.parse(readFileSync(STATE, "utf8"));
if (!state.safe) { console.error("no safe in state — run step 1 first"); process.exit(1); }
if (state.rolesModule) { console.log(`Roles module already recorded: ${state.rolesModule} — step 2 done.`); process.exit(0); }
const SAFE = getAddress(state.safe);

const key = process.env.AGENT_SIGNER_PRIVATE_KEY;
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
if (getAddress(account.address) !== EXPECTED_OWNER) { console.error(`wrong key: ${account.address}`); process.exit(1); }

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

const setUpAbi = [parseAbiItem("function setUp(bytes initParams)")];
const mpfAbi = [parseAbiItem("function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address)")];
const creation = parseAbiItem("event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)");

// setUp(abi.encode(owner, avatar, target))
const initParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [EXPECTED_OWNER, SAFE, SAFE]);
const initializer = encodeFunctionData({ abi: setUpAbi, functionName: "setUp", args: [initParams] });
const saltNonce = state.rolesSalt ? BigInt(state.rolesSalt) : BigInt(Date.now());

console.log(`Safe (avatar/target): ${SAFE}`);
console.log(`Roles owner (house):  ${EXPECTED_OWNER}`);
console.log(`mastercopy:           ${ROLES_MASTERCOPY}`);
console.log(`saltNonce:            ${saltNonce}`);

let predicted;
try {
  const sim = await pub.simulateContract({ account, address: MPF, abi: mpfAbi, functionName: "deployModule", args: [ROLES_MASTERCOPY, initializer, saltNonce] });
  predicted = getAddress(sim.result);
  console.log(`predicted module:     ${predicted}`);
} catch (e) { console.error("simulation failed:", e.shortMessage ?? e.message); process.exit(1); }

if (process.env.EXECUTE !== "1") {
  writeFileSync(STATE, JSON.stringify({ ...state, rolesSalt: saltNonce.toString(), predictedRoles: predicted }, null, 2));
  console.log("\nDRY RUN ok. Re-run with EXECUTE=1 to deploy the module.");
  process.exit(0);
}

console.log("\ndeploying Roles module…");
const hash = await wallet.writeContract({ address: MPF, abi: mpfAbi, functionName: "deployModule", args: [ROLES_MASTERCOPY, initializer, saltNonce] });
console.log(`tx: ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") { console.error("REVERTED"); process.exit(1); }

let mod = predicted;
for (const log of rcpt.logs) { try { const d = decodeEventLog({ abi: [creation], data: log.data, topics: log.topics }); if (d.args?.proxy) mod = getAddress(d.args.proxy); } catch {} }

// verify the module's wiring
const read = (fn) => pub.readContract({ address: mod, abi: [parseAbiItem(`function ${fn}() view returns (address)`)], functionName: fn.split("(")[0] });
const [owner, avatar, target] = await Promise.all([read("owner"), read("avatar"), read("target")]);
console.log(`\n✓ Roles module: ${mod}`);
console.log(`  owner:  ${owner}  ${getAddress(owner) === EXPECTED_OWNER ? "✓ house" : "✗"}`);
console.log(`  avatar: ${avatar}  ${getAddress(avatar) === SAFE ? "✓ Safe" : "✗"}`);
console.log(`  target: ${target}  ${getAddress(target) === SAFE ? "✓ Safe" : "✗"}`);
console.log(`  explorer: https://robinhoodchain.blockscout.com/address/${mod}`);

writeFileSync(STATE, JSON.stringify({ ...state, rolesModule: mod, rolesSalt: saltNonce.toString(), rolesTx: hash }, null, 2));
