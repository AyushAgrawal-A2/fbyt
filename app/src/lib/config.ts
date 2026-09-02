import { address, type Address } from '@solana/kit';

/** RPC endpoint the browser and scripts talk to (defaults to a local surfnet). */
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';

/**
 * Wallet Standard chain the wallet signs for. The local surfnet is a mainnet fork, and browser
 * wallets don't advertise `solana:localnet`, so we ask them to sign for `solana:mainnet` while the
 * client's RPC (RPC_URL above) points at the surfnet where the transaction is actually broadcast.
 */
export const WALLET_CHAIN = (process.env.NEXT_PUBLIC_WALLET_CHAIN ??
  'solana:mainnet') as `solana:${string}`;

/** The reconstructed fbyt_vault program id (its declared id; the local deploy uses it). */
export const FBYT_PROGRAM_ID: Address = address(
  process.env.NEXT_PUBLIC_FBYT_PROGRAM_ID ??
    '3yw2g3VUUGy5vsgBgPaGomxQ95hwEhKprxbeeLhpza5Y',
);

/** Jupiter aggregator id — the `swap` CPI target (a local mock is deployed here for localnet). */
export const JUPITER_PROGRAM_ID: Address = address(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);

export const SYSTEM_PROGRAM_ID: Address = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM_ID: Address = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID: Address = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** USD amounts on-chain are micro-USD (6 dp). */
export const USD_DECIMALS = 6;

/**
 * Demo tradeable output asset seeded by `pnpm bootstrap` on the local surfnet. The manager UI trades
 * the vault's base token into this asset through the bundled jupiter-mock cloned at {@link JUPITER_PROGRAM_ID}.
 * `DEMO_OUT_MINT` is derived (PDA of the program) so it is always a valid address; its Pyth feed id and
 * the mock's liquidity pool seed are fixed so bootstrap, the dev-advance route, and the UI agree.
 */
export const DEMO_OUT_MINT_SEED = 'demo-out-mint';
export const DEMO_OUT_FEED_HEX =
  '2222222222222222222222222222222222222222222222222222222222222222';
export const JUPITER_POOL_SEED = 'pool';
