/** @type {import('next').NextConfig} */
const nextConfig = {
  // @solana/kit and friends are ESM; Next transpiles them fine. Keep server externals lean.
  serverExternalPackages: [],
};
export default nextConfig;
