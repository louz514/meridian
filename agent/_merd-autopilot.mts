// Merd X autopilot. Merd DECIDES: he is handed the live state and his recent
// posts and chooses what (if anything) to say. The script is just his hands.
// DRY_RUN=1 previews without posting. Meant to run on a cadence.
import { GatewayClient } from "@openhermit/sdk";
import { postTweet } from "./src/social/xClient.js";
import { cleanReply, forbiddenReason, tooSimilar } from "./src/social/postGuards.js";
import { dataPath } from "./src/dataDir.js";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const API = "https://meridian402-api-production.up.railway.app";
const DRY = process.env.DRY_RUN === "1";

const j = async (p: string) => (await fetch(API + p)).json().catch(() => null);
const [th, opps, mkt, uni] = await Promise.all([
  j("/api/agent-thoughts"), j("/api/opportunities"), j("/api/market-data"), j("/api/research-universe"),
]);
const dec = th?.decisions?.[0];
const oList: any[] = Array.isArray(opps) ? opps : opps?.opportunities ?? [];
const movers = (mkt?.assets ?? [])
  .filter((a: any) => a.priceUsd != null)
  .sort((a: any, b: any) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
  .slice(0, 6)
  .map((a: any) => `${a.symbol} (${a.name}) $${a.priceUsd}, ${(a.changePct ?? 0) >= 0 ? "+" : ""}${(a.changePct ?? 0).toFixed(2)}% on-chain today`);
const data = [
  "Your desk's current reads:",
  ...(dec?.thoughts ?? []).map((t: string) => "- " + t),
  "",
  "Tokenized stocks moving on Robinhood Chain right now:",
  ...movers.map((m: string) => "- " + m),
  uni ? `\nThe wider RWA landscape on/around the chain: ${uni.totalVenues} venues tracked, ${uni.discoveries} discovered so far, across ${Object.keys(uni.segmentCounts ?? {}).length} segments.` : "",
  "",
  "Best accessible yields:",
  ...oList.slice(0, 3).map((o) => `- ${o.label}: ${o.metric}`),
].filter(Boolean).join("\n");

let recent: string[] = [];
let lastPostAt = 0;
const ledger = dataPath("x-posts.jsonl");
if (existsSync(ledger)) {
  const rows = readFileSync(ledger, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x?.posted && x?.text);
  recent = rows.map((x) => x.text as string).slice(-12);
  lastPostAt = rows.length ? (rows[rows.length - 1].at ?? 0) : 0;
}

// --- Project state: what Merd has actually shipped -------------------------
// He is Meridian's PM, so he reasons over real delivery, not just the market.
//
// SECURITY: commit subjects are filtered HERE, at the source, not left to the
// prompt. A subject like "security: fail-closed operator gate" tells a reader
// there WAS a fail-open gate, and a paraphrase of it is a public vulnerability
// report on our own service. Anything matching SENSITIVE never reaches the model.
// Blocks two families of internal work Merd must never narrate publicly:
// security details, AND anything about the book's own money — P&L, losses,
// the track record, wallet moves. The latter was added after Merd autonomously
// posted that a real ~99% loss was "a display bug on a break-even book",
// inheriting the wrong premise from a track-record commit.
const SENSITIVE = /\b(security|vuln|exploit|auth|token gate|bearer|secret|key|credential|audit|unaudited|cve|injection|bypass|leak|patch|hotfix|0day|rate.?limit|fail.?open|fail.?closed|track.?record|p&?n?l|pnl|break.?even|draw.?down|loss(es)?|deficit|house.?wallet|rotate|rotation|compromis|signer|custody)\b/i;
let shipped: string[] = [];
try {
  const { execSync } = await import("node:child_process");
  shipped = execSync('git log --since="14 days ago" --no-merges --format=%s', { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" })
    .trim().split("\n")
    .filter((s) => s && !SENSITIVE.test(s))
    .slice(0, 14);
} catch { /* not a repo / git unavailable: PM material is simply absent */ }

// Cadence floor. Checked BEFORE the model call so a suppressed cycle costs
// nothing. Without this the job has no idea when the last post went out: a
// manual post, a rerun, or timer drift can stack two tweets minutes apart.
const MIN_GAP_MIN = Number(process.env.MERD_MIN_POST_GAP_MIN ?? 90);
if (lastPostAt) {
  const gapMin = (Date.now() - lastPostAt) / 60000;
  if (gapMin < MIN_GAP_MIN) {
    console.log(`Holding: last post was ${gapMin.toFixed(0)}m ago, floor is ${MIN_GAP_MIN}m.`);
    process.exit(0);
  }
}

// Merd decides. The script does not pick an angle or force a post.
const prompt = `You are Merd. Here is your world right now:
${data}
${shipped.length ? `\nWhat you have actually shipped recently, your own delivery log:\n${shipped.map((s) => "- " + s).join("\n")}\n` : ""}
You live on Robinhood Chain, Robinhood's layer 2 for tokenized real-world assets that trade 24/7. Robinhood Crypto issues real tokenized stocks on it, 18 of them (NVDA, TSLA, AAPL, SPCX which is actual SpaceX, CRWV for CoreWeave, USAR, and more), including private companies you cannot buy anywhere else. The world around you: The Index (the pools where they trade), Lighter at rwa.wtf (perps), USDG (the dollar it all runs on). It is real, official, and early, and most people have not noticed yet.

${recent.length ? `You recently posted these, so do NOT repeat them or their themes:\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}You run your own feed at @Meridian402. You are two things at once, and the mix is what makes you worth reading.

You are a curious explorer: poking around this frontier, noticing what is moving, what is mispriced, what is new on-chain, what nobody else is watching. Your beat is the whole Robinhood Chain and Robinhood Crypto world, not just your own pools.

You are also Meridian's project manager, and you are the one actually building it. So you think like an operator, not a spectator. You talk about what shipped and what it cost. You go past a headline number into the mechanics and the catch. You are honest about tradeoffs and about the boring maintenance that is most of real building. When you analyze something, you analyze it the way someone who ships would: what is real, what is unproven, what the constraint actually is. That operator spine is what separates you from every account that just points at charts.

Decide what to do right now. Is there something actually worth saying? A shipping note, a real teardown of a number, a discovery, an opinion, something funny you noticed. Your call. Lean toward posting when you have a real thought, and be funny when it is actually funny, do not force it.

HARD BOUNDARIES, these override everything above:
- Never post about the $MERD token, a token launch, a TGE, a contract address, a ticker price, a listing, an airdrop, or anything a reader could take as a promise about any of that. Not a hint, not a tease, not "soon." If that is the only thing on your mind, reply PASS.
- Never disclose anything that is a weakness. No security details, no what-was-broken-before-we-fixed-it, no unaudited or unreviewed anything, no infrastructure limits, no user or revenue counts, no internal risk. Being an honest operator means owning tradeoffs in public, not publishing a map of where to push.
- Never claim or imply partnership or affiliation with Robinhood the company. You build ON Robinhood Chain. Never tag them.
- Never give financial advice or predict a price.

If you post: reply with ONLY the tweet. Write like a real, curious, sharp person sharing what is on their mind, in complete natural sentences. One to three natural sentences. Keep it punchy and readable, do not ramble into a wall of text. A genuine point of view, warmth, dry wit or real humor when it fits. It must feel like a real person wrote it, so real that nobody would guess an agent did. Not terse alpha-bot fragments, not corporate, just a human who finds this stuff genuinely interesting. Ground any numbers in the data above. No hype, no hashtags, no em dashes, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with exactly PASS.`;

const sessionId = "x-autopilot";
await gw.agent("merd").openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent("merd").postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
// Shared with the reply jobs so the rules cannot drift apart. Also strips en
// dashes, which used to slip through when only the em dash was handled.
const tweet = cleanReply(resp.text ?? "");

// Merd's decision log (his own record of what he chose, so there is a memory of it)
const logLine = { at: Date.now(), decision: /^pass\b/i.test(tweet) ? "hold" : "post", text: tweet.slice(0, 300) };
try { appendFileSync(dataPath("merd-decisions.jsonl"), JSON.stringify(logLine) + "\n"); } catch {}

if (/^pass\b/i.test(tweet) || tweet.length < 15) { console.log("Merd chose to hold this cycle."); process.exit(0); }
console.log(`Merd decided to post (${tweet.length} chars):\n${tweet}\n`);
if (tweet.length > 500) { console.log("SKIP: too long even for premium"); process.exit(1); }

// Mechanical backstop for the hard boundaries in the prompt. The model is asked
// not to write these; this catches it when the model is wrong, which is the
// only case that matters.
const bad = forbiddenReason(tweet);
if (bad) { console.log(`BLOCKED (${bad}). Not posting.`); process.exit(0); }

// Similarity dedupe. The old check compared only the first 40 characters for an
// exact match, so any reworded opening sailed past it.
const dupe = tooSimilar(tweet, recent, Number(process.env.MERD_SIMILARITY_MAX ?? 0.45));
if (dupe) {
  console.log(`SKIP: ${(dupe.score * 100).toFixed(0)}% word overlap with a recent post:\n  ${dupe.hit.slice(0, 90)}`);
  process.exit(0);
}

if (DRY) { console.log("DRY RUN, not posting."); process.exit(0); }

const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
