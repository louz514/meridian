import { config } from "./config.js";

/** Routing fee for an x402-settled execution, in USD — bps of trade notional. */
export function routingFeeUsd(notionalUsd: number): number {
  return Math.round(notionalUsd * (config.bridgeFeeBps / 10_000) * 100) / 100;
}
