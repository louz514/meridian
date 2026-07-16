import { INDEX_CONTRACTS, type IndexTradeResult } from "./indexContracts.js";
import { getAgentSigner } from "./signer.js";
import { realBuyIndex, realSellIndex } from "./uniswapV4.js";
import { realSwapStockToStock, realBuyStockFromNative, isTradable } from "./stockPools.js";

export { INDEX_CONTRACTS };
export type { IndexTradeResult };

/**
 * Same-chain execution on The Index — swaps one Index token for another via
 * the Universal Router, entirely on Robinhood Chain. Distinct from
 * WormholeBridge, which only moves value *between* chains: an Index rotation
 * never leaves Robinhood Chain, so it was never going to be reachable through
 * the bridge tools. Stub until ROBINHOOD_RPC_URL + a signer are configured —
 * same honesty pattern as WormholeBridge/X402Client: logs exactly what it
 * would do against the real contracts above, doesn't silently pretend.
 *
 * buyIndex/sellIndex (the ETH<->$INDEX legs IndexYieldStrategy's decisions
 * describe) submit a real Uniswap v4 swap via the verified UniversalRouter
 * (see uniswapV4.ts) once both ROBINHOOD_RPC_URL and AGENT_SIGNER_PRIVATE_KEY
 * are set. swap() (stock-to-stock rotation) does too, but routes through
 * stockPools.ts's separate, verified STANDARD (hookless) pools instead of
 * The Index's own ~5%-per-leg ones — falls back to the stub for any ticker
 * without a verified cheap pool (see stockPools.ts's registry) rather than
 * silently routing through the expensive pools.
 */
export class IndexTrader {
  readonly name = "the-index";

  constructor(private rpcUrl: string) {}

  private get hasRealExecution(): boolean {
    return Boolean(this.rpcUrl) && getAgentSigner() !== null;
  }

