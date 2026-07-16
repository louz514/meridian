/**
 * Backtest for Meridian's IndexYieldStrategy — REAL distribution history from
 * theindex.finance's own /live and /indexer endpoints (data/distributions.json,
 * fetched 2026-07-11: 196 real distribution events over a ~54.1-hour window —
 * the full history retrievable at fetch time; the product is ~4 months old).
 *
 * What this measures: the DISTRIBUTION YIELD alone (a holder's share of the 3%
 * entry/exit fee other traders pay into the ETH<->$INDEX pool), holding
 * $INDEX's own price flat, since no historical $INDEX/ETH price series was
 * available — only the distribution-event log. This isolates the mechanic
 * IndexYieldStrategy actually reasons over; it is NOT a full price-return
 * backtest like the retired momentum one (simulate.legacy-momentum.ts).
 *
 * Because both the entry/exit fee and a holder's distribution share are flat
 * percentages of position size, the resulting % returns are size-invariant —
 * a $100 position and a $1M position realize the same %. $10,000 is used
 * purely for readable dollar figures.
 *
 * The headline risk this backtest is built to confront: the observed rate is
 * from a 54-hour sample of a young, small (~$3.6M mcap) token, and the "yield"
 * is funded by other traders' fees, not external revenue — see the sensitivity
 * table (section B) for how much of that rate can evaporate before the
 * strategy stops clearing its own entry/exit fee.
 *
 * Run: npm run backtest
 */
import { readFileSync } from "node:fs";

interface DistEvent { timestamp: number; totalUsd: number; holders: number | null }
interface Fixture {
  events: DistEvent[];
  ethUsdAtFetch: number;
  indexPriceUsdAtFetch: number;
  eligibilityThresholdTokens: number;
  eligibleSupplyTokensAtFetch: number;
  totalSupplyTokens: number;
  entryFeePct: number;
}
const fixture = JSON.parse(
  readFileSync(new URL("./data/distributions.json", import.meta.url), "utf8"),
) as Fixture;

