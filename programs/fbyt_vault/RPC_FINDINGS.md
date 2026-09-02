# Behavioral fidelity — reconstruction vs. deployed program

`fbyt_vault` is a source reconstruction of the deployed on-chain program
`DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm`. Its goal is behavioral fidelity: the same accept/reject
decision, error code, and resulting account state as the deployed bytecode on any transaction.

This document records the deployed program's observable behavior that the reconstruction reproduces, and
the small set of behaviors it does **not** yet reproduce exactly. It is a reference for contributors —
before changing any pricing, share, fee, or gating logic, check it against what is recorded here.

## How fidelity is checked

`tests/differential.rs` and the `adversarial*` / `differential_admin` suites load **both** programs in
LiteSVM — the reconstruction and the dumped deployed `.so` (`tests/fixtures/deployed_fbyt_vault.so`) —
and run identical crafted transactions against each, diffing accept/reject, Anchor error number, and the
exact bytes each program writes. This is stronger than matching the IDL/interface: it compares against
the real deployed logic. Anchor error numbers are `6000 + variant index`; the numbers cited below are
part of the program's observable contract.

## Units, pricing, and the Pyth oracle

- **USD amounts are micro-USD** (6 decimal places) throughout.
- **Pyth receiver `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp`** (the "pro" receiver). This is selected
  by enabling the `pro-compatible` feature on `pyth-solana-receiver-sdk` (no fork), which also selects
  the matching push-oracle program id `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou`. Every price handler
  reads `PriceUpdateV2` accounts owned by this receiver.
- **A Pyth `GetPriceError` propagates unmapped.** A stale feed surfaces as `PriceTooOld` (Anchor code
  16000), not a remapped program error; a non-positive price is `InvalidPrice`.
- **`swap` requires the canonical sponsored feed account.** Each price account must be the PDA
  `[shard = 0u16 LE, feed_id]` under the push-oracle program (`util::expected_pyth_price_account`), so a
  trade can only be priced by the sponsored feed and not an arbitrary caller-supplied `PriceUpdateV2`
  (`InvalidPriceOracle` otherwise). Deposit and withdraw do not impose this account-identity check.

## Shares and deposits (`deposit_token_fund`)

- **Shares are priced against the tracked cost basis `raised_amount_usd`, not live holdings.** The first
  deposit mints `shares = raw token amount`; subsequent deposits mint
  `amount_usd * total_shares / raised_amount_usd`. Because the denominator is the tracked raised total
  rather than summed balances, a raw token donation into a vault ATA cannot inflate the share price
  (no first-depositor inflation attack). No per-asset legs are read from `remaining_accounts`.
- **Gates:** the vault must be `Active`; the oracle pool approved; `now <= created_at + raise_period`
  (deposits only during the raise — `OutsideRaisePeriod` for a fixed-term vault, `InvalidAccountData`
  for an open-ended one); and both the raw `amount` and its USD value at least `min_contribute_amount_usd`
  (`InvalidDepositAmount`).
- The deposit updates `raised_amount_usd`, `total_shares`, the investor's `shares`, and the investor's
  `hight_watermark` (cost basis in micro-USD, used later for the performance fee).

## Trading (`swap`)

- 18 fixed accounts followed by `remaining_accounts` = the serialized Jupiter route. The program CPIs
  into Jupiter (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) with the route data passed verbatim.
- **Only the vault PDA is granted signer authority in the CPI** (it signs via seeds); every other route
  account is forwarded without its outer signer flag. The aggregator authorizes moves out of its own
  pools with its own PDAs, so no caller-provided signer is needed or granted.
- **Gates:** `trader` must equal the vault's `money_manager` or its non-default `trading_delegate`
  (`UnauthorizedTrader`); the vault must be `Active`; both oracle pools approved; `now >= created_at +
  raise_period` (`InvalidTradingPeriod` — no trading during the raise); and `raised_amount_usd >=
  min_raise_amount_usd` (`MinRaiseAmountNotReached`).
- **Slippage:** after the CPI, the output value must be within `max_slippage_bps` of the input value
  (`SlippageExceeded`), valued through the canonical Pyth feeds.
- **Registry:** both the input and output mints are recorded in the `AssetRegistry` (input first, each
  only if absent), bounded by `max_asset_count`. A first `base -> X` trade leaves the registry `[base, X]`.
- A `trading_fee` (SOL) is paid to the protocol admin.

## Withdrawals (`withdraw_token_fund`)

- **Pro-rata in-kind basket.** `remaining_accounts` are groups of 7 per asset
  `[oracle_pool, price_update, mint, vault_ata, investor_ata, manager_fee_ata, protocol_fee_ata]`. The
  investor receives `balance * shares / total_shares` of every vault asset. Withdrawals need no manager
  approval.
- **Recipient ATAs are validated** to belong to the investor, money_manager, and protocol admin
  respectively, so a profiting investor cannot redirect their payout or the performance fee.
