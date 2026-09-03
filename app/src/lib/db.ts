import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A tiny file-backed JSON document store — the local stand-in for the platform's database. Each
 * collection is one JSON file under `.data/db/` mapping id → document. It is process-serialized (a
 * per-file promise chain) so concurrent writes in the single Next/keeper process don't clobber each
 * other. Fine for a local clone; a production deployment would point these same call sites at Postgres.
 */
const DIR = join(process.cwd(), '.data', 'db');
const locks = new Map<string, Promise<unknown>>();

type Doc = Record<string, unknown> & { id: string };

function file(collection: string): string {
  return join(DIR, `${collection.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

async function readColl<T extends Doc>(collection: string): Promise<Record<string, T>> {
  try {
    return JSON.parse(await readFile(file(collection), 'utf8')) as Record<string, T>;
  } catch {
    return {};
  }
}

/** Serialize a read-modify-write against one collection so concurrent callers don't race. */
async function withColl<T extends Doc, R>(collection: string, fn: (coll: Record<string, T>) => R | Promise<R>): Promise<R> {
  const prev = locks.get(collection) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  locks.set(collection, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    const coll = await readColl<T>(collection);
    const result = await fn(coll);
    await mkdir(DIR, { recursive: true });
    await writeFile(file(collection), JSON.stringify(coll, null, 2));
    return result;
  } finally {
    release();
  }
}

export async function dbAll<T extends Doc = Doc>(collection: string): Promise<T[]> {
  return Object.values(await readColl<T>(collection));
}

export async function dbGet<T extends Doc = Doc>(collection: string, id: string): Promise<T | null> {
  return (await readColl<T>(collection))[id] ?? null;
}

export async function dbQuery<T extends Doc = Doc>(collection: string, pred: (d: T) => boolean): Promise<T[]> {
  return (await dbAll<T>(collection)).filter(pred);
}

/** Insert or replace a document by id. */
export async function dbPut<T extends Doc>(collection: string, doc: T): Promise<T> {
  return withColl<T, T>(collection, (coll) => {
    coll[doc.id] = doc;
    return doc;
  });
}

/** Merge fields into an existing document (creating it if absent). */
export async function dbUpdate<T extends Doc>(collection: string, id: string, patch: Partial<T>): Promise<T> {
  return withColl<T, T>(collection, (coll) => {
    const next = { ...(coll[id] ?? { id }), ...patch, id } as T;
    coll[id] = next;
    return next;
  });
}

/** Append a document with a generated id (or an explicit one), skipping if that id already exists. */
export async function dbAppend<T extends Omit<Doc, 'id'>>(collection: string, doc: T, id?: string): Promise<string> {
  const key = id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await withColl<Doc, void>(collection, (coll) => {
    if (!coll[key]) coll[key] = { ...(doc as Record<string, unknown>), id: key };
  });
  return key;
}
