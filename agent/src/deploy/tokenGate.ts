// $MERD token gate for personal agents. Built to ship BEFORE the token exists:
// with MERD_TOKEN_ADDRESS unset the gate is disabled and everything behaves as
// before; set the address and the gate activates automatically. Enforcement is
// server-side (in ensureUserAgent, the one chokepoint every agent path calls),
// so a wallet must hold >= MERD_GATE_BPS of the live total supply to create OR
// use an agent — a client can't route around it. Balance reads are cached per
// wallet so re-checking on every message doesn't hammer the RPC.
import { parseAbiItem, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";

const TOKEN = (process.env.MERD_TOKEN_ADDRESS ?? "").trim();
const GATE_BPS = Math.max(0, Number(process.env.MERD_GATE_BPS ?? 10)); // 10 bps = 0.1% of supply
const CACHE_MS = Number(process.env.MERD_GATE_CACHE_MS ?? 60_000);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const erc20 = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function totalSupply() view returns (uint256)"),
];

export interface GateResult {
  enabled: boolean;      // is the gate configured (token address set)?
  ok: boolean;           // is this wallet allowed? (always true when disabled)
  requiredPct: number;   // threshold, as a percent of supply (e.g. 0.1)
  heldPct: number;       // wallet's holding, as a percent of supply
  balance?: string;      // raw units
  totalSupply?: string;
  tokenAddress?: string;
  error?: string;        // set when the balance couldn't be read
  retryable?: boolean;
}

export function merdGateEnabled(): boolean {
  return ADDRESS_RE.test(TOKEN);
}

export function fmtPct(p: number): string {
  if (!isFinite(p) || p <= 0) return "0%";
  return parseFloat(p >= 1 ? p.toFixed(2) : p.toFixed(4)) + "%";
}

/** Human sentence for a failed/blocked gate. */
export function gateMessage(g: GateResult): string {
  if (g.error) return g.error;
  return `Hold at least ${fmtPct(g.requiredPct)} of the $MERD supply to run your own agent — your wallet holds ${fmtPct(g.heldPct)}.`;
}

const cache = new Map<string, { at: number; result: GateResult }>();

/**
 * Resolve whether a wallet clears the $MERD gate. Cached per wallet for
 * CACHE_MS. On an RPC error it fails closed, but reuses a recent successful
 * read (stale-while-error) so a transient blip can't eject an active holder.
 */
export async function checkMerdGate(address: string): Promise<GateResult> {
  const requiredPct = GATE_BPS / 100;
  if (!merdGateEnabled()) return { enabled: false, ok: true, requiredPct, heldPct: 0 };
  if (!ADDRESS_RE.test(address)) {
    return { enabled: true, ok: false, requiredPct, heldPct: 0, tokenAddress: TOKEN, error: "invalid wallet address" };
  }

  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  try {
    const client = getPublicClient();
    const [balance, total] = await Promise.all([
      client.readContract({ address: TOKEN as Address, abi: erc20, functionName: "balanceOf", args: [address as Address] }),
      client.readContract({ address: TOKEN as Address, abi: erc20, functionName: "totalSupply" }),
    ]);
    // Exact threshold via bigint; the percent is a float only for display.
    const required = total > 0n ? (total * BigInt(GATE_BPS)) / 10_000n : 1n;
    const ok = total > 0n && balance >= required;
    const heldPct = total > 0n ? (Number(balance) / Number(total)) * 100 : 0;
    const result: GateResult = {
      enabled: true,
      ok,
      requiredPct,
      heldPct: Math.round(heldPct * 1e6) / 1e6,
      balance: balance.toString(),
      totalSupply: total.toString(),
      tokenAddress: TOKEN,
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch {
    if (hit) return hit.result; // stale-while-error
    return { enabled: true, ok: false, requiredPct, heldPct: 0, tokenAddress: TOKEN, error: "couldn't verify your $MERD balance — try again in a moment", retryable: true };
  }
}

export class MerdGateError extends Error {
  readonly code = "merd_gate";
  readonly gate: GateResult;
  constructor(gate: GateResult) {
    super(gateMessage(gate));
    this.name = "MerdGateError";
    this.gate = gate;
  }
}

/** Throw MerdGateError unless the wallet clears the gate (or the gate is off). */
export async function assertMerdGate(address: string): Promise<void> {
  const gate = await checkMerdGate(address);
  if (gate.enabled && !gate.ok) throw new MerdGateError(gate);
}
