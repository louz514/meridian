// Phase 0 readiness for the custody unlock (session-key trading on a per-user
// Safe, scoped by a Zodiac Roles module). READ-ONLY: this confirms every
// contract the design depends on is live on Robinhood Chain and prints the
// exact scope the session key will get. It signs nothing and spends nothing.
//
// The actual Phase 0 proof (deploy Safe -> enable Roles -> scope session key ->
// execute ONE allowed swap -> prove a withdrawal REVERTS -> revoke) is done
// step-by-step against a throwaway funded wallet, each step's tx verified on
// Blockscout before the next. Run: node _sessionkey-spike.mjs
import { createPublicClient, http, getAddress } from "viem";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(RPC, { retryCount: 4, retryDelay: 300 }) });

// --- the stack the design depends on (all probed live 2026-07) ---------------
const INFRA = {
  "EntryPoint v0.7 (ERC-4337)":     "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "Safe Singleton 1.4.1":           "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  "SafeProxyFactory 1.4.1":         "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  "Safe Singleton 1.3.0":           "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
  "SafeProxyFactory 1.3.0":         "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
  "CompatFallbackHandler 1.3":      "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
  "MultiSendCallOnly 1.3":          "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  "Zodiac Module Proxy Factory":    "0x000000000000aDdB49795b0f9bA5BC298cDda236",
  "Safe Singleton Factory (CREATE2)":"0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
  "Arachnid CREATE2 proxy":         "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  "Permit2":                        "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  // Zodiac Roles v2.1.0 core — confirmed live on Robinhood Chain 2026-07.
  // Source of truth: gnosisguild/zodiac-modifier-roles mastercopies.json
  // (deterministic, identical address on every chain). The Module Proxy Factory
  // clones the Roles mastercopy per-Safe; Integrity + Packer are its mandatory
  // linked libraries. No deploy needed.
  "Roles 2.1.0 mastercopy":         "0x9646fDAD06d3e24444381f44362a3B0eB343D337",
  "Roles Integrity lib 2.1.0":      "0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049",
  "Roles Packer lib 2.1.0":         "0x61C5B1bE435391fDd7BC6703F3740C0d11728a8C",
};

// --- the contracts the session key will be SCOPED TO (from the codebase) ------
// These are the ONLY targets the Roles module will allow the session key to
// call; everything else (token transfers, Safe owner changes, withdrawals)
// stays impossible for the session key.
const SCOPE_TARGETS = {
  "UniversalRouter (stock swaps)":  "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  "indexUniversalRouter ($INDEX)":  "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77",
  "v4 PositionManager (LP)":        "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  "USDG (approve-only, to Permit2)":"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

// The Roles v2.1.0 mastercopy the Module Proxy Factory clones per-Safe.
// Resolved and confirmed live on Robinhood Chain (see INFRA above) — no deploy
// needed. Overridable via env only if a future version is preferred.
const ROLES_MASTERCOPY = (process.env.ROLES_MASTERCOPY || "0x9646fDAD06d3e24444381f44362a3B0eB343D337").trim();

async function isDeployed(addr) {
  try {
    const code = await client.getCode({ address: getAddress(addr) });
    return code && code !== "0x" ? (code.length - 2) / 2 : 0;
  } catch { return -1; }
}

async function report(title, map) {
  console.log(`\n== ${title} ==`);
  let allOk = true;
  for (const [name, addr] of Object.entries(map)) {
    const bytes = await isDeployed(addr);
    const mark = bytes > 0 ? `ok (${bytes}b)` : bytes === 0 ? "ABSENT" : "rpc-error";
    if (bytes <= 0) allOk = false;
    console.log(`  ${name.padEnd(34)} ${addr}  ${mark}`);
  }
  return allOk;
}

console.log(`Robinhood Chain custody-unlock readiness — chainId ${await client.getChainId()}`);
const a = await report("Account + module infrastructure", INFRA);
const b = await report("Scope targets (session key may call ONLY these)", SCOPE_TARGETS);

const rolesBytes = await isDeployed(ROLES_MASTERCOPY);
console.log("\n== Zodiac Roles v2.1.0 mastercopy ==");
console.log(`  ${ROLES_MASTERCOPY}  ${rolesBytes > 0 ? `ok (${rolesBytes}b)` : "ABSENT — deploy via Safe Singleton Factory"}`);

console.log("\n== verdict ==");
console.log(a && b && rolesBytes > 0
  ? "READY. Every contract the design depends on is live on Robinhood Chain — nothing to deploy. Clear to run the on-chain spike on a throwaway funded wallet."
  : "Something is missing above — resolve before proceeding.");
console.log(`
Phase 0 on-chain sequence (each step = one verified tx on a throwaway wallet):
  1. deploy a Safe (owner = test EOA, threshold 1)               [SafeProxyFactory]
  2. clone a Roles module (owner/avatar/target = the Safe)       [Zodiac MPF]
  3. Safe.enableModule(roles)                                    [Safe owner tx]
  4. roles.assignRoles(sessionKey, [ROLE], [true])
     roles.scopeTarget(ROLE, UniversalRouter) + allowFunction    [scope to swaps only]
  5. fund the Safe with a few $ of USDG                          [user tx]
  6. roles.execTransactionWithRole(router, swapData, ROLE)  -> EXPECT SUCCESS  (key can trade)
  7. roles.execTransactionWithRole(USDG, transfer(attacker), ROLE) -> EXPECT REVERT (key cannot withdraw)
  8. Safe.disableModule(roles)                             -> EXPECT SUCCESS  (revocation works)
`);
process.exit(0);
