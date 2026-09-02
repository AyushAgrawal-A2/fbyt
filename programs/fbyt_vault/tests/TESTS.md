# fbyt_vault tests (LiteSVM)

Positive and negative behavior tests for every handler of the reconstructed `fbyt_vault` program, run
against the compiled `.so` in an in-process SVM, plus a differential layer that runs the same
transactions against the dumped deployed program and asserts identical results. They live here as
ordinary Cargo integration tests; `litesvm` and the granular solana crates are `[dev-dependencies]` of
`fbyt_vault`, so `anchor build` (lib-only SBF + IDL host build) never pulls them into the on-chain
program.

## Running

```bash
anchor build                 # produces target/deploy/fbyt_vault.so (loaded by the harness)
cargo test -p fbyt_vault     # 49 tests, 0 ignored  (or: cd programs/fbyt_vault && cargo test)
```

The harness resolves the built program at `target/deploy/fbyt_vault.so` via `CARGO_MANIFEST_DIR`, so it
runs from any directory. The differential tests additionally need the deployed program dump at
`tests/fixtures/deployed_fbyt_vault.so`, and the swap tests need the Jupiter mock built (see below).

## Harness (`tests/common.rs`)

Shared by every test via `mod common;`. Toolchain: litesvm 0.16 on the host rust that also compiles the
program's pyth/solana line, so the SVM and the program share a toolchain.

- Loads the `.so` at the program's declared id (`3yw2g3V…`) via the upgradeable loader (Anchor checks
  `crate::ID` == invocation address). Instructions are built by hand: `sha256("global:<name>")[..8]`
  discriminator + borsh args + account metas whose signer/writable flags mirror the IDL.
- Fixtures are injected as raw accounts with byte-exact layouts: `AdminPool` seeded with the real
  on-chain config values, SPL `Mint` and token accounts at their ATA addresses, and Pyth `PriceUpdateV2`
  accounts owned by the receiver. `set_clock` controls time for cooldown / staleness / fee accrual.
- `inject_canonical_price` / `canonical_price_account` place a `PriceUpdateV2` at the canonical
  sponsored-feed address that `swap` requires. `sendp_cu` sends with a raised compute-unit budget (the
  deployed multi-asset withdraw exceeds the 200k default).
- `bootstrap_vault` (single-program harness) and `bootstrap_p` (differential harness) drive the real
  handlers end-to-end — oracle create+approve → money-manager pool → `create_vault` — to produce a live
  vault other tests build on. `trade_vault` runs a real `swap` through the Jupiter mock.

## Differential testing — the strongest fidelity evidence

`differential.rs`, `differential_admin.rs`, and `adversarial.rs` load **both** programs (the
reconstruction and `fixtures/deployed_fbyt_vault.so`) and run identical transactions against each,
comparing accept/reject, Anchor error number, and — in `differential_admin.rs` — the exact bytes each
program writes (offset- and bump-agnostic, so it also checks struct-layout parity). `differential_admin`
covers the admin ownership/update, oracle-admin, and trading-delegate handlers. `adversarial.rs` holds
hard parity assertions (`local == deployed`) for the crafted-exploit and economic scenarios, and
confirms every IDL instruction actually dispatches on the deployed bytecode.

The two behaviors these suites document as *not* byte-identical to the deployed program — the token→USD
sub-token rounding and the withdraw performance-fee model — are described in `RPC_FINDINGS.md` under
"Known divergences".

## Per-handler coverage

