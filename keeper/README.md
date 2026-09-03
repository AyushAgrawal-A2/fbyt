# fbyt-keeper (Rust)

The production **off-chain automation service** — the Rust counterpart to the TypeScript keeper. It runs
the DCA / grid / rebalance bots registered in the app, trading each vault through its **trading delegate**
(a trade-only key that can never withdraw).

Because it lives in the program's Cargo workspace it reuses the program's **own** `state`, `accounts`,
`instruction`, and seed constants (`fbyt_vault::…`) — no hand-rolled byte offsets — so its
(de)serialization is exactly what the on-chain program expects. It interoperates with the app through the
same file DB the UI/API use (`../app/.data/db/`): it reads `bots.json`, and writes executions to
`botOrders.json` plus `runCount`/`lastRunAt`/`state` on each bot, which the UI then shows.

```bash
# a manager sets the delegate and registers bots in the UI (/manage/<vault> → Automation bots),
# or seed bots.json directly. Then run the keeper with the delegate's keypair:
cd keeper
RPC_URL=http://127.0.0.1:8899 cargo run -- ../app/scripts/.keys/delegate.json          # loop (every 30s)
RPC_URL=http://127.0.0.1:8899 cargo run -- ../app/scripts/.keys/delegate.json --once    # single pass
```

Env: `RPC_URL` (default `http://127.0.0.1:8899`), `FBYT_PROGRAM_ID` (default the declared id),
`KEEPER_INTERVAL_SEC` (default 30). It runs every enabled bot the given key is the delegate for, skipping
vaults where the on-chain `trading_delegate` doesn't match.

Strategies: **dca** (fixed input each tick), **rebalance** (trade toward a target weight, capped), and
**grid** (buy/sell across price steps; last-fill price persisted per bot). It values legs against the Pyth
oracles and sends the same `swap` the program's differential tests and the UI exercise — through the
bundled jupiter-mock on localnet, or real Jupiter on a devnet/mainnet deployment.

Excluded from the SBF workspace (like the jupiter-mock); build it standalone from `keeper/`.
