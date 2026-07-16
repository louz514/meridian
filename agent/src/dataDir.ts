import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Where durable state lives: position, reservations, fleets, the x402
 * replay ledger. Defaults to the repo root (local dev). On a hosted
 * deployment set MERIDIAN_DATA_DIR to a mounted volume so state survives
 * machine replacement — these files are money-adjacent (payment replay
 * protection, customer reservations) and must not be ephemeral.
 */
const fallback = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.MERIDIAN_DATA_DIR || fallback;
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const dataPath = (file: string): string => join(DATA_DIR, file);
