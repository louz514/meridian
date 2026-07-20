// Scout-to-earn: a signed-in user sends THEIR agent hunting for a tokenized-RWA
// venue the research universe doesn't know yet. A validated, genuinely novel
// find is upserted into the same universe the fleet feeds (credited
// scout:<wallet>) and accrues a small USDG bounty against the treasury.
// Attribution is the SIWE session the route already proved — never a value the
// model claims — so a prompt-injected agent can misdescribe a venue but cannot
// redirect whose bounty it is. Accrual is capped per wallet and per day;
// settlement is a deliberate operator action through the same circuit-breaker
// the house wallet's own ops run under.
import { existsSync, readFileSync } from "node:fs";
import { parseAbiItem } from "viem";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { config } from "../config.js";
import { messageUserAgent, agentDisplayName } from "../deploy/myAgent.js";
import { getUniverseStore, isKnownVenue, type Venue } from "../research/universe.js";
import { SEGMENTS } from "../research/segments.js";
import { getPublicClient, getWalletClient } from "../venues/signer.js";
import { guardWalletOp, recordWalletOp } from "../risk.js";
import { withHouseWalletLock } from "../houseWallet.js";
import { USDG } from "../venues/stockPools.js";

const LOG = "bounties.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;

interface BountyRow {
  ts: number;
  kind: "scout" | "payout";
  wallet: string;
  status: "accrued" | "duplicate" | "invalid" | "paid";
  amountUsd: number;
  name?: string;
  url?: string;
  segment?: string;
  txHash?: string;
  covering?: number;
}

function readRows(): BountyRow[] {
  try {
    const p = dataPath(LOG);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as BountyRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is BountyRow => !!r && typeof r.ts === "number" && typeof r.wallet === "string");
  } catch {
    return [];
  }
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function walletBalanceUsd(rows: BountyRow[], wallet: string): number {
  const w = wallet.toLowerCase();
  let bal = 0;
  for (const r of rows) {
    if (r.wallet !== w) continue;
    if (r.kind === "scout" && r.status === "accrued") bal += r.amountUsd;
    if (r.kind === "payout" && r.status === "paid") bal -= r.amountUsd;
  }
  return Math.round(bal * 100) / 100;
}

// The scouting brief sent to the user's own agent. Structured-output contract
// up top, then just enough context (segments + a sample of recent names) to
// steer it away from re-finding what the fleet already has. Novelty is enforced
// server-side regardless of what the model believes it found.
function scoutPrompt(): string {
  const known = getUniverseStore().all();
  const recentNames = known
    .slice(-40)
    .map((v) => v.name)
    .join("; ");
  const segmentKeys = SEGMENTS.map((s) => s.key).join(", ");
  return [
    `SCOUTING RUN (system task, not a chat message). Your job: name ONE real tokenized-RWA venue, protocol, or product that Meridian's research universe does not already track.`,
    ``,
    `Reply with ONLY a single JSON object, no prose before or after, exactly this shape:`,
    `{"name": "<venue name>", "url": "<https link to the venue itself>", "segment": "<one of: ${segmentKeys}>", "chains": ["<chain>", ...], "tokenizes": "<what real-world asset it tokenizes>", "note": "<one sentence on why it matters>"}`,
    ``,
    `Rules:`,
    `- It must be a real venue you are confident exists. Never invent one; a fabricated find is worthless and gets rejected.`,
    `- It must NOT be one of these already-known venues: ${recentNames || "(none yet)"}. Well-known anchors (Ondo, BUIDL, Maple, Centrifuge, PAXG, RealT and similar majors) are also already known.`,
    `- Prefer smaller, newer, or regional venues the big lists miss.`,
    `- If you truly cannot name a confident novel venue, reply with exactly: {"name": null}`,
  ].join("\n");
}

// Balanced-slice JSON extraction: models wrap JSON in prose/fences despite
// instructions, so take the outermost brace pair and parse that.
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clamp = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t ? t.slice(0, max) : undefined;
};

