export type ChainId = "solana" | "ethereum" | "base" | "polygon" | "robinhood";

export interface RwaAsset {
  id: string;
  symbol: string;
  name: string;
  chain: ChainId;
  priceUsd: number;
  aprBps?: number;
  /** 24h price change, percent — set on price-driven assets (e.g. Index equities) instead of aprBps. */
  changePct?: number;
}

export interface TradeIntent {
  fromAsset: RwaAsset;
  toAsset: RwaAsset;
  amountUsd: number;
  reason: string;
}

export interface AgentDecision {
  timestamp: number;
  // enter_index/hold_index/exit_index: the $INDEX distribution-yield strategy's
  // postures (see strategy/IndexYieldStrategy.ts) — distinct from a stock-to-stock
  // "trade" because the counter-asset is always ETH, never another Index ticker.
  action: "hold" | "bridge_and_trade" | "trade" | "enter_index" | "hold_index" | "exit_index";
  intent?: TradeIntent;
  reason: string;
  /** Step-by-step reasoning that led to this decision, in order — what a live monitor shows. */
  thoughts: string[];
  /** Real position/P&L snapshot for a live UI stat card — set by IndexYieldStrategy, absent for other strategies. */
  position?: PositionSnapshot;
  /** Set once something actually tries to act on this decision — absent for pure holds/advisory calls. Distinguishes "the agent decided X" from "X actually happened on-chain." */
  execution?: ExecutionOutcome;
}

export interface ExecutionOutcome {
  success: boolean;
  txHash?: string;
  amountReceived?: number;
  error?: string;
}

export interface PositionSnapshot {
  inPosition: boolean;
  entryCostUsd?: number;
  distributionsUsd?: number;
  indexValueUsd?: number;
  netPnlUsd?: number;
  netPnlPct?: number;
  stopLossPct: number;
  profitTakePct: number;
}

export interface BridgeResult {
  success: boolean;
  sourceChain: ChainId;
  destChain: ChainId;
  txHashSource?: string;
  txHashDest?: string;
  error?: string;
}

export interface PaymentReceipt {
  success: boolean;
  amountUsd: number;
  payer: string;
  facilitator: string;
  reference?: string;
  error?: string;
}
