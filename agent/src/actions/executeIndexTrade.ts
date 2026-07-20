import { risk, x402, indexTrader, decisionLog } from "../state.js";
import { withHouseWalletLock } from "../houseWallet.js";
import { routingFeeUsd } from "../fees.js";
import { recordExecution } from "../executionsLog.js";
import type { IndexTradeResult } from "../venues/IndexTrader.js";

export interface ExecuteIndexTradeParams {
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
  payer: string;
  /** Who initiated: the autonomous loop, or a direct caller (MCP tool / HTTP route). Labels the decision log truthfully — loop rotations used to show up as "manual". */
  source?: "agent-loop" | "manual";
}

export type ExecuteIndexTradeOutcome =
  | { success: false; error: string }
  | (IndexTradeResult & { feeUsd: number; spentTodayUsd: number });

/**
 * The one place "execute a trade on The Index" happens — shared by the MCP
 * tool (meridian_index_execute) and the frontend's POST /api/index-trade, so
 * risk caps / x402 fee settlement / decision logging can't drift between the
 * two entry points.
 */
export async function executeIndexTrade(params: ExecuteIndexTradeParams): Promise<ExecuteIndexTradeOutcome> {
  // Serialize all house-wallet signing (see houseWallet.ts) so this can never
  // submit a tx concurrently with the LP guard or another operator action.
  return withHouseWalletLock("index-trade", async (): Promise<ExecuteIndexTradeOutcome> => {
  const { fromSymbol, toSymbol, amountUsd, payer, source = "manual" } = params;

  const sized = risk.size(amountUsd);
  const gate = risk.check(sized);
  if (!gate.ok) return { success: false, error: gate.reason! };

  const feeUsd = routingFeeUsd(sized);
  const feeReceipt = await x402.pay({ amountUsd: feeUsd, payer, memo: `Index routing fee: ${fromSymbol} -> ${toSymbol}` });
  if (!feeReceipt.success) {
    return { success: false, error: feeReceipt.error ?? "x402 fee settlement failed" };
  }

  const result =
    fromSymbol === "ETH"
      ? await indexTrader.buyStockFromNative({ toSymbol, amountUsd: sized, payer })
      : await indexTrader.swap({ fromSymbol, toSymbol, amountUsd: sized, payer });
  recordExecution({
    ts: Date.now(),
    kind: fromSymbol === "ETH" ? "entry" : "rotation",
    fromSymbol,
    toSymbol,
    amountUsd: sized,
    success: result.success,
    txHash: "txHash" in result ? result.txHash : undefined,
    error: result.success ? undefined : result.error,
  });
  if (result.success) {
    risk.record(sized);
    decisionLog.record(source === "agent-loop" ? "the-index-rotation" : "the-index-manual", {
      timestamp: Date.now(),
      action: "trade",
      reason:
        source === "agent-loop"
          ? `autonomous rotation executed: ${fromSymbol} -> ${toSymbol}`
          : `manual Index swap: ${fromSymbol} -> ${toSymbol}`,
      thoughts: [
        source === "agent-loop"
          ? `Rotation filled on-chain: $${sized} ${fromSymbol} -> ${toSymbol} through the verified standard pools.`
          : `Executed directly (not the background loop): swap $${sized} ${fromSymbol} -> ${toSymbol} on The Index.`,
      ],
    });
  }

  return { ...result, feeUsd, spentTodayUsd: risk.spentTodayUsd };
  });
}
