# FBYT app

Frontend + backend for the FBYT vault program: **Next.js (App Router) + Tailwind v4**, a wallet-backed
**@solana/kit v8** client (`@solana/react`), and a **Codama-generated typed client** from the program's
Anchor IDL. Targets a local surfnet running the reconstructed program.

## Stack

- **Reads/writes:** `@solana/kit` v8 client (`src/app/providers.tsx`); the connected wallet fills the
  payer/identity roles, `solanaRpc` handles RPC + transaction planning/sending.
- **Wallet:** Wallet Standard via `@solana/kit-plugin-wallet` (`src/components/WalletButton.tsx`).
- **Program client:** generated with Codama into `src/generated` (`pnpm codegen`) — typed instruction
  builders and account decoders for all 29 instructions.
- **Server:** Next.js API routes (`src/app/api/*`) for the off-chain pieces.

## Run it locally

The app talks to a local **surfnet** (a mainnet fork with cheatcodes) running the reconstructed program.

```bash
# 0. build the program + IDL, and (re)generate the client
anchor build                         # from the repo root
cd app && pnpm install && pnpm codegen

# 1. start the local network (forks mainnet, RPC on 127.0.0.1:8899)
pnpm localnet                        # = surfpool start

# 2. deploy + seed a full demo environment. Bootstrap drives the program's own instructions —
#    create_admin_pool, create_oracle_pool + approve_oracle_pool, create_money_manager_pool +
#    create_vault — and uses cheatcodes only for genuinely external state (the demo SPL mints, Pyth
#    prices, the jupiter-mock cloned at the Jupiter id, and its counterparty liquidity).
pnpm bootstrap

# 3. run the app
cp .env.local.example .env.local     # defaults point at the local surfnet
pnpm dev                             # http://localhost:3000
```

Connect a browser wallet (it signs for `solana:mainnet` since the surfnet forks mainnet; the client
broadcasts to the surfnet). To fund your wallet with demo tokens, POST `/api/faucet` with your address
and the demo mint printed by `pnpm bootstrap`.

### The vault lifecycle in the UI

A vault raises, then trades — the two phases are gated on the same clock (deposits require `now <=
created_at + raise_period`; trading requires `now >` that). Walk a demo vault through its life:

1. **Deposit** on `/vaults/[address]` while the vault is raising (the bootstrap clock sits inside the
   raise window).
2. **Advance to trading** on `/manage/[address]` — a localnet-only control (`POST /api/dev/advance`)
   time-travels the clock just past the fundraise and refreshes the oracle prices.
3. **Trade** the raised base token into the demo output asset through the mock, then **withdraw the
   management fee** as the operator.

Every flow also runs headless against a surfnet (no browser) via the `e2e:*` scripts — each builds the
same instructions the UI does:

```bash
pnpm e2e:deposit   <vault>   # fund + deposit, asserts raised + shares
pnpm e2e:withdraw  <vault>   # deposit → cooldown → redeem, asserts tokens returned
pnpm e2e:lifecycle <vault>   # deposit → advance → trade (mirrors the UI exactly)
pnpm e2e:fee       <vault>   # operator streams the management fee in kind
pnpm e2e:admin               # fees, a limit setter, and asset onboarding (create/approve/update/close oracle)
pnpm e2e:close     <vault>   # manager soft-closes the vault
pnpm e2e:wsol                # native SOL → wSOL wrap primitive (for wSOL-base vaults)
# these need `pnpm dev` running (they hit the API):
pnpm e2e:metadata  <vault>   # off-chain profile write; rejects non-managers
pnpm e2e:auth                # Sign-In-With-Solana session (cookie, /me, tampered-cookie rejection)
pnpm e2e:accounts            # accounts + points + referrals (terms bonus, referral, leaderboard)
pnpm e2e:bots      <vault>   # register a bot → keeper runs it → order recorded → halt stops it
pnpm e2e:launches            # image upload + token launch + voting
```

### Keeper bot + indexer (off-chain services)

An off-chain **keeper** trades vaults on a schedule using their **trading delegate** (a trade-only key
that can never withdraw), mirroring the platform's DCA/grid/rebalance bots. It runs either from a config
file (one vault) or, preferably, from the bots registered in the UI:

```bash
pnpm set-delegate <vault> <delegatePubkey>     # manager authorizes the keeper key as the delegate
pnpm keeper scripts/keeper.config.json         # config-file mode (one vault, see the example)
pnpm keeper --db scripts/.keys/delegate.json   # DB mode: run every enabled bot this key is delegate for,
                                               # recording each execution as an order
```

The **production keeper is a Rust service** (`../keeper/`) that runs the same strategies but reuses the
program's own `state`/`accounts`/`instruction` types for exact (de)serialization, and reads/writes the
same file DB. The `pnpm keeper` (TypeScript) above is the lightweight alternative for quick local runs.

```bash
cd ../keeper && RPC_URL=http://127.0.0.1:8899 cargo run -- ../app/scripts/.keys/delegate.json --once
```

Strategies: **dca**, **rebalance** (trade toward a target weight), and **grid** (buy/sell across price
steps, state persisted per bot). It values legs against the Pyth oracles and sends the same `swap` the UI
does, signed by the delegate.

The **indexer** snapshots each vault's NAV over time (the pnl-history the chain can't reconstruct after
the fact) and persists trades into the file-backed DB, which the app serves back as history + charts:

