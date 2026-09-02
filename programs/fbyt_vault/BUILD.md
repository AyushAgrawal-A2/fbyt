# Building fbyt_vault (Anchor 1.1.2 + real Pyth, latest toolchain)

Newest stack, **official crates only** (no vendored/hand-rolled types), no environment hacks.

Result: a `.so` plus an IDL with 29 instructions, 6 accounts, 31 events, 73 errors. (See the
"PriceUpdateV2 / IDL" note below for why it's 6 accounts and not 7.)

## Toolchain

| Tool | Version | How |
|------|---------|-----|
| Anchor CLI | **1.1.2** | `avm use 1.1.2` (also pinned in `Anchor.toml [toolchain] anchor_version`) |
| Rust (host / IDL build) | **1.98.0** | `rust-toolchain.toml` (installed via `rustup toolchain install 1.98.0`) — needed so the host can compile `solana-program 4.x` / `solana-syscalls` that `pyth 2.0.0` pulls |
| SBF platform-tools | **v1.52** | `Anchor.toml [toolchain] solana_version = "3.1.10"` (the Anchor-1.1.2 CI-tested pairing) |

`rust-toolchain.toml`:
```toml
[toolchain]
channel = "1.98.0"
```

`Anchor.toml`:
```toml
[toolchain]
anchor_version = "1.1.2"
solana_version = "3.1.10"
```

## Dependencies (`Cargo.toml`)

```toml
[dependencies]
anchor-lang = { version = "1.1.2", features = ["init-if-needed"] }
anchor-spl = "1.1.2"                  # default features cover token, token_2022, associated_token
pyth-solana-receiver-sdk = { version = "2.0.0", features = ["pro-compatible"] }  # anchor-lang 1.x line

[features]
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

Locked (Cargo.lock — commit it): `anchor-lang 1.1.2`, `anchor-spl 1.1.2`,
`pyth-solana-receiver-sdk 2.0.0`, `pythnet-sdk 3.0.0`, `solana-program 4.1.0`.

## Build

```bash
anchor build
```

One command. Outputs `target/deploy/fbyt_vault.so`, `target/deploy/fbyt_vault-keypair.json`,
`target/idl/fbyt_vault.json`.

**Why the toolchain matters:** `pyth 2.0.0 → pythnet-sdk 3.0 → solana-program 4.x`. The SBF side
(platform-tools v1.52 / cargo 1.89) compiles it fine, but the **host** IDL build compiles
`solana-syscalls 4.x`, which uses library features not stable until recent Rust. Host **rustc 1.98**
handles them; older host rust (e.g. 1.89, or the v1.48 SBF cargo 1.84) fails with
`feature 'edition2024' is required` / `maybe_uninit_write_slice`. Hence the `rust-toolchain.toml` pin.

## PriceUpdateV2 / IDL (6 vs 7 accounts)

The original mainnet IDL lists **7** accounts including `PriceUpdateV2`. This build lists **6** — the
Pyth account type is absent. Reason: `pyth-solana-receiver-sdk 2.0.0` exposes **no `idl-build`
feature**, so Anchor 1.x's IDL generator cannot emit its external account type. The program still uses
`Account<'info, PriceUpdateV2>` correctly at runtime; it's purely an IDL listing gap. Closing it would
require vendoring the type or hand-editing the IDL — deliberately not done (official deps only).

**Pyth `pro-compatible` feature (receiver id).** The crate's one feature, `pro-compatible`, is enabled
here — and it is *not* cosmetic: via `cfg-if` it selects the receiver program id that owns
`PriceUpdateV2` accounts. Enabled → `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp`; default →
`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`. The deployed program's price accounts are owned by
`rec2HHDD…`, so `pro-compatible` must be on. This same feature also selects the matching push-oracle
program id that `swap` derives its canonical price accounts under (see `RPC_FINDINGS.md`).

## Account constraints — a faithful reconstruction of the IDL only

**Governing rule: this is a pure reconstruction of the deployed program. Nothing is added that the
IDL does not encode.** The IDL records `seeds`, `signer`, `writable`, `address`, and `relations`; the
rest of each original `#[account(...)]` set (manual `constraint =`, `close`, etc.) and all handler
logic are compiled out of the IDL, so they are not reconstructed from the accounts struct — they live
in the handler bodies instead. The accounts struct emits exactly:

- `has_one = …` — **only** from IDL `relations` (Anchor emits a relation for every `has_one`, so the
  relations list is the complete, authoritative set of the original's `has_one` constraints).
- `associated_token::mint`/`authority`/`token_program` — for the ATA token accounts, matching the
  IDL's ATA `pda` (seeds `[owner, token_program, mint]`, program = the Associated-Token program).
- `seeds = […], bump` — from `pda.seeds`. Existing PDAs verify against their **stored** bump
  (`bump = <account>.bump`, cheap); only `init` accounts use bare `bump` (derive canonical + store).
  Every state struct's first field is `bump: u8` precisely for this.
- `address = …` / typed `Program<…>` — only for the 5 IDL-fixed program accounts (`program` =
  `crate::ID`, `system_program`, `jupiter_program`, `token_program` = `Program<Token>`,
  `token_program2022` = `Program<Token2022>`).
- `init, payer, space` — the 5 create-instructions. **`space = X::DISCRIMINATOR.len() +
  X::INIT_SPACE`** (Anchor-derived), and a **compile-time `assert!` guards each derived size against
  the on-chain-measured constant** (`ADMIN_POOL_SPACE=259`, `MONEY_MANAGER_POOL_SPACE=145`,
  `VAULT_POOL_SPACE=374`, `ORACLE_POOL_SPACE=208`, `INVESTOR_POOL_SPACE=233`,
  `ASSET_REGISTRY_INIT_SPACE=109`) in `state.rs` — if a struct layout drifts, the build fails.
  Two reconciliations make `INIT_SPACE` match the measured sizes exactly: `AssetRegistry.asset_mints`
  uses `#[max_len(0)]` (it's created empty and realloc-grown +32/asset in the trade handler; a
  3-asset registry is 205 = 109 + 3×32), and `OraclePool` carries a `reserved: [u8;4]` for the 4
  trailing bytes the recovered IDL undercounts against the on-chain 208-byte allocation.
- **Upgrade-authority gate on `create_admin_pool`** (inferred from account presence, not IDL-encoded):
  the instruction already passes `program` + `program_data`, so bootstrap is restricted to the
  program's upgrade authority — `program.programdata_address()? == Some(program_data.key())` and
  `program_data.upgrade_authority_address == Some(admin.key())`.

Deliberately **not** added: `init_if_needed` on the vault ATAs. Anchor's `init_if_needed` for an ATA
requires an `associated_token_program` account in the context, which `deposit`/`swap` do **not** have
in the IDL — so the deployed program does not create these ATAs via the accounts struct.
They pre-exist or are created by a handler CPI; adding `init_if_needed` would add an account the IDL
lacks and thus diverge.
- `Signer` / `mut` — from the IDL `signer`/`writable` flags.

Deliberately **not** done (would diverge from the original): signer-name→`has_one` inference,
`address = <state>.<field>` re-expressions, `token::*` in place of `associated_token::*`, and any
oracle/status/slippage/authorization checks the IDL doesn't surface. Creators (`admin`/`investor`/
`money_manager` in `create_*`) are plain `Signer`s — they *set* the first authority, so they carry no
constraint against the (zeroed) account being initialized.

The remaining `UncheckedAccount /// CHECK` accounts (`program_data`, the fee-recipient `admin` in
`swap`/`create_vault` which is tied to the admin pool by `has_one = admin`, and the new-value setter
inputs `operator`/`pending_admin`) are accounts the IDL encodes no accounts-struct constraint for; each
is either constrained by a `has_one` on a sibling account or is an arbitrary target the handler records.

## Notes

- Handlers are implemented (see "Instruction handlers" below); the account structs remain a faithful
  IDL reconstruction while handler logic is reconstructed from events/errors/args (flagged inline).
- Heavy multi-account contexts use `Box<Account<..>>` to keep `try_accounts` stack frames < 4 KB.
- `declare_id!` uses the local placeholder (matches `Anchor.toml` / the generated keypair). Original
  mainnet id: `DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm`.

## Instruction handlers (implemented, in execution order)

Layout is idiomatic: `src/instructions/<name>.rs` holds each `#[derive(Accounts)]` beside its handler
`pub fn <name>(...)`, re-exported via `instructions/mod.rs`; `lib.rs`'s `#[program]` delegates to them.
Shared helpers live in `src/util.rs` (`oracle_value_usd`, `grow_registry`, `read_token_amount`,
`spl_transfer_signed`).

The account structs are a direct IDL reconstruction (per the rules above); handler *logic* is not in
the IDL and is reconstructed from the events (state changes), errors (validations), and args, then
checked against the deployed program with the differential test suite. `RPC_FINDINGS.md` records the
exact behavior each handler reproduces and the two economic-core behaviors that are not yet byte-exact.

- **Bootstrap / admin** — `create_admin_pool` (upgrade-authority gated), `admin_modify_fee`, the 12
  `admin_update_*`, `admin_transfer_ownership` / `admin_accept_ownership`: authorization guard, bps
  validation, field updates, events.
- **Oracle** — `create/approve/update/close_oracle_pool` (`close = admin` returns rent), `get_price_info`
  (Pyth read with staleness).
- **Manager / vault** — `create_money_manager_pool`, `create_vault` (fee-cap checks, creation-fee SOL
  transfer, timestamp initialization, empty registry), `set/revoke_trading_delegate`, `close_vault`.
- **Investor** — `create_investor_pool`, `deposit_token_fund` (oracle-priced, `transfer_checked`, shares
  against `raised_amount_usd`).
- **Trading** — `swap` (Jupiter CPI passthrough via `invoke_signed` with the vault-PDA seed, canonical
  price-account check, slippage guard, `trading_fee`, both-leg registry growth).
- **Fees / redemption** — `withdraw_token_fund` (pro-rata in-kind basket over `remaining_accounts` groups
  of 7, recipient validation, high-watermark performance fee) and `withdraw_money_management_fee`
  (per-asset in-kind streamed fee over groups of 4, operator/timing gates, recipient validation).

Anchor 1.x notes encountered: `CpiContext::new(program_id: Pubkey, ...)` (pass `.key()`, not
`AccountInfo`); `Context<'info, T>` has a single lifetime; `AccountInfo::resize` (not `realloc`).