- **Cooldown:** withdrawals unlock at `created_at + raise_period + withdraw_cooldown` (measured from the
  fundraise end, not the investor's last action). Requesting more shares than owned is `InsufficientFunds`.
- **High-watermark performance fee** on the gain over the investor's `hight_watermark` slice, split
  protocol/manager. See the "Known divergences" section — the exact valuation is not fully reproduced.

## Management fee (`withdraw_money_management_fee`)

- **In-kind streamed, per asset.** `remaining_accounts` are groups of 4
  `[mint, vault_ata, manager_ata, protocol_ata]`. For each asset the accrued fee is
  `balance * yearly_fee_bps * elapsed / (10_000 * SECONDS_PER_YEAR)`, split protocol/manager and
  transferred out of the vault ATA (one event per asset). Recipient ATAs are validated as above.
- **Gates:** the caller must be `admin_pool.operator` (`InvalidOperator`); the vault must have traded
  (`last_trade_at != created_at`, else `NoTradesYet`); it must not be dormant
  (`now <= last_trade_at + idle_period`, else `VaultIsDormant`); and at least one `mm_withdraw_period`
  must have elapsed since `last_mm_fee_withdraw_at` (else `OutsideWithdrawPeriod`).

## Vault lifecycle and state initialization

- On `create_vault` a fresh `VaultPool` initializes `status = Active`, `last_trade_at = created_at` (the
  NoTradesYet sentinel), and `last_mm_fee_withdraw_at = created_at + raise_period` (so the first
  management fee is claimable one `mm_withdraw_period` after the fundraise ends).
- `mm_withdraw_period` must be at least one week (`InvalidWithdrawPeriod`); fees are capped by the admin
  pool; `close_vault` is only allowed after the fundraise period ends (`FundRaisePeriodNotOver`).

## Ownership and admin

- Ownership transfer is two-step: `admin_transfer_ownership` records `pending_admin`, and
  `admin_accept_ownership` requires the pending admin to sign (mismatch → `InvalidPendingAdmin`).
- Admin-authed handlers require the signer to equal `admin_pool.admin` (`InvalidAdmin`); the
  management-fee handler requires `admin_pool.operator` (`InvalidOperator`).

## Instruction set

The program exposes 29 instructions. The recovered IDL additionally lists a `dummy_swap`, but the
deployed bytecode does not dispatch it (`InstructionFallbackNotFound`), so it is not part of this
program.

## Known divergences (not yet reproduced)

Two economic-core behaviors are validated as *different* from the deployed program. Both come down to
integer/valuation formulas that could not be recovered exactly from black-box probing, and both are left
faithful-to-intent but not byte-exact rather than approximated with a guess that could be wrong on
untested inputs.

### Token → USD conversion (affects deposit values and the create-time minimums)

The reconstruction converts a token amount to micro-USD with the straightforward
`amount * price * 10^(6 + exponent - decimals)`. The deployed program agrees exactly for whole-token
quantities but yields **one micro-USD unit less** for sub-1-token amounts (`amount < 10^decimals`):
e.g. at $1.50, `10000 → 14999` and `100000 → 149999`, while `1_000_000 → 1_500_000` and
`100_000_000 → 150_000_000` match exactly. The rounding is not a confidence adjustment (it is independent
of the feed's `conf`); its exact integer form is unknown.

A visible consequence is at `create_vault`: the deployed program converts `min_contribute_amount` and
`min_raise_amount` to USD, checks the converted value against the admin minimum, and stores the converted
value (e.g. raw `10000` at $1.50 is stored as `14999`, and at $1.00 converts to `9999`, which is below
the `10000` admin floor and rejects with `InvalidRaiseAmount`). The reconstruction validates and stores
the raw token amounts. The deposit-minimum boundary still lands on the same accept/reject at the common
`10000` threshold, but for a different internal reason.

### Withdraw performance-fee model

The reconstruction charges the performance fee on the oracle-valued gain of the withdrawn slice over the
investor's cost-basis high-watermark. The deployed program differs in two ways:

- It does **not** mark held base tokens to market — a withdrawal after only a base-token price rise
  (no trading) charges no performance fee.
- On genuine trading gains it charges a somewhat smaller fee than the straightforward oracle-NAV gain
  (observed ≈ 90% of it), and its valuation applies a canonical-price account check conditionally (once
  the registry holds a non-base asset).

The exact model is not fully recovered. When continuing this work, the `WithdrawTokenFundEvent` carries
the deployed program's computed split (`token_price`, `token_exponent`, `amount`, `money_manager_fee`,
`performance_fee`, `admin_fee`) and can be decoded from transaction logs; the deployed multi-asset
withdraw exceeds the 200k default compute budget, so drive it with a raised limit (see
`common::sendp_cu`).

## Other confirmed-faithful details

- Partial withdrawals are exactly pro-rata; a zero or negative price is `InvalidPrice`.
- `WithdrawAmountExceedsLimit` remains defined in the error enum to keep later variants at their on-chain
  discriminants, but the program does not emit it (over-withdraw uses `InsufficientFunds`).
- Native-SOL (wSOL) vaults are not a program concern: the base is an ordinary SPL/wSOL token account and
  wrap/unwrap is handled client-side around the program call.
