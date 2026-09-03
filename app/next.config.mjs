/** @type {import('next').NextConfig} */
const nextConfig = {
  // self-contained server bundle for the Docker image
  output: 'standalone',
  // @solana/kit and friends are ESM; Next transpiles them fine. Keep server externals lean.
  serverExternalPackages: [],
  // don't let the dev file-watcher react to the SQLite DB / WAL files the keeper + indexer write
  // (external-process writes would otherwise trigger a dev recompile and drop in-flight requests)
  webpack: (config) => {
    const ignored = ['**/node_modules/**', '**/.next/**', '**/.data/**'];
    config.watchOptions = { ...(config.watchOptions ?? {}), ignored };
    return config;
  },
};
export default nextConfig;
