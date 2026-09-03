import { dbGet, dbPut, dbUpdate, dbAll } from '@/lib/db';

/**
 * User accounts, points, and referrals — the off-chain identity/loyalty layer the platform keeps in
 * its database, keyed by wallet address. Points are awarded for accepting terms (welcome bonus) and
 * for referrals. Everything is session-gated at the API layer.
 */
export type User = {
  id: string; // wallet address
  displayName: string;
  bio: string;
  points: number;
  referredBy: string | null;
  referralCount: number;
  termsAcceptedAt: number | null;
  createdAt: number;
};

const WELCOME_POINTS = 100;
const REFERRER_POINTS = 50;
const REFEREE_POINTS = 25;

function blank(address: string): User {
  return { id: address, displayName: '', bio: '', points: 0, referredBy: null, referralCount: 0, termsAcceptedAt: null, createdAt: Date.now() };
}

export async function getUser(address: string): Promise<User | null> {
  return dbGet<User>('users', address);
}

export async function getOrCreateUser(address: string): Promise<User> {
  const existing = await dbGet<User>('users', address);
  if (existing) return existing;
  return dbPut('users', blank(address));
}

export async function allUsers(): Promise<User[]> {
  return dbAll<User>('users');
}

/** Update a user's editable profile fields and (once) accept terms with a welcome bonus. */
export async function updateProfile(address: string, patch: { displayName?: string; bio?: string; acceptTerms?: boolean }): Promise<User> {
  const u = await getOrCreateUser(address);
  const next: Partial<User> = {};
  if (typeof patch.displayName === 'string') next.displayName = patch.displayName.slice(0, 40);
  if (typeof patch.bio === 'string') next.bio = patch.bio.slice(0, 280);
  if (patch.acceptTerms && !u.termsAcceptedAt) {
    next.termsAcceptedAt = Date.now();
    next.points = u.points + WELCOME_POINTS;
  }
  return dbUpdate<User>('users', address, next);
}

/** Apply a referral once: the referee records who referred them; both earn points. */
export async function applyReferral(referee: string, referrer: string): Promise<{ ok: boolean; error?: string }> {
  if (referee === referrer) return { ok: false, error: 'cannot refer yourself' };
  const u = await getOrCreateUser(referee);
  if (u.referredBy) return { ok: false, error: 'referral already set' };
  const ref = await getUser(referrer);
  if (!ref) return { ok: false, error: 'unknown referrer' };
  await dbUpdate<User>('users', referee, { referredBy: referrer, points: u.points + REFEREE_POINTS });
  await dbUpdate<User>('users', referrer, { points: ref.points + REFERRER_POINTS, referralCount: ref.referralCount + 1 });
  return { ok: true };
}
