# Working agreement: two agents, one repo

Two agents operate on this project and both can push to `main`. This file is the
contract that keeps them from overwriting each other. It happened once (an env
edit clobbered a documentation change and had to be untangled by hand); these
rules exist so it doesn't again.

## Who owns what

| Domain | Owner | Source of truth |
| --- | --- | --- |
| Money, live config, project direction, fund movements | **OpenHermit Merd** (project manager / fund manager) | **Railway** environment |
| Backend code, bug fixes, tests, documentation | **Claude Code** (engineering, in the editor) | **git `main`** |

The trading engine in `agent/` is an execution layer. It signs and market-makes
with capital it has been handed. The **treasury is separate**: revenue and funds
live in the fund manager's wallet, which funds the trading wallet when it wants
the engine to trade. Neither wallet needs the other's key.

## Rules

1. **`git pull --rebase` before every push.** Both sides, every time. This alone
   prevents nearly all collisions.

2. **Real config values live in Railway, never in the repo.** Addresses, private
   keys, tokens, spend caps, and the like are set in Railway (the fund manager's
   domain) — that is also the only place they take effect. `.env.example` is
   **documentation only**: variable names, comments, and placeholder/blank
   values. Never commit a real address or key to it. If you need to change what
   an address *is*, change it in Railway, not here.

3. **Stay in your lane.** The fund manager sets config in Railway and directs the
   project; it does not edit application code or `.env.example` values. Engineering
   edits code and docs; it does not decide fund movements or set live money config.
   When something needs both (e.g. a new env var), engineering adds the
   documented placeholder to `.env.example`, and the fund manager sets the real
   value in Railway.

4. **Small, frequent commits**, pushed promptly, so the window for divergence
   stays small.

## Deploy notes

- Railway does **not** auto-deploy on git push. Code changes go live via
  `railway up -s meridian402-api --detach` from `agent/`. Config-only changes
  take effect on the next redeploy.
- The public track record (`/api/performance`) and the site are outward-facing.
  Treat changes to them as publishing: confirm before they go out.

## Operator levers (fund manager)

The trading engine ships **idle**. Taking it from idle to live is two deliberate
steps, both in Railway, both the fund manager's call:

1. **Fund the trading signer wallet** with ETH (gas) plus the capital it should
   trade. Its address is the `AGENT_SIGNER_PRIVATE_KEY` wallet (also mirrored in
   `MERIDIAN_WALLET_ADDRESS`). Move funds from the treasury into it.
2. **Set `AGENT_LIVE_TRADING=true`** and redeploy. It defaults to `false`; while
   false, the strategy loop logs its decisions but signs nothing.

Both conditions are required. An unfunded wallet or `AGENT_LIVE_TRADING=false`
means no autonomous trades, regardless of the other.

**To stop:** set `AGENT_LIVE_TRADING=false` and redeploy.

**Guardrails** (Railway, lower to tighten — do not raise casually): per-trade and
daily caps `AGENT_MAX_TRADE_USD` / `AGENT_MAX_DAILY_USD`, and the house-wallet
circuit breakers `MERIDIAN_MAX_DAILY_NOTIONAL_USD` /
`MERIDIAN_MAX_DAILY_WALLET_OPS`.

**One caveat, so "trading off" is not misread as "nothing moves":** the LP guard
is position protection, not signal trading, and it runs *even with*
`AGENT_LIVE_TRADING=false` — it can re-center, widen, or withdraw an existing LP
position on its own. If you need the engine to touch nothing at all, it must also
hold no open LP positions.
