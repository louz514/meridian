import type { MarketData } from "./marketData.js";
import type { Strategy } from "./strategy/Strategy.js";
import type { DecisionLog } from "./decisionLog.js";
import { config } from "./config.js";
import { getAgentSigner } from "./venues/signer.js";
import { executeIndexYieldTrade } from "./actions/executeIndexYieldTrade.js";
import { executeIndexTrade } from "./actions/executeIndexTrade.js";

/**
 * Keeps the agent "thinking" even with no external caller — evaluates the
 * strategy on a timer and logs the result, so the live monitor always has
 * something recent to show.
 *
 * Acting on those decisions is a separate, explicitly-gated step: only when
 * config.liveTradingEnabled is true (AGENT_LIVE_TRADING=true) AND a signer is
 * configured (AGENT_SIGNER_PRIVATE_KEY) does the loop execute a decision
 * itself, using the agent's own wallet as payer — there's no human in this
 * loop to supply one. enter_index/exit_index go through
 * executeIndexYieldTrade (the ETH<->$INDEX leg); trade (stock-to-stock
 * rotation, from MomentumStrategy) goes through executeIndexTrade, which
 * routes through stockPools.ts's verified cheap pools. Absent either opt-in,
 * the loop stays read-only exactly as before: it decides and logs, nothing
 * spends. This split (decide vs. act, each independently gated) is
 * deliberate — see config.ts's liveTradingEnabled comment for why three
 * separate opt-ins instead of one.
 */
export function startAgentLoop(
  market: MarketData,
  strategy: Strategy,
  log: DecisionLog,
  intervalMs: number,
): NodeJS.Timeout {
  // A live trade (approvals + swap + receipt waits) can outlast the think
  // interval; without this guard two ticks execute concurrently and can
  // both spend before either records against the risk cap.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runTick();
    } finally {
      inFlight = false;
    }
  };
  const runTick = async () => {
    const decision = await strategy.evaluate(market.listAssets());
    const logged = log.record(strategy.name, decision);

    if (!config.liveTradingEnabled) return;
    const isYieldAction = decision.action === "enter_index" || decision.action === "exit_index";
    const isStockRotation = decision.action === "trade" && decision.intent != null;
    if (!isYieldAction && !isStockRotation) return;

    const signer = getAgentSigner();
    if (!signer) {
      console.error("[agentLoop] AGENT_LIVE_TRADING=true but AGENT_SIGNER_PRIVATE_KEY is not set — not executing");
      return;
    }

    const outcome = isYieldAction
      ? await (async () => {
          const side = decision.action === "enter_index" ? "enter" : "exit";
          const amountUsd = decision.intent?.amountUsd ?? 0;
          console.error(`[agentLoop] autonomous ${side}: $${amountUsd} (payer ${signer.address})`);
          return executeIndexYieldTrade({ side, amountUsd, payer: signer.address });
        })()
      : await (async () => {
          const { fromAsset, toAsset, amountUsd } = decision.intent!;
          console.error(`[agentLoop] autonomous rotation: $${amountUsd} ${fromAsset.symbol} -> ${toAsset.symbol} (payer ${signer.address})`);
          return executeIndexTrade({ fromSymbol: fromAsset.symbol, toSymbol: toAsset.symbol, amountUsd, payer: signer.address, source: "agent-loop" });
        })();

    // Attach the REAL outcome to the same logged decision — a live monitor
    // must be able to tell "the agent decided to trade" apart from "the trade
    // actually landed on-chain" (risk caps, reverts, etc. can block the former
    // from becoming the latter, and previously that distinction was silent).
    logged.execution = {
      success: outcome.success,
      txHash: "txHash" in outcome ? outcome.txHash : undefined,
      amountReceived: "amountReceived" in outcome ? outcome.amountReceived : undefined,
      error: outcome.error,
    };
    if (!outcome.success) {
      console.error(`[agentLoop] autonomous trade failed: ${outcome.error}`);
    }
  };
  void tick(); // seed immediately so the log isn't empty on boot
  return setInterval(() => void tick(), intervalMs);
}
