import { config } from "./config.js";

/**
 * Server-side spend guard. The OpenHermit agent decides *what* to trade; these
 * caps are enforced here so a prompt can never talk the tools past them.
 * Deliberately simple (process-local, resets on restart) — swap in a durable
 * store when Meridian custodies real value.
 */
export class RiskLimiter {
  private dailySpentUsd = 0;

  /** Clamp a requested notional to the per-trade cap. */
  size(requestedUsd: number): number {
    const wanted = requestedUsd > 0 ? requestedUsd : config.maxTradeUsd;
    return Math.min(wanted, config.maxTradeUsd);
  }

  /** Whether `amountUsd` fits under the remaining daily budget. */
  check(amountUsd: number): { ok: boolean; reason?: string } {
    if (this.dailySpentUsd + amountUsd > config.maxDailyUsd) {
      return {
        ok: false,
        reason: `daily limit reached ($${this.dailySpentUsd}/$${config.maxDailyUsd})`,
      };
    }
    return { ok: true };
  }

  record(amountUsd: number): void {
    this.dailySpentUsd += amountUsd;
  }

  get spentTodayUsd(): number {
    return this.dailySpentUsd;
  }
}
