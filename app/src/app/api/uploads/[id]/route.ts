import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dbGet } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/uploads/[id] — serve a stored image with its content type. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-z-]+$/.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const meta = await dbGet<{ id: string; mime: string }>('uploads', id);
  if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const bytes = await readFile(join(process.cwd(), '.data', 'uploads', id));
    return new NextResponse(new Uint8Array(bytes), { headers: { 'content-type': meta.mime, 'cache-control': 'public, max-age=31536000, immutable' } });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