```bash
pnpm indexer                                   # snapshots every 30s (needs `pnpm dev` running)
```

> The `pnpm bootstrap` local flow is the run-locally path and is not exercised in CI; the program itself
> is validated by the Rust differential suite in `programs/fbyt_vault`.

## Point it at devnet/mainnet

Everything reads from env, so a real deployment is config-only. Set `NEXT_PUBLIC_SOLANA_RPC_URL` to a
devnet/mainnet provider, `NEXT_PUBLIC_WALLET_CHAIN`/`NEXT_PUBLIC_CLUSTER` to match, a strong
`SESSION_SECRET`, and (optionally) `NEXT_PUBLIC_GA_ID` / `NEXT_PUBLIC_SENTRY_DSN` for monitoring. There,
trades go through **real Jupiter**: quote via `/api/jupiter/quote`, build the route via
`/api/jupiter/swap-instructions`, and pass its instruction data + accounts to the on-chain `swap`. On the
local surfnet there's no real liquidity, so the bundled **jupiter-mock** stands in.

## Pages

| Route | What it does |
|-------|--------------|
| `/` | Browse + leaderboard: every `VaultPool` ranked by live **NAV**, with a name/strategy and PnL-vs-raised badge per card. |
| `/vaults/[address]` | Vault detail: name/strategy, **deposit** + **redeem**, live **portfolio** (holdings, NAV, NAV/share, your position value), and **recent trades**. |
| `/vaults/[address]` also | live **NAV history chart** (from the indexer) and the vault's **automation bots** (manager). |
| `/create` | **Create a vault**: bootstraps the money-manager pool if needed, then `create_vault`. |
| `/manage/[address]` | Manager + operator controls: **vault profile** (signed), trading delegate, **trade** (`swap`), **automation bots** (DCA/grid/rebalance), advance to trading (localnet), **management fee** (operator), and **close vault**. |
| `/admin` | Protocol admin: **onboard assets** (create/approve/update/close oracle, check a feed price), edit fees, set every limit/cap, and manage roles (operator, ownership transfer/accept). |
| `/portfolio` | The connected wallet's positions, each valued live against the vault's NAV, with a total. |
| `/account` | Your profile (name/bio), accept terms, referral code + points. |
| `/points` | Points leaderboard. |
| `/launches` | Token-launch board: submit a launch (with image upload) and upvote. |
| `/managers/[address]` | A manager's public profile and the vaults they run. |

## API routes

| Route | What it does |
|-------|--------------|
| `GET /api/vaults` | Decoded `VaultPool` list merged with off-chain profiles, ranked by capital raised. |
| `GET/PUT /api/vaults/[address]/metadata` | Off-chain vault profile (name/strategy/description). Writes are gated by a manager signature. |
| `GET /api/vaults/[address]/nav` | Live NAV, per-asset holdings, and PnL, valued against the Pyth oracles. |
| `GET /api/vaults/[address]/trades` | Decoded swap history from the vault's on-chain `TradingEvent`s. |
| `GET /api/vaults/[address]/history` | NAV/PnL time series recorded by the indexer (powers the chart). |
| `GET/POST /api/bots`, `GET/PATCH/DELETE /api/bots/[id]` | Register / list / enable-halt / delete automation bots (manager-gated). |
| `GET/PUT /api/users/me`, `GET /api/users/[address]` | The signed-in user's account; a user's public profile. |
| `GET /api/points`, `GET /api/managers/[address]` | Points leaderboard; a manager's profile + vaults. |
| `GET/POST /api/launches`, `POST /api/launches/[id]/vote` | Token launches + one-per-user upvotes. |
| `POST /api/uploads`, `GET /api/uploads/[id]` | Session-gated image upload + serving. |
| `GET /api/jupiter/quote`, `POST /api/jupiter/swap-instructions` | Jupiter quote + route-instruction proxies (real trading on devnet/mainnet). |
| `POST /api/auth/nonce`, `POST /api/auth/verify`, `GET /api/auth/me`, `POST /api/auth/logout` | Sign-In-With-Solana session (Ed25519 → HMAC cookie). |
| `POST /api/faucet` | Local-surfnet only: funds a wallet with SOL + demo base tokens via cheatcodes. |
| `POST /api/dev/advance` | Local-surfnet only: time-travels a vault past its fundraise and refreshes oracle prices, so it can trade. |

## Notes

- **Every program instruction is wired**: the UI exercises 28 of the 29; `create_admin_pool` (upgrade-authority
  only) is driven by `pnpm bootstrap`.
- **NAV, PnL, and trade history are computed on demand** from chain state; the **indexer** additionally records
  a NAV time series (the pnl-history) into the file-backed DB (`src/lib/db.ts`, under `.data/`).
- **Off-chain data** (vault profiles, user accounts, points, referrals, bots, launches, uploads) lives in the
  DB / `.data/`. Vault-profile writes are authorized by a manager signature; user/bot/launch writes by the SIWS
  session. A production deployment points these same call sites at Postgres + object storage.
- `/api/dev/advance` exposes surfnet cheatcodes the protocol itself never uses; it exists only to walk a
  demo vault through its raise → trade lifecycle on a single local clock. It no-ops off a surfnet.
- `pnpm codegen` regenerates `src/generated` from `../target/idl/fbyt_vault.json` after any program change.
