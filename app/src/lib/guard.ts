import { NextRequest, NextResponse } from 'next/server';

/**
 * Per-route request guard: a simple in-memory rate limiter plus a same-origin (CSRF) check for
 * cookie-authenticated mutations. In-memory state is per-instance — fine for a single node; a
 * multi-node deployment would back the limiter with Redis. Returns an error response to short-circuit,
 * or null to proceed.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'local';
}

/** Token-bucket rate limit. Returns true if the request is within the limit. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

/**
 * A cross-site request (browser Origin header present and not matching this host) is a CSRF attempt.
 * Non-browser clients don't send Origin, so they pass — CSRF requires a browser carrying the cookie.
 */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

export function guard(
  req: NextRequest,
  opts: { limit: number; windowMs: number; requireSameOrigin?: boolean },
): NextResponse | null {
  if (opts.requireSameOrigin !== false && !sameOrigin(req)) {
    return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 });
  }
  const key = `${req.nextUrl.pathname}:${clientIp(req)}`;
  if (!rateLimit(key, opts.limit, opts.windowMs)) {
    return NextResponse.json({ error: 'rate limit exceeded, slow down' }, { status: 429 });
  }
  return null;
}
