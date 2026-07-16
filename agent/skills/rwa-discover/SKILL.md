---
name: rwa-discover
description: Broad search to find NEW venues in your assigned RWA market segment. Expensive — only run on your discover schedule, not on every wake.
---

# RWA segment discovery (expensive — run rarely)

You are one specialist in Meridian's RWA research fleet. Your assigned
segment and its known anchor venues are set in your `segment` instruction.

This is the **discovery** pass — the expensive half of your job. Its only
goal is finding venues Meridian doesn't know about yet. Run it only when your
schedule fires it, not on every wake. Your `rwa-refresh` skill handles the
cheap, frequent re-checks of venues you've already found — don't duplicate
that work here.

## Budget

Cap yourself at roughly **20 searches/fetches this run**. If you're still
finding new venues past that, stop anyway and let the next scheduled run
continue — breadth over many runs beats one unbounded run.

## Procedure

1. **Check what's already known.** Call
   `mcp__meridian__meridian_market_universe` filtered to your segment first.
   Don't re-report venues already there with unchanged data — only submit a
   venue if it's new, or if you have materially different data than what's
   stored.

2. **Search broadly.** Use web search and page fetches to find venues beyond
   your anchor list — aim for breadth (15+ where they exist). Aggregators
   like rwa.xyz and DefiLlama's RWA category are efficient starting points
   (one or two fetches can surface many candidate names); spend the rest of
   your budget verifying and enriching the ones that look real, not on
   exhaustive independent search.

3. **Enrich each new venue** with what you can find in one or two fetches:
   chains, what it tokenizes, approximate TVL/AUM (with an as-of date),
   typical yield/APR, on-chain tickers, custody model, access model
   (permissionless / KYC / accredited / institutional-only), jurisdiction.

3b. **Capture the signal data points** — these are what Meridian's sellable
   signal is built on, so they matter more than nice-to-have descriptive
   fields. Where you can find them cheaply:
   - **Flows**: `tvlTrend` (rising/falling/stable) and `prevTvlUsd` — is
     capital entering or leaving? The strongest single RWA signal.
   - **Yield momentum**: `yieldTrend` and `prevYieldPct` — the direction of
     the rate, not just today's level.
   - **Liquidity**: `liquidityUsd` and `volumeUsd24h` — thin liquidity caps
     how actionable any signal is.
   - **Risk**: `riskFlags` (e.g. `depeg-history`, `redemption-gate`,
     `unaudited`, `single-issuer`), `redemptionTerms`, `feeStructure`,
     `listingDate`.
   Leave the `signal*` fields alone — those are set later by the deliberation
   panel, not by you. Same rule as everything else: omit what you can't find
   rather than guessing.

4. **Assess integration path** — the field the trading agent cares about
   most: how could Meridian pull this venue's data or route liquidity? Set
   `dataSourceType` to one of `rest-api`, `graphql-subgraph`,
   `onchain-contract`, `oracle`, `csv-dashboard`, or `none-scrape-only`, with
   specifics in `integrationNotes`.

5. **Cite sources and rate confidence.** Every venue needs at least one
   source URL — this also becomes the URL your `rwa-refresh` pass will use
   later, so prefer the venue's own primary page over a secondary mention.

6. **Submit** via `mcp__meridian__meridian_submit_research` with
   `submittedBy` set to your own agent id.

Don't fabricate numbers you couldn't find — omit the field or mark it `low`
confidence rather than guessing. A missing TVL is more useful to the trading
agent than a wrong one.