const EVENTS = fixture.events;
const WINDOW_START = EVENTS[0].timestamp;
const WINDOW_END = EVENTS[EVENTS.length - 1].timestamp;
const WINDOW_DAYS = (WINDOW_END - WINDOW_START) / 86400;
const FEE = fixture.entryFeePct / 100;

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const usd = (n: number) => {
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1 || n === 0) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`; // sub-dollar (the $INDEX token itself trades in fractions of a cent)
};

/**
 * Simulates entering at the window start, holding through every real event,
 * and (optionally) exiting at window end. `rateMultiplier` scales each
 * event's payout — the lever for the sensitivity table (section B).
 *
 * Deliberately reports THREE separate numbers rather than one blended
 * "annualized return," because blending them is where this kind of backtest
 * usually goes wrong:
 *   - netPct: what actually happened in this exact real window (includes the
 *     one-time fee honestly).
 *   - annualizedYieldOnlyPct: the recurring distribution rate alone,
 *     annualized LINEARLY (not compounded — a distribution pays out stock
 *     tokens, not more $INDEX, so nothing here automatically reinvests).
 *     Compounding this would overstate it hugely for no real reason.
 *   - breakevenDays: from the daily yield rate alone, independent of whether
 *     THIS window happened to run long enough to clear the fee. Naively
 *     compounding a window that includes a one-time fee (as an earlier
 *     version of this file did) makes a strong real rate look catastrophic
 *     just because the sample window is close to the breakeven point —
 *     that's a methodology bug, not a finding.
 */
function simulate(initialUsd: number, rateMultiplier: number, exitAtEnd: boolean) {
  const entryFee = initialUsd * FEE;
  const positionUsd0 = initialUsd - entryFee;
  const positionTokens = positionUsd0 / fixture.indexPriceUsdAtFetch;
  const share = positionTokens / fixture.eligibleSupplyTokensAtFetch;

  let distributedUsd = 0;
  for (const ev of EVENTS) distributedUsd += ev.totalUsd * share * rateMultiplier;

  // price held flat (no historical $INDEX/ETH series) — see file header.
  let endPositionUsd = positionUsd0;
  let exitFee = 0;
  if (exitAtEnd) {
    exitFee = endPositionUsd * FEE;
    endPositionUsd -= exitFee;
  }

  const finalUsd = endPositionUsd + distributedUsd;
  const netPct = (finalUsd / initialUsd - 1) * 100;

  const dailyYieldPct = (distributedUsd / initialUsd) * 100 / WINDOW_DAYS;
  const annualizedYieldOnlyPct = dailyYieldPct * 365;
  const roundTripFeePct = (exitAtEnd ? 2 : 1) * FEE * 100;
  const breakevenDays = dailyYieldPct > 0 ? roundTripFeePct / dailyYieldPct : Infinity;

  return { entryFee, exitFee, distributedUsd, finalUsd, netPct, annualizedYieldOnlyPct, breakevenDays };
}

console.log("");
console.log("Meridian IndexYieldStrategy backtest — REAL $INDEX distribution events");
console.log(
  `  window ${new Date(WINDOW_START * 1000).toISOString()} -> ${new Date(WINDOW_END * 1000).toISOString()} ` +
    `(${WINDOW_DAYS.toFixed(2)} days, ${EVENTS.length} real distribution events)`,
);
console.log(
  `  $INDEX ${usd(fixture.indexPriceUsdAtFetch)} · eligible supply ${(fixture.eligibleSupplyTokensAtFetch / 1e6).toFixed(1)}M ` +
    `of ${(fixture.totalSupplyTokens / 1e6).toFixed(0)}M tokens (${((fixture.eligibleSupplyTokensAtFetch / fixture.totalSupplyTokens) * 100).toFixed(1)}%) ` +
    `· entry/exit fee ${fixture.entryFeePct}%`,
);
console.log("");

const INITIAL = 10_000;

console.log(`A) Observed rate, $${INITIAL.toLocaleString()} position (returns are size-invariant — see file header):`);
console.log("   " + "".padEnd(22) + "window net    yield only, /yr*  breakeven vs fee");
for (const [label, exitAtEnd] of [["hold (never exit)", false], ["exit at window end", true]] as const) {
  const r = simulate(INITIAL, 1, exitAtEnd);
  console.log(
    "   " +
      label.padEnd(22) +
      pct(r.netPct).padEnd(14) +
      pct(r.annualizedYieldOnlyPct).padEnd(17) +
      (isFinite(r.breakevenDays) ? `${r.breakevenDays.toFixed(1)}d` : "never"),
  );
}
console.log(`   entry fee paid: ${usd(simulate(INITIAL, 1, false).entryFee)} · distributions collected: ${usd(simulate(INITIAL, 1, false).distributedUsd)}`);
console.log("   *yield only, linearly annualized (rate x 365) — excludes the one-time entry/exit fee, and assumes no");
console.log("    reinvestment (distributions pay stock tokens, not more $INDEX). Illustrative, not a forecast: see (B).");
console.log("");

console.log("B) Sensitivity — what if the observed rate doesn't hold (the real risk: young token, fee-funded not organic):");
console.log("   " + "rate assumed".padEnd(22) + "window net    yield only, /yr*  breakeven vs 6% round trip");
for (const mult of [1, 0.5, 0.25, 0.1]) {
  const r = simulate(INITIAL, mult, true);
  console.log(
    "   " +
      `${(mult * 100).toFixed(0)}% of observed`.padEnd(22) +
      pct(r.netPct).padEnd(14) +
      pct(r.annualizedYieldOnlyPct).padEnd(17) +
      (isFinite(r.breakevenDays) ? `${r.breakevenDays.toFixed(1)}d` : "never recovers fee"),
  );
}
console.log("");

console.log("C) The 196 real events aren't smooth — largest and smallest single payouts observed:");
const sorted = [...EVENTS].sort((a, b) => b.totalUsd - a.totalUsd);
console.log(`   largest:  ${usd(sorted[0].totalUsd)} (${sorted[0].holders} holders)`);
console.log(`   smallest: ${usd(sorted[sorted.length - 1].totalUsd)} (${sorted[sorted.length - 1].holders} holders)`);
console.log(`   median:   ${usd(sorted[Math.floor(sorted.length / 2)].totalUsd)}`);
console.log("");
