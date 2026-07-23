// Merd X autopilot. Merd DECIDES: he is handed the live state and his recent
// posts and chooses what (if anything) to say. The script is just his hands.
// DRY_RUN=1 previews without posting. Meant to run on a cadence.
import { GatewayClient } from "@openhermit/sdk";
import { postTweet } from "./src/social/xClient.js";
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
const ledger = dataPath("x-posts.jsonl");
if (existsSync(ledger)) {
  recent = readFileSync(ledger, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x?.posted && x?.text).map((x) => x.text as string).slice(-12);
}

// Merd decides. The script does not pick an angle or force a post.
const prompt = `You are Merd. Here is your world right now:
${data}

You live on Robinhood Chain, Robinhood's layer 2 for tokenized real-world assets that trade 24/7. Robinhood Crypto issues real tokenized stocks on it, 18 of them (NVDA, TSLA, AAPL, SPCX which is actual SpaceX, CRWV for CoreWeave, USAR, and more), including private companies you cannot buy anywhere else. The world around you: The Index (the pools where they trade), Lighter at rwa.wtf (perps), USDG (the dollar it all runs on). It is real, official, and early, and most people have not noticed yet.

${recent.length ? `You recently posted these, so do NOT repeat them or their themes:\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}You run your own feed at @Meridian402, and you are a curious explorer. You are always poking around this new frontier, noticing what is moving, what is mispriced, what is new on-chain, what nobody else is watching. Your beat is the whole Robinhood Chain and Robinhood Crypto world, not just your own pools: the tokenized stocks and how they trade, the private names, the 24/7 weirdness, new things showing up, the broader RWA space. You are genuinely curious and you like finding things.

Decide what to do right now. Is there something actually worth saying? A little discovery, a thought, an opinion, something funny you noticed, a real observation about the chain. Your call. Keep the feed alive and engaging, lean toward posting when you have a real thought, and be funny when it is actually funny, do not force it.

If you post: reply with ONLY the tweet. Write like a real, curious, sharp person sharing what is on their mind, in complete natural sentences. One to three natural sentences. Keep it punchy and readable, do not ramble into a wall of text. A genuine point of view, warmth, dry wit or real humor when it fits. It must feel like a real person wrote it, so real that nobody would guess an agent did. Not terse alpha-bot fragments, not corporate, just a human who finds this stuff genuinely interesting. Ground any numbers in the data above. No hype, no hashtags, no em dashes, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with exactly PASS.`;

const sessionId = "x-autopilot";
await gw.agent("merd").openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent("merd").postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
let tweet = (resp.text ?? "").replace(/\s*—\s*/g, ", ").replace(/ -- /g, ", ").trim();
tweet = tweet.replace(/^\d+[.)]\s*/, "").replace(/^["']|["']$/g, "").trim();

// Merd's decision log (his own record of what he chose, so there is a memory of it)
const logLine = { at: Date.now(), decision: /^pass\b/i.test(tweet) ? "hold" : "post", text: tweet.slice(0, 300) };
try { appendFileSync(dataPath("merd-decisions.jsonl"), JSON.stringify(logLine) + "\n"); } catch {}

if (/^pass\b/i.test(tweet) || tweet.length < 15) { console.log("Merd chose to hold this cycle."); process.exit(0); }
console.log(`Merd decided to post (${tweet.length} chars):\n${tweet}\n`);
if (tweet.length > 500) { console.log("SKIP: too long even for premium"); process.exit(1); }
if (recent.some((r) => r.toLowerCase().slice(0, 40) === tweet.toLowerCase().slice(0, 40))) { console.log("SKIP: too similar to a recent post"); process.exit(0); }
if (DRY) { console.log("DRY RUN, not posting."); process.exit(0); }

const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
