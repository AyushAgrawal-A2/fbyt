# FBYT — Security Considerations & Improvements

Findings from exploring the **production** deployment, ranked by importance. Each has a concrete,
reproducible reference; full commands and file locations are in [`REFERENCES.md`](./REFERENCES.md).
These are observations from black-box exploration + IDL/bundle reading — **not** a source audit, so
items marked *needs confirmation* would need the program source or a devnet test to prove exploitability.

| # | Finding | Severity | Confidence |
|---|---------|----------|------------|
| 1 | `dummy_swap` (pays vault funds to the manager's own accounts) is present in the shipped IDL but **not** in the deployed program | Informational | Confirmed: absent from the deployed bytecode |
| 2 | QuickNode RPC URL **with API key** hard-coded in the client bundle | High | Confirmed |
| 3 | Leaderboard / "top vaults" trivially gameable (raw PnL, no AUM/age weighting) | Medium | Confirmed |
| 4 | Very loose risk params: 10% max slippage + 3-day oracle staleness | Medium | Confirmed (config) |
| 5 | Admin API actions keyed off an `X-Wallet-Address` header | Medium | Confirmed present; auth strength *needs confirmation* |
| 6 | Withdrawals return a multi-token basket priced on possibly-stale oracles | Low–Med | Confirmed (IDL) |
| 7 | Single global `AdminPool` with one admin key = central point of control | Low–Med | Confirmed |

---

## 1. `dummy_swap` — present in the shipped IDL, absent from the deployed program  *(Informational)*

The IDL recovered from the frontend bundle contains, alongside the Jupiter-routed `swap`, a second
instruction **`dummy_swap`** that takes `input_amount` and `output_amount` as **raw caller-supplied
args** and whose account list includes **`money_manager_input_token_account` and
`money_manager_output_token_account`** next to the vault's ATAs. On its face this would transfer tokens
between the vault and the manager's personal wallet, with the amounts chosen by the caller rather than
an aggregator — a rug vector if it were callable.

It is not. Invoking `dummy_swap`'s discriminator against the deployed bytecode returns
`InstructionFallbackNotFound` — the instruction was compiled out of (or never included in) the
mainnet build, so it cannot be called and cannot move funds. The residual issue is IDL/bundle
hygiene: a dangerous-looking scaffolding instruction should not ship in the client-facing IDL, since
it invites exactly this concern.

- **Evidence:** `fbyt_vault.idl.json` → instruction `dummy_swap` (accounts include
  `money_manager_input_token_account`, `money_manager_output_token_account`; args
  `input_amount, output_amount`). Invoking that discriminator on the deployed program yields
  `InstructionFallbackNotFound`.
- **Fix:** regenerate and ship the IDL from the deployed program so it lists only the 29 live
  instructions.

## 2. QuickNode RPC endpoint **with its API key** shipped in the frontend bundle  *(High)*

A full mainnet QuickNode URL including the access token is embedded in client JS:

```
https://billowing-palpable-morning.solana-mainnet.quiknode.pro/38ca40b33bbae6d45a915957e3d798979617895e/
```

Anyone who opens DevTools can extract and reuse it — draining the rate limit and running up the
bill, and (depending on plan) abusing add-on methods. This is a **leaked credential**.

- **Evidence:** deployed chunks `/_next/static/chunks/0mkr3x9g4~qc7.js` and
  `/_next/static/chunks/0.-33qm4k.fsb.js` (used inside a `useNetworkStore`/`useMemo` RPC selector).
- **Fix:** proxy RPC through the backend, or use a domain-restricted/referrer-locked key; rotate the
  exposed one.

## 3. "Top vaults" ranking is trivially gameable  *(Medium)*

The invest page sorts by `sortBy=currentPerformance&sortOrder=DESC` with no weighting by AUM, age,
or drawdown, and min investment is $0. Result: the #1 "TOP VAULT" shows **+38.8% PnL on $18.32 of
AUM**, ranked above vaults with more capital and history. A manager can self-deposit a few dollars,
make one lucky/among-dust trade, and top the leaderboard — actively misleading to investors.

- **Evidence:** `GET /api/vaults?sortBy=currentPerformance&sortOrder=DESC&limit=3` →
  `sins vault` pnl 38.8 / AUM $18.32; `Oil Money` pnl 34.99 / AUM $1.34.
- **Fix:** weight ranking by AUM + track-record length + max drawdown; show realized vs unrealized
  PnL, drawdown, and a Sharpe-like metric; require a minimum AUM/age to appear in "top".

## 4. Loose risk parameters for the asset class  *(Medium)*

Protocol config: `maxSlippageBps = 1000` (**10%**) and `oracleMaxAge = 259200 s` (**3 days**).

- 10% slippage on thin memecoins (BONK, WIF, FARTCOIN, POPCAT, PUMP are all tradable) is wide open
  to **sandwich/MEV** extraction.
- A **3-day-old** price as a swap sanity-check offers little real protection, and the tradable set
  includes **tokenized equities** (AAPLx, TSLAx, NVDAx, SPYx via xStocks/Token-2022) whose Pyth
  feeds are stale nights/weekends — a swap could validate against a badly out-of-date price.

- **Evidence:** `GET /api/admin-pool` (`maxSlippageBps`, `oracleMaxAge`); `tradable_assets.json`
  (memecoins + `assetType: "Equity"` Token-2022 mints).
- **Fix:** tighter, ideally per-asset slippage caps and a much shorter oracle-staleness window;
  block/curb equity swaps outside market hours.

## 5. Admin/privileged API actions carry an `X-Wallet-Address` header  *(Medium — needs confirmation)*

Privileged calls (`managers.adminVerify`, points admin config/adjust, admin stats/leaderboard)
attach the caller's wallet as a plain `X-Wallet-Address` request header. If the backend authorizes
off that header instead of cross-checking the authenticated SIWS/JWT principal, it's an
**authorization bypass** — a header is trivially forgeable.

- **Evidence:** bundle chunks `00ytn_~h12oit.js` (8×), `01ea1lrgmchf-.js` (3×), `16-xm5l2drhk2.js`
  (1×), e.g. `adminVerify:async(e,t,a)=>{await post(endpoints.managers.adminVerify(t),a,{headers:{"X-Wallet-Address":e}})}`.
- **Ask FBYT / fix:** ensure every admin endpoint derives identity from the verified JWT, and treats
  `X-Wallet-Address` as untrusted (or drops it).

## 6. Withdrawals return a pro-rata basket of every vault asset  *(Low–Medium)*

`withdraw_token_fund` sends the investor their share of **each** mint in the `AssetRegistry`, priced
via oracles. Correct on-chain, but: (a) investors receive dust of many tokens rather than clean
base-token value, and (b) the exit value depends on oracle freshness (ties into #4).

- **Evidence:** `fbyt_vault.idl.json` → `withdraw_token_fund` (loops `AssetRegistry`; both SPL &
  Token-2022 programs passed); `WithdrawTokenFundResultEvent` fields.
- **Fix:** offer an optional "auto-swap to base token on exit" path so investors get a single,
  clearly-valued asset back.

## 7. Single global `AdminPool` + single admin key  *(Low–Medium)*

One singleton `AdminPool` PDA and one `admin` key control all fee params, the operator, and oracle
approvals across every vault. The **2-step ownership transfer** (`pending_admin` →
`admin_accept_ownership`) is good practice, but the live admin is a plain keypair.

- **Evidence:** `AdminPool` PDA `8D4fE8ijbjTC1n5nA1Tmqzkm5CAjryBxbQwrkZ7A1kLE`, admin
  `FWK5K9x7YCDRGj24LdUR3DZBnfFBeT8Tfp9XX6YB3UaL` (`GET /api/admin-pool`).
- **Fix:** move admin authority behind a multisig (e.g. Squads) and/or a timelock on fee/param
  changes.

---

## Things done well (worth crediting)

- Genuinely non-custodial: vault assets sit in **PDA-owned ATAs**; the program signs transfers.
- **High-watermark** performance fees (per-investor `hight_watermark` + vault
  `highWatermarkAumMicroUsd`) so managers aren't paid twice on the same gains.
- Clean **manager-vs-delegate** privilege split: a `trading_delegate` (bot) can trade but never
  withdraw.
- **Oracle-gated swaps** (both sides must have an approved Pyth `OraclePool`).
- **2-step** admin ownership transfer.
- Investor list endpoint is auth-gated (`GET /api/vaults/{v}/investors` → 401), while public
  read-only data (trades, performance) is open.
- Comprehensive custom error surface (**73** errors incl. `SlippageExceeded`, `UnauthorizedTrader`,
  `OracleNotApproved`, `WithdrawCooldownNotEnded`).
