import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/session';
import { guard } from '@/lib/guard';
import { getOrCreateUser, updateProfile, applyReferral } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** GET /api/users/me — the signed-in user's account (creating a blank one on first read). */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  return NextResponse.json({ user: await getOrCreateUser(me) });
}

/**
 * PUT /api/users/me  { displayName?, bio?, acceptTerms?, referralCode? }
 * Updates the signed-in user's profile / accepts terms / records a referral. Session-gated.
 */
export async function PUT(req: NextRequest) {
  const blocked = guard(req, { limit: 20, windowMs: 60_000 });
  if (blocked) return blocked;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.referralCode === 'string' && body.referralCode.trim()) {
    const r = await applyReferral(me, body.referralCode.trim());
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  }
  const user = await updateProfile(me, { displayName: body.displayName, bio: body.bio, acceptTerms: body.acceptTerms });
  return NextResponse.json({ user });
}
