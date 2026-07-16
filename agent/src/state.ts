import { MarketData } from "./marketData.js";
import { IndexYieldData } from "./indexYield.js";
import { IndexYieldStrategy } from "./strategy/IndexYieldStrategy.js";
import { MomentumStrategy } from "./strategy/MomentumStrategy.js";
import { WormholeBridge } from "./bridge/WormholeBridge.js";
import { IndexTrader } from "./venues/IndexTrader.js";
import { X402Client } from "./payments/X402Client.js";
import { RiskLimiter } from "./risk.js";
import { DecisionLog } from "./decisionLog.js";
import { getUniverseStore } from "./research/universe.js";
import { config } from "./config.js";

/**
 * Shared singletons — one instance per process, used by both the MCP tool
 * surface (mcp/server.ts) and the background agent loop (agentLoop.ts) so
 * they're reasoning over and logging to the same state, not two disconnected
 * copies.
 */
export const market = new MarketData();
export const indexYieldData = new IndexYieldData();
// The ACTIVE strategy the autonomous loop runs and meridian_suggest_route
// queries — stock-to-stock momentum rotation via stockPools.ts's verified
// cheap pools (2026-07-11 reactivation, see MomentumStrategy.ts's header).
export const strategy = new MomentumStrategy();
// A SEPARATE instance, not the active strategy above — tracks the $INDEX
// distribution-yield position independently, for the still-valid manual
// meridian_index_yield_execute path (executeIndexYieldTrade.ts). Kept
// distinct so switching the autonomous loop's active strategy doesn't lose
// track of a manually-entered $INDEX position.
export const indexYieldStrategy = new IndexYieldStrategy(indexYieldData);
export const bridge = new WormholeBridge(config.wormholeRpcUrl);
export const indexTrader = new IndexTrader(config.robinhoodRpcUrl);
export const x402 = new X402Client(config.x402FacilitatorUrl);
export const risk = new RiskLimiter();
export const universe = getUniverseStore();
export const decisionLog = new DecisionLog();
