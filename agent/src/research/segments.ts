/**
 * The RWA market taxonomy. This is the source of truth for the research
 * orchestration: each segment becomes one OpenHermit research agent (see
 * orchestration.ts), and the same list seeds the bootstrap research sweep.
 *
 * Two cadences per segment, deliberately decoupled because they have very
 * different costs:
 *  - discoverCadenceCron: broad web search to find NEW venues. Expensive
 *    (many searches/fetches), so it runs rarely (weekly-ish).
 *  - refreshCadenceCron: re-check ALREADY-KNOWN venues' numbers via their own
 *    known source URLs. Cheap (targeted fetches, no open-ended search), so it
 *    can run often — but only as often as the underlying number actually
 *    moves. Omit it for segments where discovery and refresh are effectively
 *    the same act (aggregators).
 *
 * To cover a new corner of the RWA market, add a segment here — the fleet
 * provisioner will create/patch the agent for it on the next run.
 */
export interface RwaSegment {
  /** stable id, used as the OpenHermit agent id suffix: `rwa-research-<key>` */
  key: string;
  title: string;
  /** known venues the research agent must exceed, not stop at */
  anchors: string;
  discoverCadenceCron: string;
  refreshCadenceCron?: string;
}

export const SEGMENTS: RwaSegment[] = [
  { key: "treasuries", title: "Tokenized US Treasuries & T-bills", anchors: "Ondo (OUSG/USDY), BlackRock BUIDL, Franklin Templeton BENJI, Superstate, Hashnote, OpenEden, Backed, Matrixdock", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * *" },
  { key: "private-credit", title: "Private credit & on-chain lending of real-world loans", anchors: "Maple, Centrifuge, Goldfinch, Credix, TrueFi, Clearpool, Huma", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * *" },
  { key: "real-estate", title: "Tokenized real estate", anchors: "RealT, Lofty, Propy, Tangible, Parcl, RedSwan", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1,4" },
  { key: "equities", title: "Tokenized public equities / stocks", anchors: "Backed (bTokens), Dinari, Swarm, Ondo Global Markets, Robinhood tokenized stocks, xStocks/Kraken, Securitize", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 */4 * * *" },
  { key: "commodities", title: "Tokenized commodities (gold, metals, energy)", anchors: "PAX Gold (PAXG), Tether Gold (XAUT), Kinesis, Comtech Gold", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 */4 * * *" },
  { key: "mmf", title: "Tokenized money market funds & cash-equivalents", anchors: "BlackRock BUIDL, Franklin BENJI, WisdomTree, Circle USYC/Hashnote, Ondo", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * *" },
  { key: "bonds", title: "Tokenized corporate & municipal bonds", anchors: "Obligate, Bondblox, Swarm bonds, private issuers", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1,4" },
  { key: "trade-finance", title: "Trade finance, invoice factoring & receivables", anchors: "Centrifuge, Huma, Credix, Polytrade, Defactor", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1,4" },
  { key: "carbon", title: "Carbon credits & environmental assets", anchors: "Toucan, KlimaDAO, Flowcarbon, Moss", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1" },
  { key: "funds", title: "Tokenized funds (VC/PE/hedge) & structured products", anchors: "Securitize, Hamilton Lane, Apollo/ACRED, Fidelity, ADDX, Libre", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1" },
  { key: "aggregators", title: "RWA data aggregators, indices & oracles", anchors: "rwa.xyz, DefiLlama RWA, Chainlink, Redstone, Steakhouse, Dune RWA dashboards", discoverCadenceCron: "0 */6 * * *" },
  { key: "infra", title: "Cross-chain RWA infrastructure: issuance rails, chains, bridges", anchors: "Securitize, Chainlink CCIP, Wormhole, LayerZero, Provenance, Plume, Canton, Ondo Chain", discoverCadenceCron: "0 6 * * 1", refreshCadenceCron: "0 8 * * 1" },
];

export const segmentByKey = (key: string): RwaSegment | undefined =>
  SEGMENTS.find((s) => s.key === key);
