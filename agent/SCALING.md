# Scaling past one replica

The backend is correct on a single replica and degrades in specific, known ways
the moment a second one exists. This is the checklist for that day. Nothing here
is urgent while `meridian402-api` runs one instance.

Audited 2026-07-23.

## What already survives scaling

**Session bearers.** `mintSession`/`verifySession` are stateless HMACs over
`address:expiry`, and `MERIDIAN_SESSION_SECRET` is set in Railway, so a session
minted on one replica verifies on any other. This is the one piece that needs no
work. Keep that variable set and identical across replicas: if it is ever unset,
each box falls back to a random per-boot secret and sign-ins break immediately.

**Fund safety.** House trading runs in-process, not through `/mcp`, and the
execute gate fails closed to loopback. Replica count does not change either.

## What breaks

### 1. SIWE nonce replay (accounts.ts)

`usedNonces` is a per-process `Map`. A captured sign-in signature can be replayed
against a different replica for up to `NONCE_TTL_MS` (10 minutes).

Bounded: a session only unlocks the wallet's own advisor chat. No funds move. So
this is a real defect but not a fund risk.

### 2. Rate limits multiply by replica count (httpGuards.ts)

`makeLimiter` holds its token buckets in process memory. With N replicas the real
ceiling is N times the configured value, because a client's requests spread
across boxes.

The one that matters is `AUTH_RATE_PER_MIN` (default 30). It guards signature
verification, which is CPU-expensive. At 4 replicas that is effectively 120/min
per IP.

### 3. Chat fairness and concurrency (chatLimits.ts)

Same root cause, three guards:

- per-wallet token bucket: a wallet gets N times its intended budget
- per-wallet single-flight: one turn per wallet *per replica*, so N concurrent
  turns for the same wallet
- global concurrency slot (`CHAT_MAX_CONCURRENT`, default 40): becomes N times 40
  simultaneous LLM calls, which is a cost exposure more than a security one

## The migration

Add Redis (Railway offers it as a service on the private network) and move the
three state holders behind it. Keep every interface identical so callers do not
change.

**Nonces.** Replace the `usedNonces` map with `SET nonce:<n> 1 NX EX 600`. The
`NX` return value *is* the replay check: falsy means already used. This is the
smallest change and closes a genuine hole, so do it first.

**Rate limiters.** Replace the in-process bucket with an atomic Lua script
implementing the same token bucket against Redis, keyed the way it is today
(`req.ip` for HTTP, wallet address for chat). A Lua script keeps read-modify-write
atomic across replicas; a naive `GET` then `SET` reintroduces the race.

**Chat single-flight.** `SET turn:<wallet> 1 NX EX 120` on begin, `DEL` on end.
The TTL is the safety net: without it a crashed replica leaves a wallet locked
out permanently. Every exit path must release, including errors and disconnects.

**Global concurrency.** A Redis counter with `INCR`/`DECR` and a TTL-backed
reaper, or accept per-replica caps and divide `CHAT_MAX_CONCURRENT` by the
replica count. Dividing is cruder but has no failure mode when Redis blips, and
is a reasonable first step.

### Degradation policy

Decide this before writing code, because it is a security decision. If Redis is
unreachable:

- **Nonces must fail closed.** Reject the sign-in. An open failure mode
  reintroduces exactly the replay hole this is fixing.
- **Rate limiters should fail open** to the current in-process bucket. Losing
  Redis should degrade fairness, not take the product down.

### Order

1. Redis service + `REDIS_URL`, wired but unused. Confirm connectivity.
2. Nonces. Ship on one replica; behavior should be unchanged.
3. Limiters and chat guards.
4. Only then scale to 2 replicas.

Doing step 4 before 2 and 3 is what turns a working system into a broken one.

## Verification

The honest test is two local instances behind one port, not a unit test:

- same nonce against both instances: second attempt must be rejected
- burst past `AUTH_RATE_PER_MIN` spread across both: must 429 at the shared limit
- same wallet, concurrent chat turns on both: second must be refused
- kill Redis mid-run: sign-ins refuse, chat keeps serving

## Also worth knowing

Railway does not auto-deploy on git push. Prod runs whatever was last pushed with
`railway up -s meridian402-api --detach` from `agent/`, so main can be ahead of
production. Check before assuming a fix is live.