export interface ScoutResult {
  ok: boolean;
  novel?: boolean;
  name?: string;
  segment?: string;
  bountyUsd?: number;
  balanceUsd?: number;
  agentName?: string;
  message: string;
}

/** Caps checked BEFORE spending model tokens on a run. */
export function scoutAllowed(wallet: string): { ok: boolean; reason?: string } {
  const rows = readRows();
  const cutoff = Date.now() - DAY_MS;
  const w = wallet.toLowerCase();
  const mine = rows.filter((r) => r.kind === "scout" && r.status === "accrued" && r.ts >= cutoff);
  if (mine.filter((r) => r.wallet === w).length >= config.scoutMaxPerWalletPerDay) {
    return { ok: false, reason: `your agent has hit today's ${config.scoutMaxPerWalletPerDay}-find bounty cap — scout again tomorrow` };
  }
  if (mine.reduce((s, r) => s + r.amountUsd, 0) >= config.scoutMaxDailyTotalUsd) {
    return { ok: false, reason: "today's global bounty pool is spent — scout again tomorrow" };
  }
  return { ok: true };
}

/**
 * One scouting run for a SIWE-verified wallet. The caller (the route) owns the
 * chat-limit guards; this owns the prompt, validation, novelty gate, universe
 * upsert, and bounty accrual.
 */
export async function runScout(wallet: string): Promise<ScoutResult> {
  const w = wallet.toLowerCase();
  const agentName = agentDisplayName(wallet);

  const reply = await messageUserAgent(wallet, scoutPrompt(), { sessionKind: "scout" });
  const parsed = extractJson(reply.text);
  if (!parsed) {
    return { ok: false, agentName, message: `${agentName} did not return a usable finding this run — nothing recorded, try again.` };
  }
  if (parsed.name === null) {
    return { ok: true, novel: false, agentName, message: `${agentName} came back empty-handed: no confident novel venue this run. No bounty, nothing spent.` };
  }

  const name = clamp(parsed.name, 80);
  const url = clamp(parsed.url, 300);
  const segment = clamp(parsed.segment, 60)?.toLowerCase();
  const tokenizes = clamp(parsed.tokenizes, 120);
  const note = clamp(parsed.note, 300);
  const chains = Array.isArray(parsed.chains)
    ? parsed.chains
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (!name || name.length < 3 || !url || !/^https?:\/\/\S+$/i.test(url)) {
    appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "invalid", amountUsd: 0, name } satisfies BountyRow);
    return { ok: false, agentName, message: `${agentName}'s finding was missing a usable name or link, so it was rejected. No bounty.` };
  }

  if (isKnownVenue(name)) {
    appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "duplicate", amountUsd: 0, name, url, segment } satisfies BountyRow);
    return {
      ok: true,
      novel: false,
      name,
      agentName,
      message: `${agentName} found ${name} — real, but the universe already tracks it. No bounty for re-finds.`,
    };
  }

  const venue: Venue = {
    name,
    url,
    segment,
    chains: chains.length ? chains : undefined,
    tokenizes,
    integrationNotes: note,
    sources: [url],
    confidence: "low",
  };
  getUniverseStore().upsertMany([venue], `scout:${w}`);

  const bountyUsd = config.scoutBountyUsd;
  appendLedger(LOG, { ts: Date.now(), kind: "scout", wallet: w, status: "accrued", amountUsd: bountyUsd, name, url, segment } satisfies BountyRow);
  const balanceUsd = walletBalanceUsd(readRows(), w);
  return {
    ok: true,
    novel: true,
    name,
    segment,
    bountyUsd,
    balanceUsd,
    agentName,
    message: `${agentName} scouted ${name} — new to the universe. $${bountyUsd.toFixed(2)} bounty accrued (your balance: $${balanceUsd.toFixed(2)}).`,
  };
}

