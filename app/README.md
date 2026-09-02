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

# 2. deploy + seed a demo environment (admin pool, base mint, oracle, Pyth price, a demo vault)
pnpm bootstrap

# 3. run the app
cp .env.local.example .env.local     # defaults point at the local surfnet
pnpm dev                             # http://localhost:3000
```

Connect a browser wallet (it signs for `solana:mainnet` since the surfnet forks mainnet; the client
broadcasts to the surfnet). To fund your wallet with demo tokens, POST `/api/faucet` with your address
and the demo mint printed by `pnpm bootstrap`.

> The `pnpm bootstrap` local flow (surfnet deploy + cheatcode injection) is the run-locally path and is
> not exercised in CI; the program itself is validated by the Rust differential suite in
> `programs/fbyt_vault`.

## Pages

| Route | What it does |
|-------|--------------|
| `/` | Browse + leaderboard: every `VaultPool`, ranked by capital raised. |
| `/vaults/[address]` | Vault detail + **deposit** (creates the investor pool if needed, then `deposit_token_fund`). |
| `/create` | **Create a vault**: bootstraps the money-manager pool if needed, then `create_vault`. |
| `/manage/[address]` | Manager controls: set/revoke the trading delegate; notes for the trade + fee flows. |
| `/portfolio` | The connected wallet's positions across all vaults. |

## API routes

| Route | What it does |
|-------|--------------|
| `GET /api/vaults` | Decoded `VaultPool` list (server-side read), ranked by capital raised. |
| `GET /api/jupiter/quote` | Server-side proxy to Jupiter's quote API for the manager trade UI. |
| `POST /api/auth/nonce`, `POST /api/auth/verify` | Sign-In-With-Solana: nonce + Ed25519 verification, issuing an HMAC-signed session cookie. |
| `POST /api/faucet` | Local-surfnet only: funds a wallet with SOL + demo base tokens via cheatcodes. |

## Notes / remaining work

- The manager **trade** flow (`swap`) and operator **fee withdrawal** need the per-asset
  `remaining_accounts` plumbing and, on localnet, the bundled `jupiter-mock` program the Rust tests
  deploy at the Jupiter id; the instruction builders are generated and ready to wire.
- `pnpm codegen` regenerates `src/generated` from `../target/idl/fbyt_vault.json` after any program change.
