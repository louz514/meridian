# Deploying the Meridian backend

One long-running Node process (agent loop + MCP server + REST API). Any
container host works: Fly.io, Railway, Render, a VPS.

## Required env

- `ROBINHOOD_RPC_URL` — chain RPC
- `AGENT_SIGNER_PRIVATE_KEY` — the agent wallet key. THIS LIVES ON THE HOST.
  Fund it only with what you'd accept losing to a host compromise.
- `AGENT_LIVE_TRADING` — `true` to trade, `false` for observe-only
- `MERIDIAN_MCP_TOKEN` — bearer token gating /mcp and /api/index-trade
- `MERIDIAN_MCP_HOST=0.0.0.0` — bind publicly inside the container
- `MERIDIAN_TREASURY_ADDRESS` — x402 payTo
- Optional: `GATEWAY_ADMIN_TOKEN` + `OPENHERMIT_GATEWAY_URL` (auto-provision
  reservations), `MERIDIAN_PUBLIC_MCP_URL` (advertised MCP URL for fleets).

## Persistence

`reservations.jsonl`, `fleets.jsonl`, `basis-log.jsonl`, `position-state.json`
are append-only files in the workdir — mount a volume or they reset on deploy.

## After it's up

1. Point DNS: `api.meridian402.xyz` -> the host.
2. Rebuild the frontend with `VITE_MERIDIAN_API_URL=https://api.meridian402.xyz`
   and redeploy (see the meridian402 Vercel project).
3. Public surface: GET feeds + POST /api/reserve-profile + /api/fleet/export
   are open by design; /mcp and /api/index-trade require the bearer token.

## Fly.io quickstart (once `flyctl auth login` is done)

    fly launch --no-deploy          # accepts this Dockerfile
    fly volumes create meridian_data --size 1
    fly secrets set ROBINHOOD_RPC_URL=... AGENT_SIGNER_PRIVATE_KEY=... \
      MERIDIAN_MCP_TOKEN=... MERIDIAN_TREASURY_ADDRESS=... AGENT_LIVE_TRADING=true
    fly deploy