  async swap(params: {
    fromSymbol: string;
    toSymbol: string;
    amountUsd: number;
    payer: string;
  }): Promise<IndexTradeResult> {
    const { fromSymbol, toSymbol, amountUsd, payer } = params;
    const fromToken = INDEX_CONTRACTS.tokens[fromSymbol];
    const toToken = INDEX_CONTRACTS.tokens[toSymbol];
    if (!fromToken || !toToken) {
      return {
        success: false,
        venue: "the-index",
        fromSymbol,
        toSymbol,
        amountUsd,
        error: `unknown Index token: ${!fromToken ? fromSymbol : toSymbol}`,
      };
    }

    if (!this.hasRealExecution || !isTradable(fromSymbol) || !isTradable(toSymbol)) {
      const why = !this.hasRealExecution
        ? `${!this.rpcUrl ? "no ROBINHOOD_RPC_URL" : "no AGENT_SIGNER_PRIVATE_KEY"} configured`
        : `no verified cheap pool for ${!isTradable(fromSymbol) ? fromSymbol : toSymbol} (routes only through The Index's own ~5%-per-leg pools, not attempted)`;
      console.log(
        `[IndexTrader:stub] would swap $${amountUsd} ${fromSymbol} (${fromToken}) -> ${toSymbol} (${toToken}) for ${payer} (${why})`,
      );
      return { success: true, venue: "the-index", fromSymbol, toSymbol, amountUsd, txHash: "stub-index-tx" };
    }

    try {
      const { hash, amountReceived, hops } = await realSwapStockToStock({ fromSymbol, toSymbol, amountUsd });
      console.log(`[IndexTrader] real ${fromSymbol} -> ${toSymbol} rotation settled in ${hops} hop(s): ${hash}`);
      return { success: true, venue: "the-index", fromSymbol, toSymbol, amountUsd, txHash: hash, amountReceived };
    } catch (err) {
      return {
        success: false,
        venue: "the-index",
        fromSymbol,
        toSymbol,
        amountUsd,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * ETH -> a single Index-basket stock ticker, entirely outside the wallet's
   * existing stock holdings — used by MomentumStrategy when it doesn't hold
   * enough of a rotation's "from" leg to sell (no position to rotate out of
   * yet). Distinct from buyIndex below: this buys ONE stock token via
   * stockPools.ts's verified cheap pools, not $INDEX itself via the fee-hook
   * pool.
   */
  async buyStockFromNative(params: { toSymbol: string; amountUsd: number; payer: string }): Promise<IndexTradeResult> {
    const { toSymbol, amountUsd, payer } = params;
    const toToken = INDEX_CONTRACTS.tokens[toSymbol];
    if (!toToken) {
      return { success: false, venue: "the-index", fromSymbol: "ETH", toSymbol, amountUsd, error: `unknown Index token: ${toSymbol}` };
    }

    if (!this.hasRealExecution || !isTradable(toSymbol)) {
      const why = !this.hasRealExecution
        ? `${!this.rpcUrl ? "no ROBINHOOD_RPC_URL" : "no AGENT_SIGNER_PRIVATE_KEY"} configured`
        : `no verified cheap pool for ${toSymbol} (routes only through The Index's own ~5%-per-leg pools, not attempted)`;
      console.log(`[IndexTrader:stub] would buy $${amountUsd} ${toSymbol} (${toToken}) from native ETH for ${payer} (${why})`);
      return { success: true, venue: "the-index", fromSymbol: "ETH", toSymbol, amountUsd, txHash: "stub-index-entry-tx" };
    }

    try {
      const { hash, amountReceived, hops } = await realBuyStockFromNative({ toSymbol, amountUsd });
      console.log(`[IndexTrader] real ETH -> ${toSymbol} entry settled in ${hops} hop(s): ${hash}`);
      return { success: true, venue: "the-index", fromSymbol: "ETH", toSymbol, amountUsd, txHash: hash, amountReceived };
    } catch (err) {
      return {
        success: false,
        venue: "the-index",
        fromSymbol: "ETH",
        toSymbol,
        amountUsd,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * ETH -> $INDEX, the entry leg IndexYieldStrategy's "enter_index" decision
   * would execute. Distinct from swap() above: goes through the product's own
   * fee-hook pool (3% ETH fee), not the per-stock secondary markets.
   */
  async buyIndex(params: { amountUsd: number; payer: string }): Promise<IndexTradeResult> {
    const { amountUsd, payer } = params;
    if (!this.hasRealExecution) {
      console.log(
        `[IndexTrader:stub] would swap $${amountUsd} ETH -> $INDEX (${INDEX_CONTRACTS.indexToken}) for ${payer} via ` +
          `UniversalRouter ${INDEX_CONTRACTS.universalRouter} (fee hook ${INDEX_CONTRACTS.indexFeeHook} takes 3% ETH; ` +
          `${!this.rpcUrl ? "no ROBINHOOD_RPC_URL" : "no AGENT_SIGNER_PRIVATE_KEY"} configured)`,
      );
      return { success: true, venue: "the-index", fromSymbol: "ETH", toSymbol: "INDEX", amountUsd, txHash: "stub-index-buy-tx" };
    }
    try {
      const { hash, amountReceived } = await realBuyIndex(amountUsd);
      return {
        success: true,
        venue: "the-index",
        fromSymbol: "ETH",
        toSymbol: "INDEX",
        amountUsd,
        txHash: hash,
        amountReceived: amountReceived ?? undefined,
      };
    } catch (err) {
      return {
        success: false,
        venue: "the-index",
        fromSymbol: "ETH",
        toSymbol: "INDEX",
        amountUsd,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** $INDEX -> ETH, the exit leg IndexYieldStrategy's "exit_index" decision would execute. */
  async sellIndex(params: { amountUsd: number; payer: string }): Promise<IndexTradeResult> {
    const { amountUsd, payer } = params;
    if (!this.hasRealExecution) {
      console.log(
        `[IndexTrader:stub] would swap $${amountUsd} $INDEX (${INDEX_CONTRACTS.indexToken}) -> ETH for ${payer} via ` +
          `UniversalRouter ${INDEX_CONTRACTS.universalRouter} (fee hook ${INDEX_CONTRACTS.indexFeeHook} takes 3% ETH; ` +
          `${!this.rpcUrl ? "no ROBINHOOD_RPC_URL" : "no AGENT_SIGNER_PRIVATE_KEY"} configured)`,
      );
      return { success: true, venue: "the-index", fromSymbol: "INDEX", toSymbol: "ETH", amountUsd, txHash: "stub-index-sell-tx" };
    }
    try {
      const { hash } = await realSellIndex(amountUsd);
      return { success: true, venue: "the-index", fromSymbol: "INDEX", toSymbol: "ETH", amountUsd, txHash: hash };
    } catch (err) {
      return {
        success: false,
        venue: "the-index",
        fromSymbol: "INDEX",
        toSymbol: "ETH",
        amountUsd,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
