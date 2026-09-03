/**
 * Global server error capture. Next calls `onRequestError` for any error thrown while handling a
 * request; we forward it to the error reporter (which sends to Sentry when SENTRY_DSN is set, and is
 * inert otherwise). No SDK — the reporter speaks Sentry's ingest protocol directly.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string> },
): Promise<void> {
  const { reportError } = await import('./lib/log');
  reportError(err, { path: request?.path, method: request?.method });
}
