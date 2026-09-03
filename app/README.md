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

# 2. deploy + seed a full demo environment: admin pool, base mint, oracle + Pyth price, a demo vault,
#    the bundled jupiter-mock cloned at the Jupiter id, and a demo tradeable output asset with liquidity
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

The same round-trips run headless against a surfnet (no browser) via the `e2e:*` scripts:

```bash
pnpm e2e:deposit   <vault>   # fund + deposit, asserts raised + shares
pnpm e2e:withdraw  <vault>   # deposit → cooldown → redeem, asserts tokens returned
pnpm e2e:lifecycle <vault>   # deposit → advance → trade (mirrors the UI exactly)
pnpm e2e:fee       <vault>   # operator streams the management fee in kind
```

> The `pnpm bootstrap` local flow (surfnet deploy + cheatcode injection) is the run-locally path and is
> not exercised in CI; the program itself is validated by the Rust differential suite in
> `programs/fbyt_vault`.

## Pages

| Route | What it does |
|-------|--------------|
| `/` | Browse + leaderboard: every `VaultPool`, ranked by capital raised. |
| `/vaults/[address]` | Vault detail + **deposit** (creates the investor pool if needed, then `deposit_token_fund`). |
| `/create` | **Create a vault**: bootstraps the money-manager pool if needed, then `create_vault`. |
| `/manage/[address]` | Manager + operator controls: set/revoke the trading delegate, **trade** (`swap`), advance a vault to trading (localnet), and **withdraw the management fee** (operator). |
| `/portfolio` | The connected wallet's positions across all vaults. |

## API routes

| Route | What it does |
|-------|--------------|
| `GET /api/vaults` | Decoded `VaultPool` list (server-side read), ranked by capital raised. |
| `GET /api/jupiter/quote` | Server-side proxy to Jupiter's quote API for the manager trade UI. |
| `POST /api/auth/nonce`, `POST /api/auth/verify` | Sign-In-With-Solana: nonce + Ed25519 verification, issuing an HMAC-signed session cookie. |
| `POST /api/faucet` | Local-surfnet only: funds a wallet with SOL + demo base tokens via cheatcodes. |
| `POST /api/dev/advance` | Local-surfnet only: time-travels a vault past its fundraise and refreshes oracle prices, so it can trade. |

## Notes

- `/api/dev/advance` exposes surfnet cheatcodes the protocol itself never uses; it exists only to walk a
  demo vault through its raise → trade lifecycle on a single local clock. It no-ops off a surfnet.
- `pnpm codegen` regenerates `src/generated` from `../target/idl/fbyt_vault.json` after any program change.
