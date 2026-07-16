import type { AgentDecision, RwaAsset } from "../types.js";
import type { Strategy } from "./Strategy.js";
import { lpPositionsWithValue } from "../venues/lpPositions.js";
import { phaseOf } from "../lpGuard.js";

/**
 * The public "thoughts" narrator for the house agent, matched to what it
 * ACTUALLY does: market-making, not momentum rotation. It reads the real LP
 * position(s) and the market phase and narrates the market-maker's reasoning —
 * pool, range, in/out-of-range, and what it's watching. Narrate-only: it always
 * returns `hold` (the real re-center / widen / pull actions live in lpGuard),
 * so it never triggers execution even if live trading were enabled.
 *
 * This exists because the live desk was streaming a legacy momentum strategy's
 * reasoning while the wallet was doing LP market-making — a contradiction with
 * the whole product. Now the feed tells the truth.
 */
export class MarketMakingStrategy implements Strategy {
  readonly name = "market-maker";

  async evaluate(_assets: RwaAsset[]): Promise<AgentDecision> {
    const now = new Date();
    const phase = phaseOf(now);
    const timestamp = Date.now();
    const thoughts: string[] = [];

    let positions: Awaited<ReturnType<typeof lpPositionsWithValue>> = [];
    try {
      positions = await lpPositionsWithValue();
    } catch {
      thoughts.push("Reading LP positions from Robinhood Chain…");
      return { timestamp, action: "hold", reason: "reading on-chain state", thoughts };
    }

    if (positions.length === 0) {
      if (phase === "weekday-market") {
        thoughts.push("No open LP position during market hours. Re-establishing a concentrated range so the wallet starts earning the swap fee again.");
        return { timestamp, action: "hold", reason: "flat during market hours — re-establishing a range", thoughts };
      }
      thoughts.push("No open LP position, and it's outside market hours. Staying flat: off-hours moves are informed, so chasing them is adverse selection.");
      return { timestamp, action: "hold", reason: "flat, off-hours — staying out by design", thoughts };
    }

    for (const p of positions) {
      thoughts.push(
        `Making markets in ${p.symbol}/USDG: a ±${p.rangePct.toFixed(1)}% band, ~$${p.valueUsd.toFixed(0)} working. ` +
          (p.inRange
            ? "In range, earning the fee on every swap through the pool."
            : "Price has walked out of the range, so it's idle right now, watching whether to re-center."),
      );
    }

    thoughts.push(
      phase === "weekend"
        ? "Weekend mode: running a wider band to keep harvesting arb churn while the position is harder to pick off, and pulling out entirely if price drifts far enough to signal real news."
        : phase === "weekday-market"
          ? "Market hours: tight band for maximum fee density, re-centering if price sits out of range for more than 30 minutes."
          : "Off-hours: holding the position as-is rather than chasing informed moves, and sweeping any owed fees.",
    );

    const anyOut = positions.some((p) => !p.inRange);
    return {
      timestamp,
      action: "hold",
      reason: anyOut ? "out of range — monitoring to re-center" : "in range, harvesting fees",
      thoughts,
    };
  }
}