| File | Handlers | Positive | Key negatives |
|------|----------|----------|---------------|
| `bootstrap.rs` | `create_admin_pool` | upgrade-authority bootstraps the admin pool | non-authority signer, fee > 10000 (`InvalidFee`) |
| `admin.rs` | `admin_modify_fee`, `admin_update_max_slippage_bps`, `admin_transfer_ownership`, `admin_accept_ownership` | fee/slippage/ownership updates | bad fee/bps, wrong admin (`InvalidAdmin`), wrong pending admin (`InvalidPendingAdmin`) |
| `oracle.rs` | `create/approve/update/close_oracle_pool` | full lifecycle, rent returned on close | wrong admin (`has_one`), `feed_id` > 66 (`InvalidPriceFeed`) |
| `manager_vault.rs` | `create_money_manager_pool`, `create_vault` | pool + vault created, creation fee charged, status Active | double-create (in-use), `money_management_fee > max` (`InvalidFee`) |
| `vault_ops.rs` | `set/revoke_trading_delegate`, `close_vault`, `get_price_info`, `create_investor_pool` | delegate set/revoke, soft-close, price read, investor pool + count++ | wrong money_manager (`has_one`), `NoTradingDelegate`, `VaultClosed`, stale price (`PriceTooOld`, code 16000), wrong mint |
| `deposit.rs` | `deposit_token_fund` | first-deposit shares = token amount; `transfer_checked` moves tokens | `amount = 0`, below `min_contribute`, vault not Active |
| `multi_asset.rs` | `deposit_token_fund`, `withdraw_token_fund` | deposit priced on `raised_amount_usd` (donation-resistant: a second deposit mints 1:1 regardless of extra held assets, and is accepted with empty `remaining_accounts`); withdraw pays the full per-asset basket with per-asset fee split | — |
| `withdraw_fee.rs` | `withdraw_money_management_fee` | in-kind streamed fee, protocol/manager split, accrual clock advances | too-soon period gate (`OutsideWithdrawPeriod`), wrong operator (`InvalidOperator`) |
| `withdraw_redeem.rs` | `withdraw_token_fund` | full redeem returns pro-rata tokens and burns shares; a profitable redeem charges the reconstruction's high-watermark fee, split 20/80 protocol/manager | zero shares, exceeds held (`InsufficientFunds`), cooldown not ended |
| `swap.rs` | `swap` | full Jupiter CPI round-trip via the mock: input spent, output received, fee paid, both legs registered, `last_trade_at` set | `UnauthorizedTrader`, `VaultNotActive`, `OracleNotApproved` |
| `wsol.rs` | native-SOL (wSOL) vault | full deposit + withdraw on a 9-decimal wSOL-base vault; validates 9-decimal micro-USD scaling | — |
| `differential.rs` | reconstruction vs deployed | identical txs against both programs, diffing accept/reject + state (auth, fee validation, deposit economics, close gate, operator guard, Pyth receiver) | any divergence fails |
| `differential_admin.rs` | reconstruction vs deployed | admin / oracle-admin / trading-delegate handlers + fresh `VaultPool` byte-parity; also asserts every IDL instruction dispatches | wrong-signer / wrong-admin / wrong-money-manager paths |
| `adversarial.rs` | reconstruction vs deployed | crafted exploits and economic scenarios asserted identical on both: recipient-redirect rejection, withdraw cooldown baseline, swap trading-period/min-raise/canonical-price gates, mgmt-fee timing gates and amounts, `dummy_swap` absence, and that every other IDL instruction dispatches | any divergence fails |

## Jupiter mock (`jupiter-mock/`)

`swap`'s positive path CPIs into the Jupiter aggregator. `jupiter-mock/` is a minimal raw-SBF program
(solana-program only; it builds the SPL Token `Transfer` instruction by hand) that reproduces the
observable effect the swap handler measures, authorizing each leg the way the real aggregator does — which
is what lets it drive both the reconstruction and the deployed program:

- **input leg** (tokens out of the vault): the authority is the vault PDA, whose signature propagates from
  the swap's `invoke_signed` (the only signer the swap grants inside the CPI).
- **output leg** (tokens into the vault): sourced from the mock's own `[b"pool"]` PDA, which the mock
  signs for with `invoke_signed` — never a caller-provided signer. The harness funds this source ATA via
  `jupiter_pool_pda()`.

It is its own `[workspace]` (excluded from the Anchor workspace) and is built separately:

```bash
(cd programs/fbyt_vault/tests/jupiter-mock && cargo build-sbf)   # -> target/deploy/jupiter_mock.so
```
