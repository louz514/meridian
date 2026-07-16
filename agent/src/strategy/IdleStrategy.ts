import type { AgentDecision, RwaAsset } from "../types.js";
import type { Strategy } from "./Strategy.js";

/**
 * Deliberately does nothing — always holds. Swapped in for IndexYieldStrategy
 * (2026-07-11) after its in-memory position tracking, combined with tsx
 * watch's auto-restart-on-file-save during live debugging, caused repeated
 * uncontrolled autonomous re-entry attempts (one landed for real: 68,702.5
 * $INDEX bought with real ETH). That position is untouched and still real —
 * this strategy just stops the automated loop from deciding anything further
 * while a real replacement approach (session-gap/cross-venue execution edge,
 * not yield-holding) gets designed. IndexYieldStrategy.ts is kept, not
 * deleted, pending that redesign — same dormant-not-removed pattern as
 * MomentumStrategy.
 */
export class IdleStrategy implements Strategy {
  readonly name = "idle-no-active-strategy";

  async evaluate(_assets: RwaAsset[]): Promise<AgentDecision> {
    return {
      timestamp: Date.now(),
      action: "hold",
      reason: "no active trading strategy — awaiting redesign",
      thoughts: [
        "No active strategy is running right now. The agent is only observing live data, not deciding or trading.",
      ],
    };
  }
}
