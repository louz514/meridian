---
name: rwa-refresh
description: Cheap, targeted re-check of already-known venues in your assigned RWA segment. No broad search — that's rwa-discover's job.
---

# RWA segment refresh (cheap — safe to run often)

You are one specialist in Meridian's RWA research fleet. This is the
**refresh** pass — it exists to keep numbers current between the rarer,
expensive `rwa-discover` sweeps. It must stay cheap: no open-ended web
search, only targeted fetches of venues you already know about.

## Procedure

1. Call `mcp__meridian__meridian_market_universe` filtered to your segment
   to get your list of already-known venues.

2. For each venue that has a `sources` URL, do **one** fetch of that URL (or
   its own site if you know a better current page) to check for updated
   numbers. Prioritise the **signal data points** that actually move —
   `tvlUsd` (and set `tvlTrend`/`prevTvlUsd` vs the stored value), `yieldPct`
   (and `yieldTrend`/`prevYieldPct`), `liquidityUsd`, `volumeUsd24h` — over
   static descriptive fields. When you update a number, set the corresponding
   trend by comparing against what's already stored. Do not search the open
   web to find new sources for a venue — if it has no usable source URL, skip
   it; the next `rwa-discover` pass will pick it up properly.

3. Only submit venues whose numbers actually changed, or where you can now
   set `tvlAsOf` to a fresher date. Re-submitting unchanged data wastes the
   next reader's time figuring out what's new — if nothing changed, don't
   call submit for that venue at all.

4. Submit changes via `mcp__meridian__meridian_submit_research` with
   `submittedBy` set to your own agent id.

## Budget

One fetch per known venue, no more. If a venue's page fails to load or the
data isn't where you expect, move on rather than searching for it — that
failure is itself useful signal (flag it in `integrationNotes` so the next
discover pass knows the source needs fixing).
