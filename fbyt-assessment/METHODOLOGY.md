# FBYT — Methodology (how every reference was obtained)

All findings were reconstructed from **public sources only** on 2026-09-01 against the production
deployment: (a) the app's own public pages/API, (b) the Solana mainnet chain, (c) the JavaScript the
browser downloads. No wallet, no authenticated/gated data, no on-chain writes. Every step is
reproducible with the commands in [`REFERENCES.md`](./REFERENCES.md).

## Provenance at a glance

| Reference | Source | How derived |
|-----------|--------|-------------|
| Manager pubkeys | app's network traffic | seen in `GET /api/managers/{pubkey}` URLs the frontend calls on `/invest` |
| Vault / AdminPool / AssetRegistry / token addresses | public API JSON | fields in `GET /api/vaults` response (`address`, `moneyManager`, `tokenMint`, `assetRegistry`, `adminPoolAddress`) |
| Admin key, operator key, fee/cap config | public API JSON | nested `adminPool` object in the same response / `GET /api/admin-pool` |
| **Program ID** | **Solana chain** | `getMultipleAccounts` on the vault/admin/registry accounts → their `owner` field |
| Program is upgradeable BPF | Solana chain | `getAccountInfo` on the program id |
| **Full Anchor IDL** (instructions, PDA seeds, `dummy_swap`, errors) | **JS bundle** | `anchor idl fetch` failed (none on-chain) → extracted the embedded IDL from a frontend chunk |
| Jupiter program id | JS bundle (IDL) | `swap` instruction's `jupiter_program` account |
| QuickNode key, `X-Wallet-Address`, endpoint map, integrations | JS bundle | `grep` over downloaded chunks |
| Status codes / leaderboard / trades / assets | public API | direct `curl` probes |

## Step by step

**1. Product recon.** `WebSearch` + `WebFetch` on `fbyt.io`, `/about`, app pages — established the
domain concepts only (no addresses).

**2. Find public surface.** Loaded `app.fbyt.io` in a browser. Home/Manage/Trade are wallet-gated;
**`/invest` is public** — the entry point for everything below.

**3. Manager addresses from network traffic.** `read_network_requests` on the `/invest` tab exposed
the app calling its own backend: `GET /api/vaults?...`, `GET /api/managers/{pubkey}`,
`GET /api/assets`. The manager pubkeys are literally in those request URLs.

**4. Vault/admin/token addresses from API JSON.** Ran `fetch('/api/vaults?limit=1')` from inside the
page (via the browser JS console tool) so it used the page origin. The response gave, per vault:
`address`, `moneyManager`, `tokenMint`, `assetRegistry`, `adminPoolAddress`, and a nested `adminPool`
config object (fees, caps, `maxSlippageBps`, `oracleMaxAge`, `admin`, `operator`). Source of the
config table in README + findings #4/#7.

**5. Program ID from account ownership (the key inference).** Asked mainnet who owns the three
addresses from step 4:
`getMultipleAccounts(["<vault>","<adminPool>","<assetRegistry>"])`. All three reported
`owner = DNgg2FmwchUHYx2QiZ9pNJn1q5zypMprkSWFLUnNDigm`. On Solana a data account's owner *is* the
controlling program — so the program id was derived, not given. `getAccountInfo` confirmed an
upgradeable BPF program.
> First attempt was the RPC call *from inside the browser page* → HTTP 403 (public RPC rejects
> browser-origin requests). Fell back to `curl` via shell, which works.

**6. IDL recovered from the bundle (on-chain fetch failed).** Tried the clean path first:
`anchor idl fetch DNgg2… --provider.cluster mainnet` → **failed** (no IDL account published). So:
downloaded the site HTML + all ~52 `/_next/static/chunks/*.js` with `curl`; grepped chunks for the
program id; it lived in `08fvycc7quegh.js`, which also embeds the **entire Anchor IDL** as a
Turbopack `JSON.parse('{"metadata":{"name":"fbyt_vault"...}')` module. A short Node script walked the
escaped string literal and parsed it → all 30 instructions, PDA seeds, account structs, 73 errors,
`dummy_swap`, Jupiter program id. This is the source for ARCHITECTURE.md and findings #1/#6, saved as
`fbyt_vault.idl.json`.

**7. Secrets + endpoint map via grep.** Plain `grep` across the same chunks surfaced the QuickNode
URL+key (#2), the `X-Wallet-Address` admin header (#5), the full `/api/*` endpoint object, and the
Jupiter/Pyth/xStocks integrations. Each was mapped back to its **real deployed filename** and the URL
re-fetched to confirm it serves (this caught one filename that was an md5 of a local copy, since
corrected).

**8. Behavioural confirmation via curl.** Direct probes confirmed status codes
(`/investors` → 401 gated; `/trades`, `/performance` → 200 public) and pulled the concrete data
behind findings: leaderboard sort (+38.8% PnL on $18 AUM), a live USDC→FARTCOIN memecoin swap, and
the 52-asset universe.

## Tooling used

- **Claude-in-Chrome MCP** — `navigate`, `read_page`/`get_page_text`, `read_network_requests`,
  `javascript_tool` (in-page `fetch`).
- **Shell** — `curl` (Solana JSON-RPC + REST probes + chunk download), `grep`, `node` (IDL
  extraction/parse), `anchor` (attempted IDL fetch), `solana` CLI available.

## Integrity notes / limitations

- Public-only: public pages, public API reads, public RPC reads, public static JS. No signing, no
  writes, no gated data.
- The bundle/IDL prove code **shape**, not runtime exploitability — hence `dummy_swap` (#1) and the
  `X-Wallet-Address` header (#5) are flagged *needs confirmation*, provable only with program source
  or a devnet test.
- Snapshot in time (2026-09-01). Chunk filenames and vault data change on redeploy; the extraction
  method (grep program id → find embedded IDL) is stable even if filenames rotate.
