# @meridian/mcp

Meridian's RWA-DEX domain, exposed as an **MCP server** that an
[OpenHermit](https://github.com/HCF-STUDIOS/openhermit) agent connects to.

Meridian is a layer on top of OpenHermit. OpenHermit is the operable agent
runtime — durable Postgres state, sandboxed execution, fleet management,
channels, scheduling. Meridian does **not** run its own agent loop; it supplies
the RWA capabilities as tools, and an OpenHermit agent orchestrates them. A
"Meridian agent" is just an OpenHermit agent with this MCP server (and, later,
the Meridian trading skill) enabled.

**Scoped to Robinhood Chain for now.** `agent/src/marketData.ts` only
populates assets there (The Index's tokenized equities); the other `ChainId`
values and `WormholeBridge`'s cross-chain path are real, still-tested code,
just dormant while focus stays on The Index.

## Tools

Surface inside the agent namespaced as `mcp__meridian__<tool>`:

| Tool | Kind | Cost | Purpose |
|------|------|------|---------|
| `meridian_list_chains` | read | free | Supported chains + bridging status |
| `meridian_list_assets` | read | free | RWA tokens, optionally filtered by chain |
| `meridian_market_data` | read | **paid** | Price/APR for a symbol, or all |
| `meridian_suggest_route` | read | **paid** | Momentum/APR strategy → decision + step-by-step reasoning (advisory) |
| `meridian_agent_thoughts` | read | free | Recent decisions + reasoning from the background agent loop — what the live monitor polls |
| `meridian_bridge_quote` | read | free | Quote a Wormhole cross-chain move, incl. the x402 routing fee |
| `meridian_bridge_execute` | write | free¹ | Execute a cross-chain bridge move; enforces per-trade + daily USD caps |
| `meridian_index_execute` | write | free¹ | Execute a same-chain swap between Index tickers on Robinhood Chain |
| `meridian_settle_x402` | write | free | Settle an arbitrary micropayment via the x402 flow |
| `meridian_market_universe` | read | **paid** | Query venues discovered by the RWA research fleet, filter by segment/chain/text |
| `meridian_universe_status` | read | free | Coverage summary: venues found per segment, last updated |
| `meridian_submit_research` | write | free | Called by research agents to upsert venue findings (name-deduped) |

The bridge and x402 (paying-side) layers are stubs (`src/bridge/`,
`src/payments/X402Client.ts`) — wire in the real Wormhole SDK / x402
facilitator without changing the tool surface. Spend caps in `src/risk.ts`
are enforced server-side so a prompt can't exceed them; still gate
`meridian_bridge_execute` behind an OpenHermit approval policy in production.

¹ Neither execute tool is paywalled, but neither runs for free: every call
requires a `payer` wallet and settles a routing fee (`BRIDGE_FEE_BPS` of trade
notional, via `X402Client`) from that wallet *before* anything moves — see
below.

## Two execution paths — cross-chain bridge vs. same-chain Index swap

These are genuinely different mechanisms, not two names for one thing:

- **`meridian_bridge_execute`** — moves an RWA position *between* chains via
  Wormhole (`src/bridge/WormholeBridge.ts`). Source and destination chain differ.
- **`meridian_index_execute`** — swaps *within* Robinhood Chain, between two
  tokenized-equity tickers on The Index (theindex.finance — Uniswap v4 pools;
  real contract addresses in `src/venues/IndexTrader.ts`). Never leaves the
  chain, so it was never reachable through the bridge tool no matter how that
  tool was wired — this is the actual execution path RWA equity rotation on
  The Index needed, and it didn't exist until it was built directly.

Both take a `payer` and settle their routing fee via `X402Client.pay()` first;
if that payment fails, neither touches its underlying venue. Both share one
action (`src/actions/executeIndexTrade.ts` for the Index path) so the MCP tool
and the frontend's `POST /api/index-trade` can't drift apart on risk caps or
fee logic. `meridian_bridge_quote` previews the bridge fee (`estFeeUsd`) the
same way.

## Live agent monitor

The trading strategy doesn't just run when a caller asks it to — `src/agentLoop.ts`
re-evaluates it on a timer (`AGENT_THINK_INTERVAL_MS`, default 20s) even with no
external agent connected, and logs every evaluation (`src/decisionLog.ts`) with
its full step-by-step reasoning trace, not just the final action. It's
read-only: the loop never executes a trade or spends anything — execution
stays a deliberate `meridian_index_execute` / `meridian_bridge_execute` call
by a real agent (or the frontend, via `POST /api/index-trade`) with a real
wallet; manual executions get logged into the same feed too.

`src/strategy/MomentumStrategy.ts` checks The Index basket (the tokenized
equities on Robinhood Chain — AAPL, NVDA, TSLA, MSFT, COIN) *first*, every
cycle: it rotates out of the biggest 24h laggard into the biggest 24h leader
once the spread clears `minIndexMomentumSpreadPct`, producing a real,
executable intent — Index equities aren't just narrated, they're the priority
tradeable signal. Only when Index momentum doesn't clear its threshold does
the strategy fall through to APR-rotation across the yield-bearing RWAs.

Two ways to watch it think:
- `meridian_agent_thoughts` (MCP tool, free) — for any OpenHermit agent.
- `GET /api/agent-thoughts` (plain JSON, CORS-open) — what the frontend's live
  monitor polls. Deliberately a separate lightweight REST route rather than
  making the browser speak the full MCP Streamable-HTTP protocol for a
  read-only display.

## Paywall on the signal tools

Meridian doesn't custody trade capital — callers bring their own funded
wallet and execute against it themselves. What Meridian sells is the research
fleet's data: `meridian_market_data`, `meridian_suggest_route`, and
`meridian_market_universe` are gated behind x402 (`src/payments/PaymentGate.ts`,
wired into the `/mcp` route in `src/index.ts`). Discovery/status tools stay
free so a new caller can see there's something worth paying for.

Since MCP multiplexes every tool call through one JSON-RPC endpoint, gating
happens by peeking at `tools/call` requests before they reach the MCP
transport, not via per-route HTTP 402s: no `X-PAYMENT` header on a priced
call gets a 402 with x402 payment requirements (`payTo` = `MERIDIAN_TREASURY_ADDRESS`,
amount = the tool's configured price); any non-empty header is accepted as
valid until `X402_FACILITATOR_URL` is set, matching `X402Client`'s stub
pattern on the paying side. Revenue is tallied in-memory per tool
(`src/payments/RevenueLedger.ts`) — process-local, resets on restart, same as
`RiskLimiter`. Prices are env-configurable (`PRICE_MARKET_DATA_USD`,
`PRICE_SUGGEST_ROUTE_USD`, `PRICE_MARKET_UNIVERSE_USD`) — see `.env.example`.

## RWA research fleet

`src/research/` is a standing swarm, not a one-off script: one OpenHermit agent
per RWA market segment (see `segments.ts` for the taxonomy), each finding and
tracking venues across the whole tokenized-RWA market and writing them into a
shared universe (`rwa-universe.json`, via `meridian_submit_research`) that the
trading agent reads through `meridian_market_universe`.

Each segment agent runs **two** skills on **two** cadences, deliberately split
by cost:

| Skill | Cost | Cadence | Job |
|-------|------|---------|-----|
| `skills/rwa-discover` | expensive (broad search) | weekly-ish | find venues Meridian doesn't know about yet |
| `skills/rwa-refresh` | cheap (targeted fetch) | daily / every few hours | re-check numbers for venues already known |

This matters because every scheduled agent wake pays a fixed cost (system
prompt + skill + tool listing) before any real work happens — running
discovery-grade broad search on every wake multiplies that cost for no
benefit, since most of what a broad search would find hasn't changed since
yesterday. See `segments.ts` for the actual cadence per segment (equities and
commodities refresh every 4h since prices move; carbon/funds/infra refresh
weekly since they don't).

Provision the fleet:

```bash
npm run provision-fleet
```

Without `GATEWAY_ADMIN_TOKEN` set, this only logs the plan (dry run) — safe to
run anytime to see what would be created/changed. With it set, it creates/
patches the 12 agents idempotently: registers the Meridian MCP server + both
skills, enables them per agent, sets each agent's segment brief, pins each
agent to a cheap model tier (`RWA_FLEET_MODEL_*` env — extraction-style
research doesn't need frontier reasoning; keep the trading agent on a stronger
model, set separately), and creates both cron schedules. Agents are created
with `sandbox: null` — they only need web search/fetch + MCP tools, not code
execution, so there's no sandbox (Docker/E2B/Daytona) cost to pay.

## Run

```bash
npm install
cp .env.example .env   # optional; set MERIDIAN_MCP_TOKEN to require auth
npm run dev            # http://127.0.0.1:8787/mcp  (tsx watch)
# or: npm run build && npm start
```

`GET /health` returns readiness. `POST /mcp` is the Streamable-HTTP MCP endpoint.

## Register with an OpenHermit gateway

```bash
curl -X POST "$OPENHERMIT_GATEWAY_URL/api/admin/mcp-servers" \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "meridian",
    "name": "Meridian",
    "description": "Cross-chain RWA DEX tools",
    "url": "http://<meridian-host>:8787/mcp",
    "headers": { "Authorization": "Bearer <MERIDIAN_MCP_TOKEN>" }
  }'

# enable it for one agent (or "*" for the whole fleet)
curl -X POST "$OPENHERMIT_GATEWAY_URL/api/admin/mcp-servers/meridian/enable" \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "main" }'
```

The agent picks up the tools on its next hydration (`hermit agents restart main`
forces it). Verify with the agent's `mcp_status` tool.

## Config

| Env | Default | Meaning |
|-----|---------|---------|
| `MERIDIAN_MCP_HOST` | `127.0.0.1` | Listen host |
| `MERIDIAN_MCP_PORT` | `8787` | Listen port |
| `MERIDIAN_MCP_TOKEN` | _(empty)_ | If set, `/mcp` requires `Authorization: Bearer <token>` |
| `WORMHOLE_RPC_URL` | _(empty)_ | Bridge RPC (stub logs when empty) |
| `X402_FACILITATOR_URL` | _(empty)_ | x402 facilitator (stub when empty) |
| `AGENT_MAX_TRADE_USD` | `1000` | Per-trade notional cap |
| `AGENT_MAX_DAILY_USD` | `5000` | Daily notional cap |
| `OPENHERMIT_GATEWAY_URL` | `http://127.0.0.1:4000` | Gateway the research fleet is provisioned on |
| `GATEWAY_ADMIN_TOKEN` | _(empty)_ | Admin token for provisioning; unset = dry run |
| `RWA_FLEET_MODEL_PROVIDER` / `RWA_FLEET_MODEL_ID` | `anthropic` / `claude-haiku-4-5` | Cheap model tier for research agents |
