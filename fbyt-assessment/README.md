# FBYT — Platform Assessment

On-chain asset-management platform on Solana. This folder is my write-up for the FBYT
Solana Developer assessment: how the product works across frontend / backend / smart-contract
layers, plus a security review with concrete, verifiable evidence.

> **Method.** Everything here was reconstructed from the **production** deployment only
> (`app.fbyt.io`, as instructed): the live UI, the public REST API (`app.fbyt.io/api/*`),
> the Solana mainnet program state, and the **on-chain Anchor IDL** — which I recovered from
> the frontend bundle and saved to [`fbyt_vault.idl.json`](./fbyt_vault.idl.json). I did **not**
> have a wallet, so I did not sign any transaction or create a vault (see
> [The wallet step](#the-wallet-step-what-still-needs-a-wallet)).

## Files in this folder

| File | Contents |
|------|----------|
| [`README.md`](./README.md) | This overview + full platform logic. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | PDA tree, mermaid diagrams (deposit/trade/withdraw), account & instruction reference. |
| [`SECURITY.md`](./SECURITY.md) | Security findings, each with an inline concrete reference. |
| [`REFERENCES.md`](./REFERENCES.md) | Consolidated concrete references + copy-paste commands to reproduce every claim. |
| [`fbyt_vault.idl.json`](./fbyt_vault.idl.json) | The Anchor IDL I recovered from the bundle (30 instructions, 7 accounts, 40 types, 73 errors). |
| [`tradable_assets.json`](./tradable_assets.json) | Live `/api/assets` snapshot (52 assets). |

---

## Key on-chain facts (verified)

| Thing | Value |
|-------|-------|
| Program (upgradeable) | `DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm` |
| Anchor program name / ver | `fbyt_vault` v0.1.0 |
| Global `AdminPool` PDA | `8D4fE8ijbjTC1n5nA1Tmqzkm5CAjryBxbQwrkZ7A1kLE` |
| Admin key | `FWK5K9x7YCDRGj24LdUR3DZBnfFBeT8Tfp9XX6YB3UaL` |
| Operator key | `27y3HZuEayKZQv4uxpLuSrgNqYapMEk34kBAU12Cjqxu` |
| Jupiter program (CPI target) | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| Example vault ("sins vault") | `3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP` |

**Protocol config (from `GET /api/admin-pool` / `adminPool` object):**

| Param | Raw | Human |
|-------|-----|-------|
| `creationFee` | 2000000 lamports | 0.002 SOL per vault |
| `tradingFee` | 1000000 lamports | 0.001 SOL per swap |
| `performanceFeeMax` | 2000 bps | 20% max manager performance fee |
| `moneyManagementFeeMax` | 1500 bps | 15% max annual management fee |
| `protocolPerformanceFee` | 2000 bps | protocol takes 20% of the manager's cut |
| `protocolMoneyManagementFee` | 2000 bps | protocol takes 20% of the manager's cut |
| `maxSlippageBps` | 1000 | **10%** max slippage on swaps |
| `oracleMaxAge` | 259200 s | **3 days** max price-feed staleness |
| `maxAssetCount` | 30 | max distinct mints per vault |
| `idleLimitPeriod` | 7776000 s | 90 days |
| `maxFundRaisingPeriod` | 2592000 s | 30 days |
| `maxCooldownPeriod` | 3888000 s | 45 days |
| `dustThresholdUsd` | 10000 | ~$0.01 |
| `minRaiseAmount` / `minContributionAmount` | 10000 | ~$0.01 floor |

---

## Platform logic

### Roles: Money Manager, Investor, Vault

- **Vault (`VaultPool` PDA)** — the on-chain fund. A program-owned account holding config
  (fees, status, share supply, base `token_mint`) plus an **`AssetRegistry`** listing up to **30**
  token mints it currently holds. Assets themselves live in **Associated Token Accounts owned by
  the `VaultPool` PDA**, so the program — not any human — has custody. This is what makes it
  genuinely non-custodial: the manager can *trade* the assets but can never *transfer them out* to
  a personal wallet through the normal path.
- **Money Manager** — creates and runs a vault (`create_money_manager_pool` → `create_vault`),
  sets fees/terms, executes trades (`swap`), and withdraws their earned management fee
  (`withdraw_money_management_fee`). Signs as `money_manager`. May authorize a bot key via
  `set_trading_delegate` (trade-only, no withdrawal rights).
- **Investor** — deposits the base token (`create_investor_pool` → `deposit_token_fund`),
  receiving **shares**; withdraws via `withdraw_token_fund`. Each investor gets their own
  **`InvestorPool` PDA** tracking `shares`, a personal `high_watermark`, and timestamps.
  Withdrawals need **no manager approval** — only an on-chain cooldown.
- **Admin / Operator (protocol)** — one global **`AdminPool` PDA** holds protocol-wide config
  and fee caps. Ownership transfer is a safe **2-step** (`admin_transfer_ownership` →
  `admin_accept_ownership`).

### How investor assets and ownership are managed

- Ownership is **share-based**, like an ERC-4626 vault. On `deposit_token_fund` the deposit is
  valued in USD via a **Pyth** feed (`PriceUpdateV2`) and shares are minted pro-rata to
  `total_shares × deposit_value / vault_AUM`. The first depositor sets the initial share price.
- **AUM** = every mint in the `AssetRegistry` priced through its approved `OraclePool` (Pyth).
  The API exposes this as `aumMicroUsd`, `totalShares`, `highWatermarkAumMicroUsd`.
- **`withdraw_token_fund(shares)`** burns the investor's shares and returns their **pro-rata slice
  of *every* asset** the vault holds (not just the base token). Gated by a per-vault
  `withdraw_cooldown` and a **high-watermark** so performance fees apply only to genuine new profit.
- **Fees:** `performance_fee` (≤20%, high-watermark based) and `money_management_yearly_fee`
  (≤15%, streamed, collected every `mm_withdraw_period` ≈ 30 days). The protocol skims 20% of each.
  Manager fees are realized at fee-collection / withdraw time — the manager never touches principal.

### How Vault trading and Jupiter routing work

- The manager (or delegated bot) calls **`swap`**, whose account list includes
  `jupiter_program = JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`. The backend builds the route
  off-chain (`POST /api/jupiter/quote`, `POST /api/jupiter/swap-instructions`), passes the
  serialized Jupiter instruction as `data: bytes`, and the program **CPIs into Jupiter** — funds
  move only between the vault's `input`/`output` ATAs.
- **On-chain guardrails wrap the CPI:** both mints must have an **approved `OraclePool`**; the
  program reads `input_price_update` / `output_price_update` (Pyth) and rejects the trade if
  realized slippage exceeds `max_slippage_bps` (`SlippageExceeded`), enforces `max_asset_count`,
  and updates the `AssetRegistry`. A `trading_fee` (SOL) goes to the protocol admin.
- **Tradable universe = 52 curated assets** (see `tradable_assets.json`): majors (SOL, WBTC, WETH),
  LSTs (jitoSOL, mSOL, jupSOL), memecoins (BONK, WIF, FARTCOIN, POPCAT, PUMP), and **tokenized
  equities via xStocks/Backed** (AAPLx, TSLAx, NVDAx, SPYx, …) on **Token-2022**. Each needs an
  admin-approved Pyth feed (`OraclePool`) before it can be traded.
- There is also an **off-chain bot/automation layer** — API endpoints for **DCA, grid, and
  rebalance bots**, `orders`, an `execution-wallet`, and `bot/keys` — that trades on a schedule
  through the vault's `trading_delegate`.

### How PDAs, wallet permissions & signing are structured

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full PDA tree and diagrams. In short:

- All state accounts are **program-owned PDAs**; the `VaultPool` PDA **signs (via seeds)** for every
  token transfer in/out of its ATAs, so users never custody vault assets.
- **Deposit / withdraw:** the *investor* signs; the vault PDA co-signs the token movement.
- **Trade:** `trader` signs and the program checks it equals the `money_manager` **or** the vault's
  `trading_delegate` (`UnauthorizedTrader` / `NoTradingDelegate`). The delegate can trade **but not
  withdraw** — clean privilege separation for bots.
- **Web auth:** Sign-In-With-Solana (`/auth/get-nonce` → wallet signature → `/auth/signin/wallet`
  → JWT). The wallet signature is the only credential.

---

## The wallet step (what still needs a wallet)

I could not complete this part — it requires connecting and signing with a Solana wallet, which I
don't have. It is also **mainnet**, so it costs real funds:

- Creating a vault costs `creation_fee` **0.002 SOL** + PDA rent (`VaultPool` + `AssetRegistry`,
  ≈ another ~0.006 SOL), and each trade costs `trading_fee` **0.001 SOL**.
- Exercising deposit → trade → withdraw needs a few dollars of **USDC** (the common base
  `token_mint`) plus a little SOL for gas/fees.

**Do this in the browser:**

1. `app.fbyt.io` → **Connect Wallet** (Phantom / Solflare / Backpack). This is a gasless
   Sign-In-With-Solana signature.
2. **Manage → Create Vault**: set name/strategy, base token (USDC), min contribution, raise
   amount/period (or mark it *open-ended* to skip fundraising), management fee (≤15%), performance
   fee (≤20%), withdraw cooldown → sign the `create_vault` transaction.
3. **Invest** into your own vault (deposit USDC) → **Trade** (Jupiter swap into e.g. SOL/BONK) →
   **Portfolio → Redeem** to withdraw.
4. The **vault address is the `VaultPool` PDA** — copy it from the vault detail page / URL and send
   it to FBYT (a `app.fbyt.io/invest` link to the vault works too).
