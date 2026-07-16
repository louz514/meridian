import { risk, x402, indexTrader, indexYieldStrategy } from "../state.js";
import { routingFeeUsd } from "../fees.js";
import { recordExecution } from "../executionsLog.js";
import type { IndexTradeResult } from "../venues/IndexTrader.js";
import { getAgentSigner } from "../venues/signer.js";
import { readStockBalances } from "../venues/positionAccounting.js";

export interface ExecuteIndexYieldTradeParams {
  side: "enter" | "exit";
  amountUsd: number;
  payer: string;
}

export type ExecuteIndexYieldTradeOutcome =
  | { success: false; error: string }
  | (IndexTradeResult & { feeUsd: number; spentTodayUsd: number });

/**
 * The one place "enter or exit the $INDEX yield position" happens — a real
 * ETH<->$INDEX swap via IndexTrader.buyIndex/sellIndex. Mirrors
 * executeIndexTrade.ts's risk/fee/log shape. On a successful enter, snapshots
 * the wallet's real stock-token balances (the baseline later reads diff
 * against to know what's actually been distributed) and records the real
 * fill amount — not the nominal request — as the strategy's cost basis, so
 * evaluate() can compute genuine P&L instead of just watching trend.
 */
export async function executeIndexYieldTrade(params: ExecuteIndexYieldTradeParams): Promise<ExecuteIndexYieldTradeOutcome> {
  const { side, amountUsd, payer } = params;

  const sized = risk.size(amountUsd);
  const gate = risk.check(sized);
  if (!gate.ok) return { success: false, error: gate.reason! };

  const feeUsd = routingFeeUsd(sized);
  const feeReceipt = await x402.pay({ amountUsd: feeUsd, payer, memo: `$INDEX ${side} routing fee` });
  if (!feeReceipt.success) {
    return { success: false, error: feeReceipt.error ?? "x402 fee settlement failed" };
  }

  const result =
    side === "enter"
      ? await indexTrader.buyIndex({ amountUsd: sized, payer })
      : await indexTrader.sellIndex({ amountUsd: sized, payer });
  recordExecution({
    ts: Date.now(),
    kind: side === "enter" ? "yield-enter" : "yield-exit",
    toSymbol: "$INDEX",
    amountUsd: sized,
    success: result.success,
    txHash: "txHash" in result ? result.txHash : undefined,
    error: result.success ? undefined : result.error,
  });

  if (result.success) {
    risk.record(sized);
    if (side === "enter") {
      const signer = getAgentSigner();
      const stockBalances = signer ? await readStockBalances(signer.address).catch(() => ({})) : {};
      indexYieldStrategy.confirmEntered(sized, result.amountReceived ?? 0, stockBalances);
    } else {
      indexYieldStrategy.confirmExited();
    }
  }

  return { ...result, feeUsd, spentTodayUsd: risk.spentTodayUsd };
}
