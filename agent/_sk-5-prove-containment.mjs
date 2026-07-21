// Phase 0 · step 5 — prove the scope CONTAINS the session key. Each case is an
// eth_call from the session key through the Roles module: the full on-chain
// authorization logic runs, so a revert here is a revert for real. No gas, no
// funds. One allowed action (must pass) + three attacks (must all revert).
import { createPublicClient, http, encodeFunctionData, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };

const state = JSON.parse(readFileSync("_sk-state.json", "utf8"));
const ROLES = getAddress(state.rolesModule);
const SAFE = getAddress(state.safe);
const ROUTER = getAddress(state.allowedTarget);
const ROLE_KEY = state.roleKey;
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const ATTACKER = getAddress("0x00000000000000000000000000000000DeaDBeef");

const session = privateKeyToAccount(process.env.SPIKE_SESSION_KEY);
if (getAddress(session.address) !== getAddress(state.sessionKey)) { console.error("session key mismatch"); process.exit(1); }

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });
const execAbi = [parseAbiItem("function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)")];
const erc20 = [parseAbiItem("function transfer(address to, uint256 amount) returns (bool)")];
const safeAbi = [parseAbiItem("function addOwnerWithThreshold(address owner, uint256 _threshold)")];

// Try an execTransactionWithRole via eth_call from the session key.
async function attempt(label, to, value, data, shouldRevert) {
  try {
    await pub.simulateContract({ account: session, address: ROLES, abi: execAbi,
      functionName: "execTransactionWithRole", args: [to, value, data, 0, ROLE_KEY, shouldRevert] });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e.shortMessage ?? e.message ?? "").split("\n")[0] };
  }
}

console.log(`session key: ${session.address}`);
console.log(`Safe:        ${SAFE}`);
console.log(`allowed:     ${ROUTER} (UniversalRouter) only\n`);

// Positive control: a call to the ALLOWED router must pass authorization.
// shouldRevert=false so an inner execution failure doesn't mask the auth result.
const allowed = await attempt("router", ROUTER, 0n, "0x12345678", false);
console.log(`[allowed]  call UniversalRouter        -> ${allowed.ok ? "AUTHORIZED ✓ (scope permits the router)" : "unexpectedly blocked: " + allowed.why}`);

// Attack 1: move the Safe's USDG to an attacker.
const a1 = await attempt("steal-usdg", USDG, 0n, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 1n] }), true);
console.log(`[attack 1] transfer USDG to attacker   -> ${a1.ok ? "LEAKED ✗✗✗" : "REVERTED ✓ (USDG is not an allowed target)"}`);

// Attack 2: take over the Safe by adding the attacker as an owner.
const a2 = await attempt("take-over", SAFE, 0n, encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [ATTACKER, 1n] }), true);
console.log(`[attack 2] add attacker as Safe owner  -> ${a2.ok ? "LEAKED ✗✗✗" : "REVERTED ✓ (Safe self-calls not allowed)"}`);

// Attack 3: drain the Safe's ETH to an attacker.
const a3 = await attempt("drain-eth", ATTACKER, 1n, "0x", true);
console.log(`[attack 3] send Safe ETH to attacker   -> ${a3.ok ? "LEAKED ✗✗✗" : "REVERTED ✓ (attacker is not an allowed target)"}`);

const contained = !a1.ok && !a2.ok && !a3.ok && allowed.ok;
console.log(`\n${contained ? "✓ CONTAINED — the session key can reach the router and NOTHING else." : "✗ PROBLEM — review above."}`);
