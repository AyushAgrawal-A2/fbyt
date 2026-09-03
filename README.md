# FBYT

FBYT is a non-custodial, share-based asset-management ("vault") platform on Solana: money managers
create vaults, investors deposit a base token for shares, managers trade the pooled assets through
Jupiter, and investors redeem their pro-rata basket — all with the assets held in program-owned token
accounts so no human ever custodies them.

This repository contains a faithful **source reconstruction** of the deployed on-chain program, a
**security/architecture assessment** of the live platform, and (in progress) a **frontend + backend**
that drive the program.

## Repository layout

| Path | What it is |
|------|------------|
| [`programs/fbyt_vault/`](./programs/fbyt_vault) | The reconstructed Anchor program (Rust) for `DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm`, plus its LiteSVM + differential test suite. |
| [`fbyt-assessment/`](./fbyt-assessment) | Write-up of the live platform: architecture, methodology, security findings, and the recovered Anchor IDL. |
| [`app/`](./app) | Frontend + backend (in progress). |
| `Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml` | Anchor workspace and toolchain pins. |

## The on-chain program (`programs/fbyt_vault`)

A behavioral reconstruction of the deployed program: it aims to produce the same accept/reject
decision, error code, and account state as the deployed bytecode on any transaction. It is validated
by a **differential test suite** that loads both the reconstruction and a dump of the deployed program
in an in-process SVM and compares them on identical transactions.

- [`BUILD.md`](./programs/fbyt_vault/BUILD.md) — toolchain, dependencies, and the IDL-reconstruction rules.
- [`tests/TESTS.md`](./programs/fbyt_vault/tests/TESTS.md) — the test suite and how the differential
  harness works.
- [`RPC_FINDINGS.md`](./programs/fbyt_vault/RPC_FINDINGS.md) — the deployed program's behavior the
  reconstruction reproduces, and the known divergences it does not.

```bash
anchor build                 # -> target/deploy/fbyt_vault.so + target/idl/fbyt_vault.json
cargo test -p fbyt_vault     # differential + handler test suite
```

Toolchain: Anchor 1.1.2, host Rust 1.98, SBF platform-tools per `Anchor.toml` (see `BUILD.md`).

## The assessment (`fbyt-assessment`)

A black-box study of the production deployment (live UI, public REST API, mainnet state, and the
Anchor IDL recovered from the frontend bundle). See its [`README.md`](./fbyt-assessment/README.md) for
the platform logic, [`ARCHITECTURE.md`](./fbyt-assessment/ARCHITECTURE.md) for the PDA tree and flow
diagrams, and [`SECURITY.md`](./fbyt-assessment/SECURITY.md) for the findings.

## The app (`app`)

A frontend + backend for the vault flows — **Next.js (App Router) + Tailwind**, a wallet-backed
**@solana/kit v8** client, and a **Codama-generated typed client** from the program IDL. It runs against
a local **surfnet** (a mainnet fork with cheatcodes) that hosts the reconstructed program, seeded by a
bootstrap script. Pages: vault browse/leaderboard, vault detail + deposit, create vault, manager
dashboard, and portfolio; API routes for vault listing, a Jupiter quote proxy, Sign-In-With-Solana, and
a local faucet. See [`app/README.md`](./app/README.md) for setup and the run steps.

## Status

- Program: reconstructed and differentially validated against the deployed bytecode; two economic-core
  behaviors (a sub-token rounding in the token→USD conversion and the withdraw performance-fee model)
  are documented as known divergences rather than approximated (see `RPC_FINDINGS.md`).
- Assessment: complete.
- App: a full functional clone running against a local surfnet, closing the gaps to the live product.
  Bootstrap onboards through the program's own instructions; all 29 instructions are exercised (28 from
  the UI, `create_admin_pool` from bootstrap). Investors deposit/redeem (incl. native SOL/wSOL) and see
  live position value; managers set a delegate, trade (`swap`), run DCA/grid/rebalance bots, withdraw
  fees, and close vaults; a protocol-admin console onboards assets and manages config/roles. Off-chain
  it has an indexer with NAV/PnL history charts, live NAV/holdings/trade-history, signed vault profiles,
  SIWS session auth, user accounts with points/referrals, public manager profiles, a token-launch board
  with image uploads, and a keeper + bots platform. Trading uses the bundled jupiter-mock on localnet and
  real Jupiter (quote + swap-instructions) on devnet/mainnet; everything reads from env, so retargeting a
  cluster is config-only. Each flow is verified headless by an `e2e:*` script that builds the same
  instructions the UI does (see `app/README.md`).
