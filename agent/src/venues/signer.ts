import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/** Robinhood Chain — an Arbitrum L2 (chain id 4663), not in viem's built-in list. */
export const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.robinhoodRpcUrl || "https://rpc.mainnet.chain.robinhood.com"] } },
  // Multicall3 at the canonical address (verified deployed on this chain).
  // Declaring it lets viem's batch.multicall collapse dozens of concurrent
  // reads into a single eth_call. Without it every readContract was a separate
  // call, and under prod's polling load the public RPC 429s the oversized batch
  // with a NON-array error body that viem surfaces as the cryptic
  // "Cannot read properties of undefined (reading 'error')".
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" as const } },
} as const;

/**
 * The agent's own signing wallet — reads a private key from
 * AGENT_SIGNER_PRIVATE_KEY, never accepted as a request parameter. This is
 * what lets the background loop execute enter_index/exit_index decisions
 * with no human supplying a payer wallet per trade (see agentLoop.ts). Absent
 * this env var, autonomous execution can't run — IndexTrader falls back to
 * its stub (logs intent, doesn't touch the chain), same as with no RPC set.
 */
let cached: { account: ReturnType<typeof privateKeyToAccount>; address: Address } | null = null;

export function getAgentSigner() {
  const key = process.env.AGENT_SIGNER_PRIVATE_KEY;
  if (!key) return null;
  if (!cached) {
    const account = privateKeyToAccount(key as `0x${string}`);
    cached = { account, address: account.address };
  }
  return cached;
}

/**
 * The wallet address for READ paths (portfolio, console, valuations).
 * Read-only deployments (the public cloud instance) carry no private key —
 * they set MERIDIAN_WALLET_ADDRESS instead, so every balance/position read
 * works while nothing on the box can sign.
 */
export function getAgentAddress(): `0x${string}` | null {
  const signer = getAgentSigner();
  if (signer) return signer.address;
  const addr = process.env.MERIDIAN_WALLET_ADDRESS;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

// One shared client, with two layers of request coalescing so the several
// pollers (marketData, basis, lpGuard, allocator, snapshotter) don't each fire
// separate RPC calls for overlapping reads:
//   - multicall: concurrent eth_calls (getSlot0/getLiquidity/balanceOf) merge
//     into a single multicall contract call
//   - http batch: multiple JSON-RPC requests in a ~100ms window ship as one
//     HTTP POST
// This is transparent to callers and is the main lever against rate-limits.
let publicClient: ReturnType<typeof createPublicClient> | null = null;
export function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: robinhoodChain,
      // retryCount/retryDelay: the public RPC returns HTTP 429 under load; viem
      // retries 429s with exponential backoff (honoring Retry-After), so a brief
      // rate-limit window is ridden out instead of surfacing as a read failure.
      transport: http(config.robinhoodRpcUrl, { batch: { wait: 100, batchSize: 10 }, retryCount: 4, retryDelay: 250 }),
      batch: { multicall: { wait: 50 } },
    });
  }
  return publicClient;
}

export function getWalletClient() {
  const signer = getAgentSigner();
  if (!signer) throw new Error("AGENT_SIGNER_PRIVATE_KEY not configured");
  return createWalletClient({ account: signer.account, chain: robinhoodChain, transport: http(config.robinhoodRpcUrl) });
}
