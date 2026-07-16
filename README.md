# Meridian

Cross-chain RWA (real-world asset) DEX with agentic trading — built as a layer
on top of [OpenHermit](https://github.com/HCF-STUDIOS/openhermit).

OpenHermit is the operable agent runtime (durable state, sandboxed execution,
fleet management, channels, scheduling). Meridian supplies the domain: an
autonomous agent discovers RWA liquidity, routes orders, and settles trades
using x402 micropayments. Meridian does **not** run its own agent loop — a
"Meridian agent" is an OpenHermit agent with the Meridian MCP server (and,
later, the Meridian trading skill) enabled.

**Current scope, by design: Robinhood Chain only.** The agent trades The Index's
tokenized equities (AAPL, NVDA, TSLA, MSFT, COIN) there via Uniswap v4. The
cross-chain pieces (`WormholeBridge`, the other `ChainId` values, the Solana/EVM
multi-chain wallet stack) are real, tested code, just dormant — not deleted,
not the current focus. Widening scope back out is a data change
(`agent/src/marketData.ts`, `frontend/src/data/assets.ts`), not a rebuild.

## Structure

```
meridian/
  agent/       Meridian MCP server — RWA/bridge/x402 tools an OpenHermit agent connects to
  frontend/    Trading interface (Vite + React)
```

## How it layers on OpenHermit

| Meridian piece | OpenHermit surface |
|----------------|--------------------|
| `agent/` MCP server (`meridian_*` tools) | Registered via `POST /api/admin/mcp-servers`; tools surface as `mcp__meridian__*` |
| Trading strategy/procedure | _(next)_ a `SKILL.md` enabled per-agent or fleet-wide |
| `frontend/` | _(next)_ driven by `@openhermit/sdk` — swaps become agent messages, activity streams back |

## Quick start

### Meridian MCP server

```bash
cd agent
npm install
npm run dev        # http://127.0.0.1:8787/mcp
```

Then register and enable it with your OpenHermit gateway — see
[agent/README.md](agent/README.md).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Opens at http://localhost:5173. The circular dial in the swap panel is the
source/destination chain selector: click a chain to set source, shift-click
to set destination.

## Where things stand

Working scaffold, not production:
- `agent/src/bridge/WormholeBridge.ts` — cross-chain routing stub, wire in the real Wormhole SDK
- `agent/src/payments/X402Client.ts` — settlement stub matching the x402 flow
- `agent/src/marketData.ts` — mock RWA price feed, replace with a real oracle/venue API
- `agent/src/strategy/MomentumStrategy.ts` — example strategy behind the `Strategy` interface
- `agent/src/risk.ts` — server-side spend caps enforced on the write tools
- `agent/src/payments/PaymentGate.ts` — x402 paywall on the signal tools (`meridian_market_data`, `meridian_suggest_route`, `meridian_market_universe`); stub-accepts any payment until `X402_FACILITATOR_URL` is set, same pattern as the paying-side stub
- `meridian_bridge_execute` — every cross-chain RWA move settles a routing fee via x402 (`X402Client.pay()`, paying side) from the trade's own wallet before the bridge runs; `meridian_bridge_quote` previews the fee
- `agent/src/agentLoop.ts` — background loop that keeps `MomentumStrategy` evaluating even with no caller connected, logging reasoning traces (`agent/src/decisionLog.ts`) that both `meridian_agent_thoughts` and the frontend's live monitor (`GET /api/agent-thoughts`) read from
- `agent/src/venues/IndexTrader.ts` + `meridian_index_execute` — real execution path for The Index's tokenized equities (AAPL/NVDA/TSLA/MSFT/COIN) on Robinhood Chain via Uniswap v4, distinct from the cross-chain Wormhole bridge; `MomentumStrategy` now rotates the Index basket as its first-priority tradeable signal, not just narration

Next real decisions: which RWA venues you're sourcing liquidity from, whether
Meridian custodies anything or is purely a router, which chains launch first —
and packaging the trading strategy as an OpenHermit skill so the agent knows
*when* to call the tools, not just *how*.