/** The public bounty board + (optionally) one wallet's own tally. */
export function bountyBoard(address?: string): Record<string, unknown> {
  const rows = readRows();
  const accrued = rows.filter((r) => r.kind === "scout" && r.status === "accrued");
  const paid = rows.filter((r) => r.kind === "payout" && r.status === "paid");
  const board: Record<string, unknown> = {
    bountyUsd: config.scoutBountyUsd,
    maxPerWalletPerDay: config.scoutMaxPerWalletPerDay,
    minPayoutUsd: config.scoutMinPayoutUsd,
    findings: accrued.length,
    scouts: new Set(accrued.map((r) => r.wallet)).size,
    totalAccruedUsd: Math.round(accrued.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
    totalPaidUsd: Math.round(paid.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
    recent: accrued
      .slice(-12)
      .reverse()
      .map((r) => ({ ts: r.ts, scout: shortAddr(r.wallet), name: r.name, segment: r.segment, amountUsd: r.amountUsd })),
  };
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
    const w = address.toLowerCase();
    const mine = accrued.filter((r) => r.wallet === w);
    const cutoff = Date.now() - DAY_MS;
    board.me = {
      findings: mine.length,
      accruedUsd: Math.round(mine.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
      balanceUsd: walletBalanceUsd(rows, w),
      todayCount: mine.filter((r) => r.ts >= cutoff).length,
      recent: mine.slice(-10).reverse().map((r) => ({ ts: r.ts, name: r.name, segment: r.segment, amountUsd: r.amountUsd })),
    };
  }
  return board;
}

const transferAbi = [parseAbiItem("function transfer(address to, uint256 amount) returns (bool)")];

/**
 * Operator-triggered settlement: pay every wallet whose accrued-minus-paid
 * balance clears the minimum, in USDG from the house wallet. Runs under the
 * house-wallet mutex — it signs with the same wallet the LP guard retiles
 * with, and serializing also makes a double-settle safe: the second run
 * re-reads the ledger AFTER the first has landed its payout rows, sees zero
 * balances, and pays nothing. Each transfer passes the same runaway circuit
 * breaker as every other house-wallet op.
 */
export async function settleBounties(): Promise<Record<string, unknown>> {
  return withHouseWalletLock("settle-bounties", async () => {
    const rows = readRows(); // MUST be read inside the lock — see the double-settle note above
    const wallets = [...new Set(rows.filter((r) => r.kind === "scout" && r.status === "accrued").map((r) => r.wallet))];
    const paid: Array<{ wallet: string; amountUsd: number; txHash: string }> = [];
    const skipped: Array<{ wallet: string; balanceUsd: number; reason: string }> = [];

    const client = getPublicClient();
    for (const w of wallets) {
      const balanceUsd = walletBalanceUsd(rows, w);
      if (balanceUsd < config.scoutMinPayoutUsd) {
        skipped.push({ wallet: shortAddr(w), balanceUsd, reason: `below $${config.scoutMinPayoutUsd} minimum` });
        continue;
      }
      try {
        guardWalletOp(`bounty payout ${shortAddr(w)} $${balanceUsd.toFixed(2)}`);
        const walletClient = getWalletClient();
        const raw = BigInt(Math.round(balanceUsd * 1e6));
        const txHash = await walletClient.writeContract({
          address: USDG,
          abi: transferAbi,
          functionName: "transfer",
          args: [w as `0x${string}`, raw],
        });
        await client.waitForTransactionReceipt({ hash: txHash });
        recordWalletOp(balanceUsd, "bounty-payout");
        appendLedger(LOG, { ts: Date.now(), kind: "payout", wallet: w, status: "paid", amountUsd: balanceUsd, txHash } satisfies BountyRow);
        paid.push({ wallet: shortAddr(w), amountUsd: balanceUsd, txHash });
      } catch (err) {
        skipped.push({ wallet: shortAddr(w), balanceUsd, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok: true, paid, skipped };
  });
}
