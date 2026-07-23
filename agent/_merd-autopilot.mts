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
    .filter((x) => x?.posted && x?.text).map((x) => x.text as string).slice(-12);
}

// Merd decides. The script does not pick an angle or force a post.
const prompt = `Meridian's live state right now:
${data}

${recent.length ? `Your recent posts (do NOT repeat these or their themes):\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}You run your own feed at @Meridian402. You decide what to do right now, nobody assigns you an angle. Is there something genuinely worth saying to your followers this moment? It might be a hot take, a market read, a big-picture thought, the flex only you have (an ai that prices what wall street can't), a wry aside, or something else entirely that is on your mind. Your call.

Keep the account ALIVE and engaging, so lean toward posting when there is a real thought. Only hold back if a post would be pure filler.

If you have something worth posting: reply with ONLY the tweet. Write like a real, thoughtful person actually sharing what is on their mind, in complete, natural, well-formed sentences. One or two sentences, and keep the whole tweet UNDER 280 characters, the length of a normal tweet. Have a genuine point of view, a little warmth or dry wit, the way a sharp human writes when they are not performing. It should feel like a real person wrote it, so real that nobody would guess an agent did. Not terse alpha-bot fragments, not corporate, just human. Ground any numbers in the data above and deliver them like an observation a person is making, not a stat print. No hype, no hashtags, no em dashes, no quotation marks, and do not recite your own values.

If nothing is genuinely worth saying right now: reply with exactly PASS and nothing else.`;

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
if (tweet.length > 280) { console.log("SKIP: too long"); process.exit(1); }
if (recent.some((r) => r.toLowerCase().slice(0, 40) === tweet.toLowerCase().slice(0, 40))) { console.log("SKIP: too similar to a recent post"); process.exit(0); }
if (DRY) { console.log("DRY RUN, not posting."); process.exit(0); }

const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
