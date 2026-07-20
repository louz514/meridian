import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";

const LEDGER_PATH = dataPath("revenue.jsonl");

/**
 * Durable revenue ledger for x402-gated tool calls. Every verified payment
 * appends a row (tool, amount, settlement tx) and totals are rebuilt from
 * the file at boot — revenue history survives restarts and redeploys, and
 * each row is independently checkable against the chain via its tx hash.
 */
export class RevenueLedger {
  private totalUsd = 0;
  private byTool: Record<string, number> = {};

  constructor() {
    if (!existsSync(LEDGER_PATH)) return;
    for (const line of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { tool: string; amountUsd: number };
        this.totalUsd += r.amountUsd;
        this.byTool[r.tool] = (this.byTool[r.tool] ?? 0) + r.amountUsd;
      } catch {}
    }
  }

  record(tool: string, amountUsd: number, reference?: string): void {
    this.totalUsd += amountUsd;
    this.byTool[tool] = (this.byTool[tool] ?? 0) + amountUsd;
    appendLedger("revenue.jsonl", { ts: Date.now(), tool, amountUsd, ...(reference ? { reference } : {}) });
  }

  get totalRevenueUsd(): number {
    return this.totalUsd;
  }

  get revenueByTool(): Record<string, number> {
    return { ...this.byTool };
  }
}
