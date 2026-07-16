import type { AgentDecision, RwaAsset } from "../types.js";
import type { Strategy } from "./Strategy.js";
import { config } from "../config.js";
import { isTradable, poolFeePct } from "../venues/stockPools.js";
import { lastSuccessfulTradeTs } from "../executionsLog.js";
import { getAgentSigner } from "../venues/signer.js";
import { readStockBalances } from "../venues/positionAccounting.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";

const ETH_ASSET = (priceUsd: number): RwaAsset => ({
  id: "robinhood-eth",
  symbol: "ETH",
  name: "Ether",
  chain: "robinhood",
  priceUsd,
});

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function bps(n: number): string {
  return `${(n / 100).toFixed(2)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Reactivated 2026-07-11: routes through stockPools.ts's separate, verified
 * STANDARD (hookless) Uniswap v4 pools for the same real Robinhood stock
 * tokens — ~0.01%-1% fee tiers, not The Index's own ~5%-per-leg pools that
 * originally made this strategy value-destroying (see
 * meridian-standard-stock-pools / meridian-backtest-finding memories: the
 * historical backtest, re-run with the corrected ~2% real round-trip cost
 * through these cheap pools, flips from -91%/-99% net to +11.7%-+279.6% net
 * across rotation thresholds). Restricted to stockPools.TRADABLE_SYMBOLS —
 * BE/MSFT/USAR have no verified cheap pool and are excluded rather than
 * silently routed through The Index's expensive ones.
 *
 * Two rotation signals, evaluated in priority order:
 *
 * 1. Index momentum rotation — The Index's tokenized equities on Robinhood
 *    Chain (price-driven, no APR). Rotates out of the biggest 24h laggard
 *    into the biggest 24h leader when the spread clears the threshold. This
 *    is the actual tradeable signal for Index assets — narration alone isn't
 *    a decision.
 * 2. APR rotation — yield-bearing RWAs elsewhere, unchanged from before.
 *
 * Index is checked first because it's the priority venue; if it doesn't
 * clear its threshold this cycle, the strategy falls through to APR
 * rotation rather than holding outright.
 */
export class MomentumStrategy implements Strategy {
  readonly name = "momentum-apr-rotation";

  // Why the momentum branch declined to trade this cycle. When the APR branch
  // then has nothing either, THIS is the story the surfaced hold reason must
  // tell — "fewer than two yield-bearing assets" as the public headline reads
  // like the agent is confused about a market it scanned perfectly well.
  private momentumHoldContext: string | null = null;

  // Persistence filter state: which pair has been above its bar, and since
  // when. A different pair (or a dip below the bar) resets the clock — so a
  // one-tick opening gap can never fire a trade (2026-07-13 churn guard).
  private aboveBar: { pairKey: string; since: number } | null = null;

  constructor(
    private minAprImprovementBps = 25,
    // Spread threshold is the economic guardrail (a rotation costs ~0.6-2% in
    // fees + impact) — see config.minMomentumSpreadPct before lowering it.
    private minIndexMomentumSpreadPct = config.minMomentumSpreadPct,
  ) {}

  async evaluate(assets: RwaAsset[]): Promise<AgentDecision> {
    const timestamp = Date.now();
    const thoughts: string[] = [];

    const indexDecision = await this.evaluateIndex(assets, timestamp, thoughts);
    if (indexDecision) return indexDecision;

    return this.evaluateAprRotation(assets, timestamp, thoughts);
  }

  /** Real held USD value per symbol in the agent's own wallet — null if unknown (no signer, or an RPC error), not zero, so callers can tell "definitely doesn't hold it" apart from "can't check right now." */
  private async heldValuesUsd(assets: RwaAsset[]): Promise<Record<string, number> | null> {
    const signer = getAgentSigner();
    if (!signer) return null;
    const balances = await readStockBalances(signer.address).catch(() => null);
    if (!balances) return null;
    const result: Record<string, number> = {};
    for (const a of assets) result[a.symbol] = (balances[a.symbol] ?? 0) * a.priceUsd;
    return result;
  }

  private async evaluateIndex(assets: RwaAsset[], timestamp: number, thoughts: string[]): Promise<AgentDecision | null> {
    this.momentumHoldContext = null;
    const indexAssets = assets.filter((a) => a.chain === "robinhood" && a.changePct != null && isTradable(a.symbol));
    if (indexAssets.length < 2) {
      thoughts.push("Fewer than two tradable (verified cheap-pool) Index assets in view, nothing to rotate between there yet.");
      this.momentumHoldContext = "fewer than two tradable Index tickers in view";
      return null;
    }

    const sorted = [...indexAssets].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
    const leader = sorted[0];
    const laggard = sorted[sorted.length - 1];
    const spread = (leader.changePct ?? 0) - (laggard.changePct ?? 0);

    thoughts.push(
      `Scanning tokenized equities on Robinhood Chain: ${sorted.map((a) => `${a.symbol} ${pct(a.changePct!)}`).join(", ")}.`,
    );
    thoughts.push(
      `${leader.symbol} leads at ${pct(leader.changePct!)}, ${laggard.symbol} lags at ${pct(laggard.changePct!)},` +
        ` a ${spread.toFixed(1)}-point spread.`,
    );

    if (spread < this.minIndexMomentumSpreadPct) {
      thoughts.push(
        `Below the ${this.minIndexMomentumSpreadPct}-point threshold, so no Index rotation this cycle. Checking yield-bearing assets instead.`,
      );
      this.momentumHoldContext =
        `${leader.symbol}/${laggard.symbol} spread of ${spread.toFixed(1)} points is under the ` +
        `${this.minIndexMomentumSpreadPct}-point rotation bar; a rotation would cost more than it captures`;
      return null;
    }

    const reason = `${leader.symbol} is outperforming ${laggard.symbol} by ${spread.toFixed(1)} points on Robinhood Chain`;
    const sizeUsd = config.maxTradeUsd;

    // What does the wallet ACTUALLY hold? Decisions must be sized to real
    // balances or they revert on-chain (insufficient balance) every cycle.
    // null means "couldn't check" (no signer / RPC hiccup) — keep the prior
    // best-effort rotation rather than block on an unknown.
    const held = await this.heldValuesUsd(indexAssets);
    // A rotation has to be worth its fees — dust doesn't clear that bar.
    const minRotationUsd = Math.max(20, sizeUsd * 0.25);

    if (held !== null) {
      // Rotate out of the biggest laggard the wallet meaningfully holds (not
      // necessarily THE laggard — we can only sell what we own).
      const heldSorted = sorted.filter((a) => a.symbol !== leader.symbol && (held[a.symbol] ?? 0) >= minRotationUsd);
      const rotateFrom = heldSorted[heldSorted.length - 1]; // worst-performing meaningful holding
      if (rotateFrom) {
        const rotSpread = (leader.changePct ?? 0) - (rotateFrom.changePct ?? 0);
        const blocked = this.guardTrade({ fromSymbol: rotateFrom.symbol, toSymbol: leader.symbol, spreadPts: rotSpread, thoughts });
        if (blocked) {
          this.momentumHoldContext = blocked;
          return null;
        }
        const rotateUsd = Math.min(sizeUsd, (held[rotateFrom.symbol] ?? 0) * 0.995); // real balance, minus price-move headroom
        const rotReason = `${leader.symbol} is outperforming ${rotateFrom.symbol} by ${rotSpread.toFixed(1)} points on Robinhood Chain`;
        thoughts.push(`${rotReason}. That clears the cost-aware bar and held through persistence. Rotating ${usd(rotateUsd)} of the wallet's real ${rotateFrom.symbol} holding via our own verified standard Uniswap v4 pools.`);
        return {
          timestamp,
          action: "trade", // same-chain: both legs are on Robinhood Chain
          intent: { fromAsset: rotateFrom, toAsset: leader, amountUsd: rotateUsd, reason: rotReason },
          reason: rotReason,
          thoughts,
        };
      }

      if ((held[leader.symbol] ?? 0) >= sizeUsd * 0.5) {
        const holdReason = `already positioned in ${leader.symbol} (${usd(held[leader.symbol] ?? 0)}), nothing to rotate`;
        thoughts.push(
          `${reason}, and the wallet already holds ${usd(held[leader.symbol] ?? 0)} of ${leader.symbol} with no other ` +
            `meaningful stock position to rotate out of. Holding, since buying more would just stack entries rather than rotate momentum.`,
        );
        return { timestamp, action: "hold", reason: holdReason, thoughts };
      }

      // No meaningful stock holdings at all: enter the leader fresh.
      const entryBlocked = this.guardTrade({ fromSymbol: null, toSymbol: leader.symbol, spreadPts: spread, thoughts });
      if (entryBlocked) {
        this.momentumHoldContext = entryBlocked;
        return null;
      }
      thoughts.push(
        `${reason}. That clears the cost-aware bar and held through persistence, and the wallet holds no stock position. ` +
          `Entering ${leader.symbol} directly from available funds.`,
      );
      const ethUsd = await fetchEthUsd().catch(() => null);
      const entryReason = `entering ${leader.symbol} directly from ETH (no existing stock position to rotate from)`;
      return {
        timestamp,
        action: "trade",
        intent: { fromAsset: ETH_ASSET(ethUsd ?? 0), toAsset: leader, amountUsd: sizeUsd, reason: entryReason },
        reason: entryReason,
        thoughts,
      };
    }

    // Balances unreadable this cycle — previous best-effort behavior,
    // subject to the same guards as every other trade path.
    const fallbackBlocked = this.guardTrade({ fromSymbol: laggard.symbol, toSymbol: leader.symbol, spreadPts: spread, thoughts });
    if (fallbackBlocked) {
      this.momentumHoldContext = fallbackBlocked;
      return null;
    }
    thoughts.push(`${reason}. That clears the cost-aware bar and held through persistence. Rotating ${usd(sizeUsd)} (the per-trade risk cap) via our own verified standard Uniswap v4 pools.`);
    return {
      timestamp,
      action: "trade",
      intent: { fromAsset: laggard, toAsset: leader, amountUsd: sizeUsd, reason },
      reason,
      thoughts,
    };
  }

  /**
   * The three post-churn guards, in order of cheapness. Returns null when a
   * trade may proceed, else a short hold-context string (the narration is
   * already pushed to thoughts). See config for the 2026-07-13 rationale.
   */
  private guardTrade(p: { fromSymbol: string | null; toSymbol: string; spreadPts: number; thoughts: string[] }): string | null {
    // 1. Cost-aware bar: the spread must beat a multiple of THIS pair's real
    //    round-trip pool fees. Entering from cash pays one stock leg plus at
    //    worst the 0.05% bridge; a rotation pays both stock legs.
    const legFeesPct = (p.fromSymbol ? poolFeePct(p.fromSymbol) : 0.05) + poolFeePct(p.toSymbol);
    const bar = Math.max(this.minIndexMomentumSpreadPct, config.rotationCostMultiple * legFeesPct);
    const pairKey = `${p.fromSymbol ?? "cash"}→${p.toSymbol}`;
    if (p.spreadPts < bar) {
      if (this.aboveBar?.pairKey === pairKey) this.aboveBar = null;
      p.thoughts.push(
        `${pairKey} spread of ${p.spreadPts.toFixed(1)} points is under this pair's cost-aware bar of ${bar.toFixed(1)} ` +
          `(${config.rotationCostMultiple}x its ${legFeesPct.toFixed(2)}% real round-trip fees). Not worth the toll.`,
      );
      return `${pairKey} spread ${p.spreadPts.toFixed(1)}pts is under its cost-aware bar of ${bar.toFixed(1)}pts`;
    }

    // 2. Cooldown: one trade per window, read from the durable executions
    //    ledger so a restart can't forget this morning's trade.
    const last = lastSuccessfulTradeTs();
    const cooldownMs = config.rotationCooldownHours * 3_600_000;
    if (last != null && Date.now() - last < cooldownMs) {
      const hoursLeft = (last + cooldownMs - Date.now()) / 3_600_000;
      p.thoughts.push(
        `${pairKey} clears its bar, but the one-trade-per-${config.rotationCooldownHours}h cooldown has ` +
          `${hoursLeft.toFixed(1)}h left. Fees compound faster than signals repeat.`,
      );
      return `post-trade cooldown, ${hoursLeft.toFixed(1)}h remaining`;
    }

    // 3. Persistence: the spread must hold above the bar continuously before
    //    any fee is spent — a one-tick opening gap resets nothing but proves
    //    nothing either.
    const now = Date.now();
    if (this.aboveBar?.pairKey !== pairKey) this.aboveBar = { pairKey, since: now };
    const heldMinutes = (now - this.aboveBar.since) / 60_000;
    if (heldMinutes < config.rotationPersistenceMinutes) {
      p.thoughts.push(
        `${pairKey} clears its ${bar.toFixed(1)}pt bar — persistence check at ${Math.floor(heldMinutes)}/${config.rotationPersistenceMinutes}min ` +
          `before committing real fees, so a single spike can't spend money.`,
      );
      return `signal persistence ${Math.floor(heldMinutes)}/${config.rotationPersistenceMinutes}min on ${pairKey}`;
    }
    return null;
  }

  private evaluateAprRotation(assets: RwaAsset[], timestamp: number, thoughts: string[]): AgentDecision {
    const yieldBearing = assets.filter((a) => a.aprBps != null);
    if (yieldBearing.length < 2) {
      // Lead with why MOMENTUM held (the branch that actually scanned a
      // market); the empty yield universe is the footnote, not the headline.
      const reason = this.momentumHoldContext ?? "fewer than two yield-bearing assets to compare";
      thoughts.push(`Only ${yieldBearing.length} yield-bearing asset(s) in view, nothing to rotate between.`);
      return { timestamp, action: "hold", reason, thoughts };
    }

    const sorted = [...yieldBearing].sort((a, b) => (b.aprBps ?? 0) - (a.aprBps ?? 0));
    const best = sorted[0];
    const current = sorted[1];
    const improvement = (best.aprBps ?? 0) - (current.aprBps ?? 0);

    thoughts.push(
      `Comparing yield-bearing assets: ${sorted.map((a) => `${a.symbol} ${bps(a.aprBps ?? 0)}`).join(", ")}.`,
    );

    if (improvement < this.minAprImprovementBps) {
      const reason = `spread of ${improvement} bps (${best.symbol} over ${current.symbol}) doesn't clear the ${this.minAprImprovementBps} bps threshold`;
      thoughts.push(`Best spread is ${improvement} bps, below the ${this.minAprImprovementBps} bps threshold, holding.`);
      return { timestamp, action: "hold", reason, thoughts };
    }

    const reason = `${best.symbol} yields ${improvement} bps more than ${current.symbol}`;
    thoughts.push(`${reason}. That clears the threshold, rotating.`);

    return {
      timestamp,
      action: current.chain === best.chain ? "trade" : "bridge_and_trade",
      intent: { fromAsset: current, toAsset: best, amountUsd: 0, reason },
      reason,
      thoughts,
    };
  }
}
