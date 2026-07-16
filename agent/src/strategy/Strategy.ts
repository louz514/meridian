import type { AgentDecision, RwaAsset } from "../types.js";

export interface Strategy {
  readonly name: string;
  // async: IndexYieldStrategy reasons over live theindex.finance endpoints, not
  // just the in-process asset snapshot.
  evaluate(assets: RwaAsset[]): Promise<AgentDecision>;
}
