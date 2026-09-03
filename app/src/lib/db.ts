import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The datastore — a single SQLite database (WAL mode) holding every collection as rows of
 * `docs(collection, id, data)`. WAL makes it safe for the Next server, the indexer, and the Rust
 * keeper to read/write the same file concurrently (unlike the old JSON files, which clobbered under
 * cross-process writes). The document API below is unchanged, so call sites didn't move; a production
 * deployment can repoint these same calls at Postgres.
 */
type Doc = Record<string, unknown> & { id: string };

const DB_PATH = process.env.FBYT_DB_PATH ?? join(process.cwd(), '.data', 'fbyt.db');

// cache the connection across hot-reloads / imports within a process
const g = globalThis as unknown as { __fbytDb?: DatabaseSync };
function db(): DatabaseSync {
  if (g.__fbytDb) return g.__fbytDb;
  mkdirSync(join(DB_PATH, '..'), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec('PRAGMA foreign_keys = ON');
  d.exec('CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))');
  g.__fbytDb = d;
  return d;
}

export async function dbAll<T extends Doc = Doc>(collection: string): Promise<T[]> {
  const rows = db().prepare('SELECT data FROM docs WHERE collection = ?').all(collection) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as T);
}

export async function dbGet<T extends Doc = Doc>(collection: string, id: string): Promise<T | null> {
  const row = db().prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : null;
}

export async function dbQuery<T extends Doc = Doc>(collection: string, pred: (d: T) => boolean): Promise<T[]> {
  return (await dbAll<T>(collection)).filter(pred);
}

/** Insert or replace a document by id. */
export async function dbPut<T extends Doc>(collection: string, doc: T): Promise<T> {
  db().prepare('INSERT OR REPLACE INTO docs (collection, id, data) VALUES (?, ?, ?)').run(collection, doc.id, JSON.stringify(doc));
  return doc;
}

/** Merge fields into an existing document (creating it if absent), atomically. */
export async function dbUpdate<T extends Doc>(collection: string, id: string, patch: Partial<T>): Promise<T> {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = d.prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { data: string } | undefined;
    const cur = (row ? JSON.parse(row.data) : { id }) as T;
    const next = { ...cur, ...patch, id } as T;
    d.prepare('INSERT OR REPLACE INTO docs (collection, id, data) VALUES (?, ?, ?)').run(collection, id, JSON.stringify(next));
    d.exec('COMMIT');
    return next;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Append a document with a generated id (or an explicit one), skipping if that id already exists. */
export async function dbAppend<T extends Omit<Doc, 'id'>>(collection: string, doc: T, id?: string): Promise<string> {
  const key = id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const value = JSON.stringify({ ...(doc as Record<string, unknown>), id: key });
  db().prepare('INSERT OR IGNORE INTO docs (collection, id, data) VALUES (?, ?, ?)').run(collection, key, value);
  return key;
}

/** Remove a document. */
export async function dbDelete(collection: string, id: string): Promise<void> {
  db().prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id);
}
