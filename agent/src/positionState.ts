// Persisted position state for the $INDEX yield strategy — the actual root
// cause of the 2026-07-11 incident wasn't the strategy logic, it was that
// position state lived only in process memory: every restart (including tsx
// watch's auto-restart on file save) forgot a real, on-chain position and
// re-proposed entering from scratch. This survives restarts by writing to
// disk, so "what does the agent think it holds" always matches reality.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dataPath } from "./dataDir.js";

export interface PositionState {
  inPosition: boolean;
  /** real USD spent to enter (actual swap cost, not a nominal size) */
  entryCostUsd: number;
  /** exact $INDEX tokens received at entry (from the real swap's Transfer log) */
  entryIndexTokens: number;
  /** each of the 18 stock-token balances at entry, so later reads can diff to find distributions actually received */
  entryStockBalances: Record<string, number>;
  enteredAt: number | null;
}

const DEFAULT_STATE: PositionState = {
  inPosition: false,
  entryCostUsd: 0,
  entryIndexTokens: 0,
  entryStockBalances: {},
  enteredAt: null,
};

const STATE_PATH = process.env.MERIDIAN_POSITION_STATE_PATH ?? dataPath("position-state.json");

export function loadPositionState(): PositionState {
  if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function savePositionState(state: PositionState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
