// Phase 0 · step 1 — deploy a Safe (1.3.0) owned solely by the funder wallet.
// This is the account that will HOLD funds; the owner (this EOA) keeps sole
// withdrawal control. Later steps attach a Zodiac Roles module and a scoped
// session key. Dry-run by default; pass EXECUTE=1 to actually deploy.
//
//   node _sk-1-deploy-safe.mjs           # dry run: predicts address, checks funds
//   EXECUTE=1 node _sk-1-deploy-safe.mjs # sends the deploy tx
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbiItem, getAddress, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const STATE = "_sk-state.json";

// Safe 1.3.0 core (all confirmed live on Robinhood Chain)
const FACTORY = getAddress("0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"); // SafeProxyFactory 1.3.0
const SINGLETON = getAddress("0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552"); // GnosisSafe 1.3.0
const FALLBACK = getAddress("0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4"); // CompatibilityFallbackHandler 1.3.0
const ZERO = "0x0000000000000000000000000000000000000000";
const EXPECTED_OWNER = getAddress("0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c"); // house wallet — safety guard

const key = process.env.AGENT_SIGNER_PRIVATE_KEY;
if (!key) { console.error("AGENT_SIGNER_PRIVATE_KEY not set"); process.exit(1); }
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
if (getAddress(account.address) !== EXPECTED_OWNER) {
  console.error(`refusing to run: key resolves to ${account.address}, expected ${EXPECTED_OWNER}`);
  process.exit(1);
}

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

const factoryAbi = [parseAbiItem("function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)")];
const safeAbi = [parseAbiItem("function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)")];
const proxyCreation = parseAbiItem("event ProxyCreation(address proxy, address singleton)");

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
if (state.safe) { console.log(`Safe already recorded: ${state.safe} — step 1 done. Nothing to do.`); process.exit(0); }

// Deterministic-ish salt, recorded so the deployed address is reproducible.
const saltNonce = state.saltNonce ?? BigInt(Date.now());
const initializer = encodeFunctionData({
  abi: safeAbi,
  functionName: "setup",
  args: [[EXPECTED_OWNER], 1n, ZERO, "0x", FALLBACK, ZERO, 0n, ZERO],
});

const bal = await pub.getBalance({ address: account.address });
console.log(`owner (house):  ${account.address}`);
console.log(`owner ETH:      ${Number(bal) / 1e18}`);
console.log(`singleton:      ${SINGLETON} (Safe 1.3.0, threshold 1, sole owner = house)`);
console.log(`saltNonce:      ${saltNonce}`);

// Predict the proxy address by simulating the factory call (no state change).
let predicted;
try {
  const sim = await pub.simulateContract({ account, address: FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SINGLETON, initializer, saltNonce] });
  predicted = getAddress(sim.result);
  console.log(`predicted Safe: ${predicted}`);
} catch (e) {
  console.error("simulation failed:", e.shortMessage ?? e.message); process.exit(1);
}

if (process.env.EXECUTE !== "1") {
  console.log("\nDRY RUN ok. Re-run with EXECUTE=1 to deploy.");
  writeFileSync(STATE, JSON.stringify({ ...state, saltNonce: saltNonce.toString(), predictedSafe: predicted }, null, 2));
  process.exit(0);
}

console.log("\ndeploying…");
const hash = await wallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SINGLETON, initializer, saltNonce] });
console.log(`tx: ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") { console.error("deploy REVERTED"); process.exit(1); }

// Confirm from the ProxyCreation event, then verify code exists.
let safe = predicted;
for (const log of rcpt.logs) {
  try { const d = decodeEventLog({ abi: [proxyCreation], data: log.data, topics: log.topics }); if (d.args?.proxy) safe = getAddress(d.args.proxy); } catch {}
}
const code = await pub.getCode({ address: safe });
if (!code || code === "0x") { console.error(`no code at ${safe} — deploy did not land as expected`); process.exit(1); }

writeFileSync(STATE, JSON.stringify({ ...state, owner: account.address, safe, saltNonce: saltNonce.toString(), deployTx: hash }, null, 2));
console.log(`\n✓ Safe deployed: ${safe}  (${(code.length - 2) / 2} bytes)`);
console.log(`  explorer: https://robinhoodchain.blockscout.com/address/${safe}`);
console.log(`  state written to ${STATE}`);
