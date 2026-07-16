import type { AgentDecision } from "./types.js";

export interface LoggedDecision extends AgentDecision {
  strategy: string;
}

/**
 * Recent-decisions ring buffer — what the live "agent thoughts" monitor
 * (frontend poll + meridian_agent_thoughts tool) reads from. Process-local,
 * same disposable-on-restart shape as RiskLimiter/RevenueLedger; this is a
 * transparency feed, not a durable audit trail.
 */
export class DecisionLog {
  private entries: LoggedDecision[] = [];

  constructor(private capacity = 50) {}

  /** Returns the stored entry so a caller can attach `execution` once a real trade attempt resolves. */
  record(strategy: string, decision: AgentDecision): LoggedDecision {
    const entry: LoggedDecision = { strategy, ...decision };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    return entry;
  }

  /** Most recent first. */
  recent(limit = 20): LoggedDecision[] {
    return this.entries.slice(-limit).reverse();
  }
}
