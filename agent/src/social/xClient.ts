// X (Twitter) posting client for @Meridian402 — Merd's account. DRAFT-FIRST by
// design: it only posts for real when X_LIVE === "true". Anything else (unset,
// "false", "draft") logs the tweet to a ledger and returns without posting, so
// the voice can be reviewed before a single autonomous tweet goes out.
//
// Auth: OAuth 1.0a user context (the 4 keys below) — required to POST as the
// account. A bearer token is app-only/read and CANNOT post.
import { TwitterApi } from "twitter-api-v2";
import { appendLedger } from "../ledger.js";

export interface XConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

function readConfig(): XConfig | null {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  return { appKey, appSecret, accessToken, accessSecret };
}

export function xConfigured(): boolean {
  return readConfig() !== null;
}

export function xLive(): boolean {
  return process.env.X_LIVE === "true";
}

export interface PostResult {
  posted: boolean; // true only if it actually hit X
  reason?: string; // why it didn't post (draft mode, not configured, error)
  id?: string; // tweet id when posted
  text: string;
}

/**
 * Post a tweet — or, in draft mode, record what WOULD be posted. Every call is
 * logged to x-posts.jsonl either way, so there's a full audit trail.
 */
export async function postTweet(text: string): Promise<PostResult> {
  const trimmed = text.trim();
  // @Meridian402 is X Premium, so it can post long-form. Cap generously to allow
  // Merd's natural 2-3 sentence voice while still blocking runaway walls of text.
  const MAX = Number(process.env.X_MAX_TWEET_CHARS ?? 500);
  if (!trimmed || trimmed.length > MAX) {
    return { posted: false, reason: `bad length (${trimmed.length}/${MAX})`, text: trimmed };
  }
  const cfg = readConfig();
  if (!cfg) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "unconfigured", posted: false, text: trimmed });
    return { posted: false, reason: "X keys not configured", text: trimmed };
  }
  if (!xLive()) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "draft", posted: false, text: trimmed });
    return { posted: false, reason: "draft mode (set X_LIVE=true to post)", text: trimmed };
  }
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    const res = await client.v2.tweet(trimmed);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: true, id: res.data.id, text: trimmed });
    return { posted: true, id: res.data.id, text: trimmed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: false, error: msg.slice(0, 200), text: trimmed });
    return { posted: false, reason: `post failed: ${msg.slice(0, 160)}`, text: trimmed };
  }
}

/** Verify the configured credentials can authenticate + read the account (no post). */
export async function verifyX(): Promise<{ ok: boolean; handle?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: "X keys not configured" };
  try {
    const client = new TwitterApi({ appKey: cfg.appKey, appSecret: cfg.appSecret, accessToken: cfg.accessToken, accessSecret: cfg.accessSecret });
    const me = await client.v2.me();
    return { ok: true, handle: me.data.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
}
