import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Off-chain vault profile metadata (name, description, strategy) the program doesn't store on-chain.
 * The real FBYT platform keeps this in a database behind its API; for the local clone we use a small
 * JSON file. Writes are gated by a manager signature in the API route — this module is just storage.
 */
export type VaultMetadata = {
  name: string;
  description: string;
  strategy: string;
  updatedBy: string;
  updatedAt: number;
};

const FILE = join(process.cwd(), '.data', 'vault-metadata.json');

async function readAll(): Promise<Record<string, VaultMetadata>> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Record<string, VaultMetadata>;
  } catch {
    return {};
  }
}

export async function getAllMetadata(): Promise<Record<string, VaultMetadata>> {
  return readAll();
}

export async function getMetadata(vault: string): Promise<VaultMetadata | null> {
  return (await readAll())[vault] ?? null;
}

export async function setMetadata(vault: string, data: VaultMetadata): Promise<void> {
  const all = await readAll();
  all[vault] = data;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}
