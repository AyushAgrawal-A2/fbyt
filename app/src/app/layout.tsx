import './globals.css';
import type { Metadata } from 'next';
import { Providers } from './providers';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'FBYT — on-chain vaults',
  description: 'Non-custodial, share-based asset-management vaults on Solana.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
