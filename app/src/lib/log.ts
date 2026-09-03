/**
 * Minimal structured (JSON) logger for server code, plus optional Sentry error reporting via Sentry's
 * stable ingest (envelope) protocol — no SDK, so there's no build/native-dep friction and it's fully
 * inert unless SENTRY_DSN is set. Swap the sink for a hosted logger in production; call sites don't change.
 */
type Meta = Record<string, unknown>;

const DSN = process.env.SENTRY_DSN;
const ingest = (() => {
  if (!DSN) return null;
  try {
    const u = new URL(DSN);
    const projectId = u.pathname.replace(/^\//, '');
    return { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, key: u.username };
  } catch {
    return null;
  }
})();

/** Fire-and-forget: report an error to Sentry if a DSN is configured (best-effort, never throws). */
export function reportError(err: unknown, meta?: Meta): void {
  if (!ingest) return;
  const eventId = globalThis.crypto.randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    environment: process.env.NEXT_PUBLIC_CLUSTER ?? 'production',
    exception: { values: [{ type: err instanceof Error ? err.name : 'Error', value: err instanceof Error ? err.message : String(err) }] },
    extra: meta,
  };
  const body =
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) +
    '\n' + JSON.stringify({ type: 'event' }) +
    '\n' + JSON.stringify(event);
  fetch(ingest.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${ingest.key}, sentry_client=fbyt/1.0` },
    body,
  }).catch(() => {});
}

function emit(level: 'info' | 'warn' | 'error', msg: string, meta?: Meta) {
  const line = JSON.stringify({ level, msg, ...meta, ts: new Date().toISOString() });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, meta?: Meta) => emit('info', msg, meta),
  warn: (msg: string, meta?: Meta) => emit('warn', msg, meta),
  error: (msg: string, err?: unknown, meta?: Meta) => {
    emit('error', msg, { ...meta, error: err instanceof Error ? err.message : err ? String(err) : undefined });
    if (err !== undefined) reportError(err, { msg, ...meta });
  },
};
