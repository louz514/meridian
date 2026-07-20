// One shared Postgres pool for everything backend-side (the snapshot mirror and
// the row-level ledger). Lazy: no DATABASE_URL (local dev) → null, callers
// no-op. Small pool on purpose — this is a mirror/bookkeeping connection, not a
// request-serving hot path, and the gateway shares this Postgres instance.
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    // Same-project Railway internal networking (postgres.railway.internal) — no TLS.
    pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("[db] pool error (continuing):", e.message));
  }
  return pool;
}
