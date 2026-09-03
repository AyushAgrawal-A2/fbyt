import { NextRequest, NextResponse } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentUser } from '@/lib/session';
import { dbPut } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), '.data', 'uploads');
const MAX_BYTES = 1_500_000; // ~1.5 MB
const ALLOWED: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * POST /api/uploads  { dataUrl }
 * Stores a small image (a data: URL) and returns its served URL. Session-gated. The platform stores
 * avatars/logos this way; here they live under `.data/uploads/` and are served by /api/uploads/[id].
 */
export async function POST(req: NextRequest) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { dataUrl } = await req.json().catch(() => ({}));
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) return NextResponse.json({ error: 'expected a base64 data URL' }, { status: 400 });
  const mime = m[1];
  if (!ALLOWED[mime]) return NextResponse.json({ error: 'unsupported image type' }, { status: 400 });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: 'image too large (max ~1.5MB)' }, { status: 413 });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, id), bytes);
  await dbPut('uploads', { id, mime, owner: me, createdAt: Date.now() });
  return NextResponse.json({ url: `/api/uploads/${id}` });
}
