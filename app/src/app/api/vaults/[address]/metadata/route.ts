import { NextRequest, NextResponse } from 'next/server';
import { createSolanaRpc, type Address } from '@solana/kit';
import { RPC_URL } from '@/lib/config';
import { fetchMaybeVaultPool } from '@/generated';
import { getMetadata, setMetadata } from '@/lib/metadataStore';
import { metadataMessage, verifyEd25519 } from '@/lib/verifySig';

const MAX_AGE_MS = 5 * 60 * 1000;

/** GET /api/vaults/[address]/metadata — the vault's off-chain profile, or null. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return NextResponse.json({ metadata: await getMetadata(address) });
}

/**
 * PUT /api/vaults/[address]/metadata  { name, description, strategy, signer, signature, issuedAt }
 * Sets the profile. The write is authorized by an Ed25519 signature from the vault's on-chain money
 * manager over a canonical, time-bounded message — no session/DB required.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await params;
    const body = await req.json();
    const { name, description, strategy, signer, signature, issuedAt } = body ?? {};
    if (typeof signer !== 'string' || typeof signature !== 'string' || typeof issuedAt !== 'number') {
      return NextResponse.json({ error: 'signer, signature, issuedAt required' }, { status: 400 });
    }
    if (Math.abs(Date.now() - issuedAt) > MAX_AGE_MS) {
      return NextResponse.json({ error: 'signature expired' }, { status: 401 });
    }
    const msg = new TextEncoder().encode(metadataMessage(address, issuedAt));
    if (!verifyEd25519(signer, msg, Buffer.from(signature, 'base64'))) {
      return NextResponse.json({ error: 'bad signature' }, { status: 401 });
    }

    // the signer must be the vault's on-chain money manager
    const rpc = createSolanaRpc(RPC_URL);
    const vault = await fetchMaybeVaultPool(rpc, address as Address);
    if (!vault.exists) return NextResponse.json({ error: 'no vault at this address' }, { status: 404 });
    if (String(vault.data.moneyManager) !== signer) {
      return NextResponse.json({ error: 'signer is not the vault manager' }, { status: 403 });
    }

    const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
    await setMetadata(address, {
      name: clip(name, 80),
      description: clip(description, 500),
      strategy: clip(strategy, 200),
      updatedBy: signer,
      updatedAt: Date.now(),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
