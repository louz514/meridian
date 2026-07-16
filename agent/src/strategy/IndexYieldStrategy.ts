import type { AgentDecision, PositionSnapshot, RwaAsset } from "../types.js";
import type { Strategy } from "./Strategy.js";
import { IndexYieldData, type IndexYieldSnapshot } from "../indexYield.js";
import { config } from "../config.js";
import { loadPositionState, savePositionState, type PositionState } from "../positionState.js";
import { getAgentSigner } from "../venues/signer.js";
import { readStockBalances, valueStockBalances } from "../venues/positionAccounting.js";

const usd = (n: number): string => {
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1 || n === 0) return `$${n.toFixed(2)}`;
  if (n <= -1) return `-$${Math.abs(n).toFixed(2)}`;
  return `$${n.toFixed(6)}`;
};
const pct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function minutesUntil(unixSeconds: number | null): string {
  if (unixSeconds == null) return "unknown";
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60000);
  return mins <= 0 ? "any moment" : `~${mins}m`;
}

const ETH_ASSET = (priceUsd: number): RwaAsset => ({
  id: "robinhood-eth",
  symbol: "ETH",
  name: "Ether",
  chain: "robinhood",
  priceUsd,
});
const INDEX_ASSET = (priceUsd: number): RwaAsset => ({
  id: "the-index-fund",
  symbol: "INDEX",
  name: "The Index (fund token)",
  chain: "robinhood",
  priceUsd,
});

// Round-trip cost is real and empirically measured (2026-07-11, risk-free
// on-chain simulation at $180 size): ~3% fee + ~4.5% price impact per leg.
// Entry cost is already sunk (baked into the real cost basis, not a future
// cost) — what a profit-take threshold has to clear going forward is just
// the ONE remaining leg (exit): ~7.5%. Tightened 2026-07-11 for smaller,
// more frequent profit-taking per direct instruction — 9% is the smallest
// threshold that still clears real exit costs with any margin (~1.5pts);
// going lower would mean "taking profit" locks in a real loss net of fees.
// Revisit downward only if trade size shrinks enough to cut price impact
// (impact is most of this cost, not the flat 3% fee).
const PROFIT_TAKE_PCT = 9;
// Explicit, unconditional: exit whenever net P&L crosses -10%, regardless of
// trend or anything else. Per direct instruction — no longer -15%.
const STOP_LOSS_PCT = -10;

/**
 * Holds $INDEX to qualify for its real distribution mechanic. Reactivated
 * 2026-07-11 with real P&L tracking (previously: pure distribution-rate-trend
 * exit/hold, no awareness of whether the position was actually profitable —
 * see git history / meridian-index-yield-mechanics memory for that gap and
 * why it mattered). Position state is now persisted to disk
 * (positionState.ts), not just in-memory — a process restart no longer
 * forgets a real, on-chain position, which is what caused the earlier
 * uncontrolled re-entry incident.
 *
 * Mechanics this reasons over (confirmed on-chain + via theindex.finance's
 * own live/indexer endpoints, 2026-07-11):
 *   - A 3% ETH fee hook on every ETH<->$INDEX swap continuously buys the 18
 *     Index stock tokens, batched into a pro-rata payout to eligible holders
 *     roughly every 15-20 minutes.
 *   - Eligibility is a flat on-chain constant: hold >= 10,000 $INDEX.
 *   - This is a fee-redistribution mechanism, not organic yield — a holder's
 *     payout is funded by OTHER traders' 3% fees on that same pool.
 *
 * Exit decision now combines three independent, real signals rather than
 * trend alone: take profit once net P&L clears real exit costs with margin;
 * cut losses if a position genuinely sours; otherwise fall back to the
 * original risk signal (protect capital if the engine funding the yield is
 * itself fading).
 */
function positionSnapshot(
  state: PositionState,
  pnl: { distributionsUsd: number; indexValueUsd: number; netPnlUsd: number; netPnlPct: number } | null,
): PositionSnapshot {
  return {
    inPosition: state.inPosition,
    entryCostUsd: state.inPosition ? state.entryCostUsd : undefined,
    distributionsUsd: pnl?.distributionsUsd,
    indexValueUsd: pnl?.indexValueUsd,
    netPnlUsd: pnl?.netPnlUsd,
    netPnlPct: pnl?.netPnlPct,
    stopLossPct: STOP_LOSS_PCT,
    profitTakePct: PROFIT_TAKE_PCT,
  };
}

export class IndexYieldStrategy implements Strategy {
  readonly name = "index-distribution-yield";

  constructor(private yieldData = new IndexYieldData()) {}

