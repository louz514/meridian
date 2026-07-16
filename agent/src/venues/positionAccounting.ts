// Real position accounting for the $INDEX yield strategy — what actually
// landed in the agent's wallet, not just the nominal USD size of a decision.
// Needed because IndexYieldStrategy previously had no way to know whether a
// held position was profitable: it only knew the distribution engine's trend,
// never what the wallet actually received or what $INDEX is worth now.
import { parseAbiItem, type Address, type Hex, type TransactionReceipt } from "viem";
import { getPublicClient } from "./signer.js";
import { INDEX_CONTRACTS } from "./indexContracts.js";

const erc20BalanceAbi = [parseAbiItem("function balanceOf(address) view returns (uint256)")];
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Current balance (in whole tokens, 18 decimals assumed) of every one of the 18 Index stock tokens, for `address`. */
export async function readStockBalances(address: Address): Promise<Record<string, number>> {
  const client = getPublicClient();
  const entries = Object.entries(INDEX_CONTRACTS.tokens);
  const balances = await Promise.all(
    entries.map(([, tokenAddr]) =>
      client
        .readContract({ address: tokenAddr as Address, abi: erc20BalanceAbi, functionName: "balanceOf", args: [address] })
        .catch(() => 0n),
    ),
  );
  const result: Record<string, number> = {};
  entries.forEach(([symbol], i) => {
    result[symbol] = Number(balances[i]) / 1e18;
  });
  return result;
}

/** USD value of a stock-balance snapshot, priced at current spot (from IndexYieldSnapshot.stockUsd). */
export function valueStockBalances(balances: Record<string, number>, stockUsd: Record<string, number>): number {
  return Object.entries(balances).reduce((sum, [symbol, amount]) => sum + amount * (stockUsd[symbol] ?? 0), 0);
}

/**
 * Exact amount of `token` transferred *to* `recipient` in a receipt — the
 * real fill amount for a swap, reflecting actual execution (fees, slippage,
 * hook behavior), not the pre-trade estimate. Falls back to null if no
 * matching Transfer log is found (e.g. native ETH, which doesn't emit one).
 */
export function exactTransferAmount(receipt: TransactionReceipt, token: Address, recipient: Address): number | null {
  const selector = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // keccak256(Transfer(address,address,uint256))
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if (log.topics[0] !== selector) continue;
    const to = `0x${log.topics[2]?.slice(-40)}`;
    if (to.toLowerCase() !== recipient.toLowerCase()) continue;
    return Number(BigInt(log.data)) / 1e18;
  }
  return null;
}

export { transferEvent };
export type { TransactionReceipt, Hex };
