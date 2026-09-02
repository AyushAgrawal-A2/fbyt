# FBYT — References & How to Reproduce

Concrete, verifiable sources for every claim in these docs. Captured from the **production**
deployment on 2026-09-01. Anyone can re-run the commands below to reproduce.

---

## A. Public / marketing pages

- Landing: <https://fbyt.io/>
- About: <https://fbyt.io/about>
- App (production): <https://app.fbyt.io/>
- Invest page: <https://app.fbyt.io/invest>
- Careers (role context): <https://fbyt.io/careers> · <https://jobs.solana.com/companies/fbyt-2-ec88b465-043d-457f-8a1e-c9190e3c7e07>
- Socials: <https://x.com/FBYTio> · <https://discord.com/invite/fbyt> · <https://www.youtube.com/@FBYTio>

## B. On-chain identifiers (Solana mainnet)

| Name | Address | Explorer |
|------|---------|----------|
| Program `fbyt_vault` | `DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm` | <https://explorer.solana.com/address/DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm> |
| Global `AdminPool` PDA | `8D4fE8ijbjTC1n5nA1Tmqzkm5CAjryBxbQwrkZ7A1kLE` | <https://explorer.solana.com/address/8D4fE8ijbjTC1n5nA1Tmqzkm5CAjryBxbQwrkZ7A1kLE> |
| Admin key | `FWK5K9x7YCDRGj24LdUR3DZBnfFBeT8Tfp9XX6YB3UaL` | |
| Operator key | `27y3HZuEayKZQv4uxpLuSrgNqYapMEk34kBAU12Cjqxu` | |
| Jupiter program (CPI) | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | |
| Example vault "sins vault" | `3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP` | |
| — its manager | `3ZG6UMMoEbwVLM35j7goThrRyULYCymYGqzBVamGEj2U` | |
| — its `AssetRegistry` | `CL7kRrWuHQV2ZKZD38qMpidhcUHsyS16AuyGUYrbafED` | |
| — base token (USDC) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | |

**Verify the program + its accounts are live (all owned by the program):**

```bash
# program is an upgradeable BPF program
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm",{"encoding":"jsonParsed"}]}'

# vault, admin-pool, asset-registry accounts — owner == the program
curl -s -X POST https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"getMultipleAccounts","params":[["3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP","8D4fE8ijbjTC1n5nA1Tmqzkm5CAjryBxbQwrkZ7A1kLE","CL7kRrWuHQV2ZKZD38qMpidhcUHsyS16AuyGUYrbafED"],{"encoding":"base64"}]}'
# -> all three report "owner":"DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm"
```

## C. Public REST API (`https://app.fbyt.io/api`)

Full route map extracted from the bundle (base path `/api`):

- **auth:** `/auth/get-nonce`, `/auth/signin/wallet`, `/auth/refresh-token`
- **vaults:** `/vaults`, `/vaults/{a}`, `/vaults/{a}/{investors,assets,trades,deposits,withdrawals,pnl-history,entry-prices,performance,trading-volume,management-fees,closeable,orders,order-history,execution-wallet,bots,...}`, `/vaults/manager/{m}/summary`
- **bots:** `/vaults/{a}/bots/{dca,grid,rebalance}`, `/bot/keys`, `/bot/vaults/{a}/trade`, `/bot-trading/halt`
- **investors:** `/investors/{a}/{deposits,withdrawals,portfolio-summary,portfolio-details,performance}`
- **managers:** `/managers/{m}`, `/managers/{m}/{summary,followers,follow}`, `/managers/admin/{m}/verify`
- **oracles:** `/oracles`, `/oracles/{a}`, `/oracles/hermes/validate-feed/{id}`, `/oracles/hermes/price-update/{id}`
- **assets:** `/assets`, `/assets/{symbol}` · **adminPool:** `/admin-pool` · **trades:** `/trades`
- **jupiter:** `/jupiter/quote`, `/jupiter/swap-instructions`
- **points/referrals/terms/admins/tokenLaunches/uploads/fbyt(total|circulating-supply)**

**Reproduce the data used in these docs:**

```bash
# protocol config (fees, caps, slippage, oracle age) — used in README + SECURITY #4/#7
curl -s "https://app.fbyt.io/api/admin-pool"

# leaderboard sort evidence — SECURITY #3
curl -s "https://app.fbyt.io/api/vaults?sortBy=currentPerformance&sortOrder=DESC&limit=3"
#   -> sins vault: currentPnl 38.8 on aumMicroUsd 18318500 (=$18.32), investorCount 4

# a real memecoin swap by the top vault — supports SECURITY #4 (USDC -> FARTCOIN ...pump)
curl -s "https://app.fbyt.io/api/vaults/3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP/trades?limit=2"

# tradable universe (52 assets: crypto + Token-2022 tokenized equities)
curl -s "https://app.fbyt.io/api/assets"          # saved as tradable_assets.json

# access control spot-check: investor list is gated, trades/perf are public
curl -s -o /dev/null -w '%{http_code}\n' "https://app.fbyt.io/api/vaults/3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP/investors"    # 401
curl -s -o /dev/null -w '%{http_code}\n' "https://app.fbyt.io/api/vaults/3KmYr58y1g5u4Xgv8PwpUSr6Nyu3exhYtK5eDgcJyRcP/performance"   # 200
```

## D. The on-chain program IDL

