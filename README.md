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

A frontend and backend for the vault flows — wallet connection, vault creation/management, deposit,
trade, and redeem — driving the program via its IDL. Work in progress; see [`app/README.md`](./app)
once populated.

## Status

- Program: reconstructed and differentially validated against the deployed bytecode; two economic-core
  behaviors (a sub-token rounding in the token→USD conversion and the withdraw performance-fee model)
  are documented as known divergences rather than approximated (see `RPC_FINDINGS.md`).
- Assessment: complete.
- App: in progress.
