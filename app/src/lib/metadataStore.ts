import { dbAll, dbGet, dbPut } from '@/lib/db';

/**
 * Off-chain vault profile metadata (name, description, strategy). Stored in the shared datastore
 * (collection `vaultMetadata`); writes are gated by a manager signature in the API route.
 */
export type VaultMetadata = {
  name: string;
  description: string;
  strategy: string;
  updatedBy: string;
  updatedAt: number;
};

type Row = VaultMetadata & { id: string };

export async function getAllMetadata(): Promise<Record<string, VaultMetadata>> {
  const rows = await dbAll<Row>('vaultMetadata');
  const out: Record<string, VaultMetadata> = {};
  for (const r of rows) out[r.id] = r;
  return out;
}

export async function getMetadata(vault: string): Promise<VaultMetadata | null> {
  return dbGet<Row>('vaultMetadata', vault);
}

export async function setMetadata(vault: string, data: VaultMetadata): Promise<void> {
  await dbPut<Row>('vaultMetadata', { ...data, id: vault });
}
