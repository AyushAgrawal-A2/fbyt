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
pnpm e2e:metadata  <vault>   # off-chain profile write (needs pnpm dev running); rejects non-managers
```

### Keeper bot (automated trading)

An off-chain keeper trades a vault on a schedule using its **trading delegate** (a trade-only key that
can never withdraw), mirroring the platform's DCA/rebalance bots.

```bash
# manager authorizes the keeper's key as the delegate
pnpm set-delegate <vault> <delegatePubkey>
# run the strategies (see scripts/keeper.config.example.json)
pnpm keeper scripts/keeper.config.json
```

Strategies: **dca** (fixed input each tick) and **rebalance** (trade toward a target weight, capped).
It values legs against the Pyth oracles and sends the same `swap` the UI does, signed by the delegate.

> The `pnpm bootstrap` local flow is the run-locally path and is not exercised in CI; the program itself
> is validated by the Rust differential suite in `programs/fbyt_vault`.

## Pages

| Route | What it does |
|-------|--------------|
| `/` | Browse + leaderboard: every `VaultPool` ranked by live **NAV**, with a name/strategy and PnL-vs-raised badge per card. |
| `/vaults/[address]` | Vault detail: name/strategy, **deposit** + **redeem**, live **portfolio** (holdings, NAV, NAV/share, your position value), and **recent trades**. |
| `/create` | **Create a vault**: bootstraps the money-manager pool if needed, then `create_vault`. |
| `/manage/[address]` | Manager + operator controls: **vault profile** (signed), set/revoke the trading delegate, **trade** (`swap`), advance to trading (localnet), **withdraw the management fee** (operator), and **close the vault**. |
| `/admin` | Protocol admin: **onboard assets** (create/approve/update/close oracle, check a feed price), edit fees, set every limit/cap, and manage roles (operator, ownership transfer/accept). |
| `/portfolio` | The connected wallet's positions, each valued live against the vault's NAV, with a total. |

## API routes

| Route | What it does |
|-------|--------------|
| `GET /api/vaults` | Decoded `VaultPool` list merged with off-chain profiles, ranked by capital raised. |
| `GET/PUT /api/vaults/[address]/metadata` | Off-chain vault profile (name/strategy/description). Writes are gated by a manager signature. |
| `GET /api/vaults/[address]/nav` | Live NAV, per-asset holdings, and PnL, valued against the Pyth oracles. |
| `GET /api/vaults/[address]/trades` | Decoded swap history from the vault's on-chain `TradingEvent`s. |
| `GET /api/jupiter/quote` | Server-side proxy to Jupiter's quote API for the manager trade UI. |
| `POST /api/auth/nonce`, `POST /api/auth/verify` | Sign-In-With-Solana: nonce + Ed25519 verification, issuing an HMAC-signed session cookie. |
| `POST /api/faucet` | Local-surfnet only: funds a wallet with SOL + demo base tokens via cheatcodes. |
| `POST /api/dev/advance` | Local-surfnet only: time-travels a vault past its fundraise and refreshes oracle prices, so it can trade. |

## Notes

- **Every program instruction is wired**: the UI exercises 28 of the 29; `create_admin_pool` (upgrade-authority
  only) is driven by `pnpm bootstrap`.
- **NAV, PnL, and trade history are computed on demand** from chain state (asset registry + vault balances +
  Pyth prices; decoded `TradingEvent` logs) — no indexer/DB. The real platform serves these from an indexer.
- **Vault profiles** are the one off-chain store (a JSON file under `.data/`); writes are authorized by an
  Ed25519 signature from the vault's on-chain money manager (stateless, no session needed).
- `/api/dev/advance` exposes surfnet cheatcodes the protocol itself never uses; it exists only to walk a
  demo vault through its raise → trade lifecycle on a single local clock. It no-ops off a surfnet.
- `pnpm codegen` regenerates `src/generated` from `../target/idl/fbyt_vault.json` after any program change.
