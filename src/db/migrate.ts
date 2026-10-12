import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../db/migrations');

/** Applies any .sql files in db/migrations that haven't run yet, in filename order. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !applied.has(f))
    .sort();

  for (const name of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return pending;
}

if (import.meta.main) {
  const { config } = await import('../config.ts');
  const { createPool } = await import('./pool.ts');
  const pool = createPool(config.DATABASE_URL);
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  await pool.end();
}