Recovered from the frontend bundle and saved as [`fbyt_vault.idl.json`](./fbyt_vault.idl.json)
(30 instructions, 7 accounts, 40 types, 73 errors).

- **Source chunk (deployed):** `https://app.fbyt.io/_next/static/chunks/08fvycc7quegh.js`
  — contains the program id `DNgg2Fmwch…` and the Jupiter program id `JUP6Lkb…`; the IDL is the
  `JSON.parse('{"address":"","metadata":{"name":"fbyt_vault",...')` payload (Turbopack module `75478`).

**Re-extract it yourself:**

```bash
curl -s "https://app.fbyt.io/_next/static/chunks/08fvycc7quegh.js" -o idlchunk.js
node -e '
  const s=require("fs").readFileSync("idlchunk.js","utf8");
  const k="JSON.parse(", i=s.indexOf(k)+k.length, q=s[i];
  let j=i+1,o="";while(j<s.length){if(s[j]==="\\"){o+=s[j]+s[j+1];j+=2;continue}if(s[j]===q)break;o+=s[j++]}
  require("fs").writeFileSync("fbyt_vault.idl.json",JSON.stringify(JSON.parse((0,eval)(q+o+q)),null,2));
  console.log("ok");
'
```

**Security-relevant IDL items:**

- `dummy_swap` (SECURITY #1) — accounts include `money_manager_input_token_account`,
  `money_manager_output_token_account`; args `input_amount`, `output_amount`.
  Compare with `swap` (has `jupiter_program`, args `data: bytes`).
- `withdraw_token_fund` (SECURITY #6) — iterates the `AssetRegistry`; passes both
  `TokenkegQ…` (SPL) and `TokenzQ…` (Token-2022) programs.
- `set_trading_delegate` / `revoke_trading_delegate` + `VaultPool.trading_delegate` — the bot
  privilege model.
- Error codes `6068 SlippageExceeded`, `6072 UnauthorizedTrader`, `6061 OracleNotApproved`,
  `6052 WithdrawCooldownNotEnded` (full list in the IDL `errors` array).

## E. Frontend bundle — file locations for each finding

Deployed under `https://app.fbyt.io/_next/static/chunks/`:

| Finding | File(s) | What's there |
|---------|---------|--------------|
| IDL, program id, Jupiter CPI (SEC #1) | `08fvycc7quegh.js` | full `fbyt_vault` IDL incl. `dummy_swap`, `swap` |
| QuickNode key (SEC #2) | `0mkr3x9g4~qc7.js`, `0.-33qm4k.fsb.js` | `https://billowing-palpable-morning.solana-mainnet.quiknode.pro/38ca40b33bbae6d45a915957e3d798979617895e/` inside a `useNetworkStore`/`useMemo` RPC selector |
| `X-Wallet-Address` admin header (SEC #5) | `00ytn_~h12oit.js` (8×), `01ea1lrgmchf-.js` (3×), `16-xm5l2drhk2.js` (1×) | e.g. `adminVerify:...{headers:{"X-Wallet-Address":e}}` |
| Endpoint map (API surface) + SIWS auth | `00ytn_~h12oit.js` | the full `endpoints` object (auth/vaults/bots/jupiter/...), plus `getNonce`/`signInWallet`/`refreshToken` |

**Grep to reproduce the leaked key:**

```bash
curl -s "https://app.fbyt.io/_next/static/chunks/0mkr3x9g4~qc7.js" | grep -o 'https://[a-z-]*\.solana-mainnet\.quiknode\.pro/[a-z0-9]*/'
```

## F. External integrations referenced in the bundle

- **Jupiter** aggregator — on-chain CPI (`JUP6Lkb…`) + price API `https://lite-api.jup.ag/price/v3`
- **Pyth / Hermes** — price feeds (`PriceUpdateV2`, `feed_id`); `/oracles/hermes/*` endpoints
- **xStocks / Backed Finance** — tokenized equities (Token-2022), icons at
  `https://xstocks-metadata.backed.fi/...`
- **RPC:** QuickNode (mainnet + devnet, keys in bundle) and public `api.mainnet-beta.solana.com`
- **Ops:** Sentry (`o4511296923893760.ingest.de.sentry.io`), Google Analytics (`G-SSQX510QSG`)

## G. Local evidence artifacts (in this folder)

- [`fbyt_vault.idl.json`](./fbyt_vault.idl.json) — recovered Anchor IDL (primary evidence).
- [`tradable_assets.json`](./tradable_assets.json) — `GET /api/assets` snapshot (52 assets).
- [`api_vaults_response.json`](./api_vaults_response.json) — raw `GET /api/vaults?...&limit=1` (Methodology step 4; contains `address`, `moneyManager`, `tokenMint`, `assetRegistry`, `adminPoolAddress` + nested `adminPool` config).
- [`api_admin-pool_response.json`](./api_admin-pool_response.json) — raw `GET /api/admin-pool` (fees, caps, `maxSlippageBps`, `oracleMaxAge`, `adminAddress`, `operator`).
- [`api_vault_by_address_response.json`](./api_vault_by_address_response.json) — raw `GET /api/vaults/{address}` (full single-vault object incl. `metadata`, `tradingDelegate`).
- [`api_manager_response.json`](./api_manager_response.json) — raw `GET /api/managers/{pubkey}` (manager profile; source of manager pubkeys in step 3).
