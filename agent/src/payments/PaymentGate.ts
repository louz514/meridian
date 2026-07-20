import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import type { Address } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { dataPath } from "../dataDir.js";

export interface X402Requirements {
  x402Version: number;
  accepts: Array<{
    scheme: "exact";
    network: string;
    maxAmountRequired: string;
    resource: string;
    payTo: string;
    description: string;
  }>;
}

const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Replay ledger: every accepted payment tx is burned here so one on-chain
// transfer can never pay for two tool calls, across restarts.
const USED_TX_PATH = dataPath("x402-used.jsonl");
const MAX_AGE_SECONDS = 15 * 60;

/**
 * Receiving side of x402 — gates a priced tool call on an X-PAYMENT header.
 *
 * Verification modes by facilitatorUrl:
 *   ""      stub: accept anything, log loudly (local dev only)
 *   "self"  built-in facilitator: the header carries a tx hash, and we verify
 *           directly against Robinhood Chain that it's a successful, recent,
 *           previously-unused USDG transfer to the treasury of at least the
 *           required amount. No external service exists for this chain, so
 *           the chain itself is the source of truth.
 *   https…  a remote facilitator, when the ecosystem standardizes one.
 */
export class PaymentGate {
  private usedTx: Set<string> | null = null;

  constructor(private treasuryAddress: string, private facilitatorUrl: string) {}

  requirements(amountUsd: number, resource: string): X402Requirements {
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          // The treasury is an EVM wallet on Robinhood Chain (id 4663) and
          // payments settle in USDG there — the old "solana" label predated
          // the Robinhood-only scope and pointed payers at the wrong chain.
          network: "robinhood-chain",
          maxAmountRequired: String(Math.round(amountUsd * 1_000_000)), // USDG, 6 decimals
          resource,
          payTo: this.treasuryAddress || "unconfigured",
          description: `Meridian ${resource} - $${amountUsd.toFixed(4)}`,
        },
      ],
    };
  }

  private loadUsed(): Set<string> {
    if (this.usedTx) return this.usedTx;
    this.usedTx = new Set();
    if (existsSync(USED_TX_PATH)) {
      for (const line of readFileSync(USED_TX_PATH, "utf8").split("\n")) {
        try {
          const r = JSON.parse(line);
          if (r.txHash) this.usedTx.add(r.txHash.toLowerCase());
        } catch {}
      }
    }
    return this.usedTx;
  }

  private burnTx(txHash: string, resource: string, amountUsd: number): void {
    this.loadUsed().add(txHash.toLowerCase());
    appendLedger("x402-used.jsonl", { txHash: txHash.toLowerCase(), resource, amountUsd, at: Date.now() });
  }

  async verify(
    paymentHeader: string,
    amountUsd: number,
    resource: string,
  ): Promise<{ ok: boolean; error?: string; txHash?: string }> {
    if (!this.facilitatorUrl) {
      console.log(
        `[PaymentGate:stub] accepting $${amountUsd} for ${resource} ` +
          `(no facilitator configured, proof not actually verified)`,
      );
      return { ok: true };
    }

    if (this.facilitatorUrl === "self") {
      return this.verifyOnChain(paymentHeader, amountUsd, resource);
    }

    throw new Error("Remote x402 facilitator verification not implemented yet");
  }

  /** Header: base64(JSON) or raw JSON containing { txHash }. */
  private async verifyOnChain(header: string, amountUsd: number, resource: string): Promise<{ ok: boolean; error?: string; txHash?: string }> {
    if (!this.treasuryAddress) return { ok: false, error: "treasury not configured" };
    let txHash: string | undefined;
    try {
      const raw = header.trim().startsWith("{") ? header : Buffer.from(header, "base64").toString("utf8");
      txHash = (JSON.parse(raw) as { txHash?: string }).txHash;
    } catch {
      return { ok: false, error: "X-PAYMENT must be JSON (optionally base64) with a txHash field" };
    }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "invalid txHash" };
    if (this.loadUsed().has(txHash.toLowerCase())) return { ok: false, error: "payment tx already used" };

    const client = getPublicClient();
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return { ok: false, error: "payment tx not found on Robinhood Chain" };
    }
    if (receipt.status !== "success") return { ok: false, error: "payment tx reverted" };

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    if (age > MAX_AGE_SECONDS) return { ok: false, error: `payment tx too old (${age}s > ${MAX_AGE_SECONDS}s)` };

    const required = BigInt(Math.round(amountUsd * 1_000_000));
    const paid = receipt.logs
      .filter((l) => l.address.toLowerCase() === USDG.toLowerCase())
      .reduce((sum, l) => {
        try {
          const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
          if (l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && to === this.treasuryAddress.toLowerCase()) {
            return sum + BigInt(l.data);
          }
        } catch {}
        return sum;
      }, 0n);

    if (paid < required) {
      return { ok: false, error: `insufficient payment: ${paid} USDG-units < ${required} required` };
    }

    this.burnTx(txHash, resource, amountUsd);
    console.log(`[PaymentGate:self] verified $${amountUsd} for ${resource} via ${txHash.slice(0, 10)}…`);
    return { ok: true, txHash };
  }
}
