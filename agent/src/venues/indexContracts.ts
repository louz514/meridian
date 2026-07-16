/**
 * Real contract addresses for The Index (https://theindex.finance) —
 * tokenized equities on Robinhood Chain, traded via Uniswap v4. Source:
 * https://theindex.finance/#/docs. Not fabricated placeholders.
 */
export const INDEX_CONTRACTS = {
  universalRouter: "0xE28c0e44F4016b073db20cF28971CAc6ce3664D3",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  // $INDEX (the fund token) and the product-specific swap path for it — distinct
  // from universalRouter/tokens below, which are the per-stock secondary
  // markets. Confirmed on-chain 2026-07-11 by reading theindex.finance's own
  // compiled frontend (VITE_* build-time config) plus the pool's live fee tier.
  indexToken: "0x56910D4409F3a0C78C64DD8D0545FF0705389870",
  indexSwapRouter: "0xAF305d053f46338904Ba1fE52940D5724f6C24d1",
  indexFeeHook: "0x2cD91bD228ff4c537031d6b8204782090c84c0cC", // collects the confirmed 3% ETH fee
  // A SEPARATE verified UniversalRouter deployment from the one above —
  // confirmed 2026-07-11 by decoding real successful ETH<->$INDEX swaps
  // on-chain (Blockscout names it "UniversalRouter" too, is_verified=true).
  // `universalRouter` above (from theindex.finance's own docs) does not work
  // for this specific hook-gated pool: a real attempt through it reverted;
  // this address is what real traders' transactions actually call.
  indexUniversalRouter: "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77",
  // All 18 live Index token addresses (theindex.finance/#/docs).
  tokens: {
    AAPL: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
    AMD: "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
    AMZN: "0x12f190a9f9d7d37a250758b26824b97ce941bf54",
    BE: "0x822cc93ffd030293e9842c30bbd678f530701867",
    COIN: "0x6330d8c3178a418788df01a47479c0ce7ccf450b",
    CRWV: "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3",
    GOOGL: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
    INTC: "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681",
    META: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
    MSFT: "0xe93237c50d904957cf27e7b1133b510c669c2e74",
    MU: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd",
    NVDA: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    ORCL: "0xb0992820e760d836549ba69bc7598b4af75dee03",
    PLTR: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
    SNDK: "0xb90a19ff0af67f7779aff50a882a9cff42446400",
    SPCX: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
    TSLA: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
    USAR: "0xd917b029c761d264c6a312bbbcda868658ef86a6",
  } as Record<string, string>,
};

export interface IndexTradeResult {
  success: boolean;
  venue: "the-index";
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
  txHash?: string;
  /** exact tokens received (decoded from the real Transfer log), when known — see positionAccounting.ts */
  amountReceived?: number;
  error?: string;
}