  /** Called after a real ETH -> $INDEX swap succeeds — see executeIndexYieldTrade.ts. */
  confirmEntered(costUsd: number, indexTokensReceived: number, stockBalanceSnapshot: Record<string, number>): void {
    savePositionState({
      inPosition: true,
      entryCostUsd: costUsd,
      entryIndexTokens: indexTokensReceived,
      entryStockBalances: stockBalanceSnapshot,
      enteredAt: Date.now(),
    });
  }

  /** Called after a real $INDEX -> ETH swap succeeds — see executeIndexYieldTrade.ts. */
  confirmExited(): void {
    savePositionState({ inPosition: false, entryCostUsd: 0, entryIndexTokens: 0, entryStockBalances: {}, enteredAt: null });
  }

  /** Real net P&L: (distributions received + current $INDEX mark-to-market) - entry cost. Null if not in position or balances unreadable. */
  private async computePnl(
    state: PositionState,
    snap: IndexYieldSnapshot,
  ): Promise<{ distributionsUsd: number; indexValueUsd: number; netPnlUsd: number; netPnlPct: number } | null> {
    const signer = getAgentSigner();
    if (!signer) return null;
    const currentStockBalances = await readStockBalances(signer.address).catch(() => null);
    if (!currentStockBalances) return null;

    const receivedBalances: Record<string, number> = {};
    for (const symbol of Object.keys(state.entryStockBalances)) {
      receivedBalances[symbol] = (currentStockBalances[symbol] ?? 0) - (state.entryStockBalances[symbol] ?? 0);
    }
    const distributionsUsd = valueStockBalances(receivedBalances, snap.stockUsd);
    const indexValueUsd = state.entryIndexTokens * snap.indexPriceUsd;
    const netPnlUsd = distributionsUsd + indexValueUsd - state.entryCostUsd;
    const netPnlPct = state.entryCostUsd > 0 ? (netPnlUsd / state.entryCostUsd) * 100 : 0;
    return { distributionsUsd, indexValueUsd, netPnlUsd, netPnlPct };
  }

