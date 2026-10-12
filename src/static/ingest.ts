import type pg from 'pg';
import type { Config } from '../config.ts';
import { FeedError, copyTable, validateFeed } from '../gtfs/load.ts';
import { type FeedSource, zipSource } from '../gtfs/source.ts';
import { GTFS_TABLES } from '../gtfs/tables.ts';
import { FetchError, downloadStaticFeed } from './fetch.ts';

export type IngestResult =
  | { status: 'skipped'; reason: 'unchanged' | 'locked'; feedVersionId?: number }
  | {
      status: 'activated';
      feedVersionId: number;
      rowCounts: Record<string, number>;
      validation: Record<string, number>;
      prunedVersionIds: number[];
    };

export interface LoadOptions {
  operatorId: string;
  sha256: string;
  sourceUrl: string | null;
  source: FeedSource;
  keepVersions: number;
}

/**
 * Loads a static feed as a new version and makes it the active schedule.
 *
 * - Skips the load if the feed is identical to the active one.
 * - Holds an advisory lock so two ingests for the same operator can't overlap.
 * - Loads every table and activates in one transaction: a failure leaves the
 *   previous schedule active and untouched.
 */
export async function loadFeedVersion(pool: pg.Pool, opts: LoadOptions): Promise<IngestResult> {
  const client = await pool.connect();
  const lockKey = `static-ingest:${opts.operatorId}`;
  try {
    const { rows: lock } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [lockKey],
    );
    if (!lock[0]?.locked) return { status: 'skipped', reason: 'locked' };

    try {
      const { rows: active } = await client.query<{ id: number; sha256: string }>(
        `SELECT id, sha256 FROM feed_versions WHERE operator_id = $1 AND status = 'active'`,
        [opts.operatorId],
      );
      if (active[0]?.sha256 === opts.sha256) {
        return { status: 'skipped', reason: 'unchanged', feedVersionId: active[0].id };
      }

      const { rows: inserted } = await client.query<{ id: number }>(
        `INSERT INTO feed_versions (operator_id, sha256, source_url) VALUES ($1, $2, $3) RETURNING id`,
        [opts.operatorId, opts.sha256, opts.sourceUrl],
      );
      const feedVersionId = inserted[0]!.id;

      const { rowCounts, validation } = await loadAndActivate(client, feedVersionId, opts);
      const prunedVersionIds = await pruneVersions(client, opts.operatorId, opts.keepVersions);
      return { status: 'activated', feedVersionId, rowCounts, validation, prunedVersionIds };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    }
  } finally {
    client.release();
  }
}

async function loadAndActivate(client: pg.PoolClient, feedVersionId: number, opts: LoadOptions) {
  try {
    await client.query('BEGIN');
    const rowCounts: Record<string, number> = {};
    for (const spec of GTFS_TABLES) {
      const stream = await opts.source.open(spec.file);
      if (!stream) {
        if (spec.required) throw new FeedError(`Feed is missing ${spec.file}`);
        continue;
      }
      rowCounts[spec.table] = await copyTable(client, feedVersionId, spec, stream);
    }
    if (!('gtfs_calendar' in rowCounts) && !('gtfs_calendar_dates' in rowCounts)) {
      throw new FeedError('Feed has neither calendar.txt nor calendar_dates.txt');
    }
    const validation = await validateFeed(client, feedVersionId);

    await client.query(
      `UPDATE feed_versions SET status = 'superseded' WHERE operator_id = $1 AND status = 'active'`,
      [opts.operatorId],
    );
    await client.query(
      `UPDATE feed_versions
       SET status = 'active', row_counts = $2, validation = $3, finished_at = now(), activated_at = now()
       WHERE id = $1`,
      [feedVersionId, rowCounts, validation],
    );
    await client.query('COMMIT');
    return { rowCounts, validation };
  } catch (err) {
    await client.query('ROLLBACK');
    const error = asFeedError(err);
    await client.query(
      `UPDATE feed_versions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [feedVersionId, error.message],
    );
    throw error;
  }
}

/** Postgres data and constraint errors (bad numbers, duplicate ids) mean the feed itself is bad. */
function asFeedError(err: unknown): Error {
  const code = (err as { code?: string }).code;
  if (code?.startsWith('22') || code?.startsWith('23')) {
    const where = (err as { where?: string }).where;
    return new FeedError(`${(err as Error).message}${where ? ` (${where})` : ''}`, { cause: err });
  }
  return err as Error;
}

/** Deletes superseded versions beyond the newest `keep`. Failed versions are kept as history; they hold no rows. */
async function pruneVersions(client: pg.PoolClient, operatorId: string, keep: number): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(
    `DELETE FROM feed_versions WHERE id IN (
       SELECT id FROM feed_versions
       WHERE operator_id = $1 AND status = 'superseded'
       ORDER BY id DESC OFFSET $2
     ) RETURNING id`,
    [operatorId, keep],
  );
  return rows.map((r) => r.id);
}

/** Downloads the operator's current feed from 511 and loads it if it changed. */
export async function runStaticIngest(pool: pg.Pool, config: Config): Promise<IngestResult> {
  if (!config.API_511_KEY) throw new FetchError('API_511_KEY is not set', false);
  const feed = await downloadStaticFeed(config.API_511_KEY, config.OPERATOR_ID);
  try {
    return await loadFeedVersion(pool, {
      operatorId: config.OPERATOR_ID,
      sha256: feed.sha256,
      sourceUrl: feed.sourceUrl,
      source: await zipSource(feed.zipPath),
      keepVersions: config.KEEP_FEED_VERSIONS,
    });
  } finally {
    await feed.cleanup();
  }
}
