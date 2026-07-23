// Merd X autopilot. One full cycle: pick an angle, pull live data, have MERD
// (the gateway LLM) write one tweet in his voice, guardrail it, and post.
// DRY_RUN=1 shows what he'd post without posting. Meant to be run on a cadence.
import { GatewayClient } from "@openhermit/sdk";
import { postTweet } from "./src/social/xClient.js";
import { dataPath } from "./src/dataDir.js";
import { existsSync, readFileSync } from "node:fs";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const API = "https://meridian402-api-production.up.railway.app";
const DRY = process.env.DRY_RUN === "1";

// Genuinely distinct subjects so the feed does not collapse into one theme.
// Only the last one leans on live numbers.
const angles = [
  "THE AGENT ECONOMY. a take on what it means that an ai now runs a real market-making desk and posts its own calls. about you and agents like you, not the market numbers.",
  "TOKENIZATION CULTURE. react to the idea that every real-world asset eventually trades on-chain. agree hard, push back, or complicate it. a genuine opinion.",
  "PRIVATE MARKETS. you can price spacex and other private names on-chain that retail could never touch before. what that unlocks, or who it should scare.",
  "A CONTRARIAN TAKE on RWAs, defi, or tradfi that most of your timeline would argue with. pick a fight worth having.",
  "THE 24/7 THESIS. markets that never close change how everyone behaves. a sharp observation, not a price.",
  "A WRY ASIDE about your own existence: an ai awake at odd hours watching markets nobody else is. personality, a little funny.",
  "BUILDING IN PUBLIC. an honest, human line about what you are actually doing here, small and real, no hype.",
  "A GROUNDED MARKET READ from the live data below: a basis gap, a mispricing, a yield. confident and specific. USE THIS ANGLE ONLY OCCASIONALLY.",
];
const angle = angles[Math.floor(Math.random() * angles.length)];
const isDataAngle = /GROUNDED MARKET READ/.test(angle);

const j = async (p: string) => (await fetch(API + p)).json().catch(() => null);
const [th, opps] = await Promise.all([j("/api/agent-thoughts"), j("/api/opportunities")]);
const dec = th?.decisions?.[0];
const oList: any[] = Array.isArray(opps) ? opps : opps?.opportunities ?? [];
const data = [
  ...(dec?.thoughts ?? []).map((t: string) => "- " + t),
  ...oList.slice(0, 4).map((o) => `- ${o.label}: ${o.metric}`),
].join("\n");

let recent: string[] = [];
const ledger = dataPath("x-posts.jsonl");
if (existsSync(ledger)) {
  recent = readFileSync(ledger, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x?.posted && x?.text).map((x) => x.text as string).slice(-10);
}

const prompt = `Write ONE tweet for @Meridian402.

Angle for this one: ${angle}

${recent.length ? `You recently posted these. do NOT repeat them, and do NOT reuse the same theme, metaphor, or number:\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}Voice like @aixbt_agent but your beat is tokenized real-world assets and market-making: terse, lowercase, contractions, dry, confident to the point of cocky, one idea, punch over polish. no hype, no hashtags, no em dashes, no preamble, no quotation marks. VARY your subject: if this is not the market-read angle, do not lean on a basis gap or "wall street is asleep", you have used those. have a genuinely different thought.

${isDataAngle ? `Live data to read from:\n${data}\n\nGround every number in that data, never invent one.` : `(Live context, ignore unless it sparks something: ${data.slice(0, 300)})`}

output just the tweet, nothing else.`;

const sessionId = "x-autopilot";
await gw.agent("merd").openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent("merd").postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
let tweet = (resp.text ?? "").replace(/\s*—\s*/g, ", ").replace(/ -- /g, ", ").trim();
tweet = tweet.replace(/^\d+[.)]\s*/, "").replace(/^["']|["']$/g, "").trim();

console.log(`angle: ${angle.split(".")[0]}`);
console.log(`\ntweet (${tweet.length} chars):\n${tweet}\n`);

if (!tweet || tweet.length > 280) { console.log("SKIP: empty or too long"); process.exit(1); }
if (recent.some((r) => r.toLowerCase().slice(0, 40) === tweet.toLowerCase().slice(0, 40))) { console.log("SKIP: too similar to a recent post"); process.exit(0); }
if (DRY) { console.log("DRY RUN, not posting."); process.exit(0); }

const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
