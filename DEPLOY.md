# Deploying FBYT

The stack is three containers sharing one SQLite database (WAL) on a `data` volume:

- **app** — the Next standalone server (`app/Dockerfile` → `runner`).
- **indexer** — snapshots NAV/trades on a schedule (`app/Dockerfile` → `indexer`).
- **keeper** — the Rust automation bot (`keeper/Dockerfile`), trading via a vault's trading delegate.

```bash
cp .env.example .env      # fill in the values below
docker compose up --build
```

## Required configuration (`.env` next to docker-compose.yml)

| Variable | Used by | Notes |
|----------|---------|-------|
| `SESSION_SECRET` | app | **Mandatory** — a strong random secret. The app refuses to run sessions with the dev default in production. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | app (build) | Your RPC provider (e.g. QuickNode). Inlined at build time. |
| `NEXT_PUBLIC_WALLET_CHAIN` | app (build) | `solana:mainnet` or `solana:devnet`. |
| `NEXT_PUBLIC_CLUSTER` | app (build) | `mainnet` / `devnet` — the UI badge + analytics environment. |
| `NEXT_PUBLIC_FBYT_PROGRAM_ID` | app (build) | The deployed program id on your cluster. |
| `SOLANA_RPC_URL` | keeper | Solana RPC endpoint for the keeper. |
| `KEEPER_DELEGATE_KEYPAIR` | keeper | **Host path** to the delegate keypair JSON, mounted read-only at `/keys/delegate.json`. Never bake keys into an image. |
| `SESSION_SECRET`, `SENTRY_DSN`, `SOLANA_RPC_URL_FALLBACK` | app | Optional monitoring + RPC failover. |

`NEXT_PUBLIC_*` are compile-time — rebuild the app image (`docker compose build app`) after changing them.

## Secrets

- The keeper's **execution wallet** (delegate keypair) is provided as a mounted file, sourced from
  your host's secret manager (Docker/Swarm/K8s secrets, Vault, cloud KMS) — it is never committed or
  baked into an image. The delegate can only trade, never withdraw.
- `SESSION_SECRET` and RPC keys come from the environment, not the repo.

## Health & ops

- The app exposes `GET /api/health` (Docker healthcheck built in); the indexer and keeper wait for it.
- All three `restart: unless-stopped`. The keeper takes an advisory leader lock in the DB, so running
  more than one keeper replica is safe (only one trades at a time).
- Structured JSON logs go to stdout; set `SENTRY_DSN` to forward errors.

## Datastore

The local clone uses SQLite on the `data` volume — fine for a single node. For multiple app replicas or
higher scale, repoint `src/lib/db.ts` (and the keeper's `open_db`) at Postgres and move the rate limiter
to Redis; the call sites don't change.

## Trading

On mainnet/devnet, trades go through **real Jupiter**: the app quotes (`/api/jupiter/quote`), builds the
route (`/api/jupiter/swap-instructions`), and `src/lib/jupiterRoute.ts` adapts it into the on-chain
`swap`. The local surfnet has no real liquidity, so the bundled jupiter-mock stands in there.

## CI

`.github/workflows/ci.yml` runs on every push/PR: the app job (typecheck, unit tests, build) and the
keeper job (`cargo build`).
