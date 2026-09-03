import Link from 'next/link';
import { WalletButton } from './WalletButton';
import { SignIn } from './SignIn';
import { CLUSTER } from '@/lib/config';

const links = [
  { href: '/', label: 'Vaults' },
  { href: '/create', label: 'Create' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/launches', label: 'Launches' },
  { href: '/points', label: 'Points' },
  { href: '/account', label: 'Account' },
  { href: '/admin', label: 'Admin' },
];

export function Nav() {
  return (
    <header className="border-b border-[#1e2230]">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            FBYT
            <span className="rounded bg-[#1a1f2b] px-1.5 py-0.5 text-[10px] font-normal uppercase opacity-60">{CLUSTER}</span>
          </Link>
          <div className="flex gap-4 text-sm opacity-80">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="hover:opacity-100">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SignIn />
          <WalletButton />
        </div>
      </nav>
    </header>
  );
}