  async evaluate(_assets: RwaAsset[]): Promise<AgentDecision> {
    const timestamp = Date.now();
    const snap = await this.yieldData.snapshot();
    const thoughts: string[] = [];
    const state = loadPositionState();

    if (!snap.live) {
      thoughts.push("theindex.finance's live distribution feed hasn't returned data yet — holding until it does.");
      return { timestamp, action: "hold", reason: "waiting on live $INDEX yield data", thoughts, position: positionSnapshot(state, null) };
    }

    thoughts.push(
      `$INDEX trades at ${usd(snap.indexPriceUsd)} (${snap.indexPriceEth.toExponential(3)} ETH). Eligibility for stock ` +
        `distributions requires holding ${snap.eligibilityThresholdTokens.toLocaleString()} $INDEX ` +
        `(${usd(snap.eligibilityThresholdUsd)}) — this is a fee-redistribution mechanic, not organic yield: the 3% ` +
        `entry/exit fee other traders pay on the ETH<->$INDEX pool is what funds the payout.`,
    );
    thoughts.push(
      `Distribution engine: ${snap.distributedUsdPerDayRecent != null ? usd(snap.distributedUsdPerDayRecent) : "n/a"}/day ` +
        `distributed recently vs ${snap.distributedUsdPerDayPrior != null ? usd(snap.distributedUsdPerDayPrior) : "n/a"}/day ` +
        `prior — trend ${snap.trend}. ${snap.holderCount ?? "?"} wallets currently eligible. ` +
        `${usd(snap.pendingPotUsd)} pending across the 18 stocks, next distribution in ${minutesUntil(snap.nextDistributionAt)}.`,
    );

    const engineHealthy = snap.trend === "rising" || snap.trend === "stable";

    if (!state.inPosition) {
      if (!engineHealthy) {
        thoughts.push(
          `Trend is ${snap.trend} — sitting out. Entering now would pay the 3% fee into a ${snap.trend === "falling" ? "cooling" : "unproven"} engine.`,
        );
        return { timestamp, action: "hold", reason: `distribution engine ${snap.trend} — not entering yet`, thoughts, position: positionSnapshot(state, null) };
      }

      if (snap.eligibilityThresholdUsd > config.maxTradeUsd) {
        thoughts.push(
          `Eligibility floor (${usd(snap.eligibilityThresholdUsd)}) exceeds the per-trade risk cap (${usd(config.maxTradeUsd)})` +
            ` — can't enter without breaching it, so sitting out.`,
        );
        return { timestamp, action: "hold", reason: "eligibility floor exceeds the per-trade risk cap", thoughts, position: positionSnapshot(state, null) };
      }

      const sizeUsd = config.maxTradeUsd;
      const reason = `$INDEX distribution engine trending ${snap.trend} — entering to qualify for pro-rata stock payouts`;
      thoughts.push(
        `Entering with ${usd(sizeUsd)} (clears the ${usd(snap.eligibilityThresholdUsd)} eligibility floor) via ETH -> ` +
          `$INDEX. The 3% entry fee is the cost of qualifying; it's recovered once cumulative distributions plus price ` +
          `movement exceed ~${PROFIT_TAKE_PCT}% (the real round-trip cost to later exit).`,
      );
      return {
        timestamp,
        action: "enter_index",
        intent: { fromAsset: ETH_ASSET(snap.ethUsd), toAsset: INDEX_ASSET(snap.indexPriceUsd), amountUsd: sizeUsd, reason },
        reason,
        thoughts,
        position: positionSnapshot(state, null),
      };
    }

    // In position: compute real P&L before deciding anything.
    const pnl = await this.computePnl(state, snap);
    if (!pnl) {
      thoughts.push("In position, but couldn't read the wallet's real balances this cycle (no signer, or an RPC error) — holding rather than guess.");
      return { timestamp, action: "hold_index", reason: "position P&L unreadable this cycle — holding", thoughts, position: positionSnapshot(state, null) };
    }

    thoughts.push(
      `Position since entry (${usd(state.entryCostUsd)} in): distributions received so far ${usd(pnl.distributionsUsd)}, ` +
        `current $INDEX value ${usd(pnl.indexValueUsd)}. Net P&L: ${pnl.netPnlUsd >= 0 ? "+" : ""}${usd(pnl.netPnlUsd)} ` +
        `(${pct(pnl.netPnlPct)}).`,
    );

    const exitUsd = pnl.indexValueUsd; // current mark-to-market — what actually gets sold, not the stale entry size

    if (pnl.netPnlPct >= PROFIT_TAKE_PCT) {
      const reason = `net gain ${pct(pnl.netPnlPct)} clears the ~${PROFIT_TAKE_PCT}% profit target — taking it`;
      thoughts.push(`${pct(pnl.netPnlPct)} comfortably clears the real cost to exit (~7.5%: 3% fee + ~4.5% impact) — this is a real profit, not just a paper one. Exiting.`);
      return {
        timestamp,
        action: "exit_index",
        intent: { fromAsset: INDEX_ASSET(snap.indexPriceUsd), toAsset: ETH_ASSET(snap.ethUsd), amountUsd: exitUsd, reason },
        reason,
        thoughts,
        position: positionSnapshot(state, pnl),
      };
    }

    if (pnl.netPnlPct <= STOP_LOSS_PCT) {
      const reason = `net loss ${pct(pnl.netPnlPct)} breaches the ${STOP_LOSS_PCT}% stop-loss — cutting it`;
      thoughts.push(`Down ${pct(pnl.netPnlPct)} — beyond the ${STOP_LOSS_PCT}% line where this stops being a reasonable bet regardless of trend. Exiting to protect remaining capital.`);
      return {
        timestamp,
        action: "exit_index",
        intent: { fromAsset: INDEX_ASSET(snap.indexPriceUsd), toAsset: ETH_ASSET(snap.ethUsd), amountUsd: exitUsd, reason },
        reason,
        thoughts,
        position: positionSnapshot(state, pnl),
      };
    }

    if (!engineHealthy) {
      const reason = `distribution rate falling (P&L currently ${pct(pnl.netPnlPct)}) — exiting to protect capital`;
      thoughts.push(
        `Trend has turned down. P&L is currently ${pct(pnl.netPnlPct)} — not a profit-take, not a stop-loss, but the ` +
          `engine funding this position is fading, so exiting now rather than waiting for it to become one.`,
      );
      return {
        timestamp,
        action: "exit_index",
        intent: { fromAsset: INDEX_ASSET(snap.indexPriceUsd), toAsset: ETH_ASSET(snap.ethUsd), amountUsd: exitUsd, reason },
        reason,
        thoughts,
        position: positionSnapshot(state, pnl),
      };
    }

    const reason = `holding — P&L ${pct(pnl.netPnlPct)}, between stop-loss and profit-take, engine ${snap.trend}`;
    thoughts.push(`${pct(pnl.netPnlPct)} is between the ${STOP_LOSS_PCT}% stop-loss and ${PROFIT_TAKE_PCT}% profit-take, and the engine is ${snap.trend} — no reason to pay the exit fee yet.`);
    return { timestamp, action: "hold_index", reason, thoughts, position: positionSnapshot(state, pnl) };
  }
}
