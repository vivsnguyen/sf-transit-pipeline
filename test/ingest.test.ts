import { appendFile, cp, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { FeedError } from '../src/gtfs/load.ts';
import { directorySource } from '../src/gtfs/source.ts';
import { loadFeedVersion } from '../src/static/ingest.ts';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/gtfs-mini');
const pool = createPool(
  process.env.TEST_DATABASE_URL ?? 'postgres://transit:transit@localhost:5432/transit_test',
);

function load(dir: string, sha256: string, keepVersions = 3) {
  return loadFeedVersion(pool, {
    operatorId: 'TEST',
    sha256,
    sourceUrl: null,
    source: directorySource(dir),
    keepVersions,
  });
}

/** Copies the fixture feed so a test can modify it. */
async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtfs-test-'));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

async function versions() {
  const { rows } = await pool.query<{ id: number; sha256: string; status: string }>(
    'SELECT id, sha256, status FROM feed_versions ORDER BY id',
  );
  return rows;
}

beforeAll(async () => {
  await migrate(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE feed_versions CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('loadFeedVersion', () => {
  it('loads every file and activates the version', async () => {
    const result = await load(FIXTURE, 'v1');

    expect(result).toMatchObject({
      status: 'activated',
      rowCounts: {
        gtfs_agency: 1,
        gtfs_stops: 3,
        gtfs_routes: 2,
        gtfs_trips: 2,
        gtfs_stop_times: 5,
        gtfs_calendar: 1,
        gtfs_calendar_dates: 1,
      },
      validation: {
        trips_missing_route: 0,
        trips_missing_service: 0,
        stop_times_missing_trip: 0,
        stop_times_missing_stop: 0,
      },
    });
    expect(await versions()).toMatchObject([{ sha256: 'v1', status: 'active' }]);
  });

  it('parses values into the right shapes', async () => {
    await load(FIXTURE, 'v1');

    const agency = await pool.query('SELECT agency_id, agency_name FROM gtfs_agency');
    expect(agency.rows).toEqual([{ agency_id: '', agency_name: 'Test Muni' }]);

    const stop = await pool.query(`SELECT stop_name, stop_lat FROM gtfs_stops WHERE stop_id = 'S2'`);
    expect(stop.rows).toEqual([{ stop_name: 'Mission St, Inbound', stop_lat: 37.7793 }]);

    const times = await pool.query(
      'SELECT trip_id, stop_sequence, arrival_secs FROM gtfs_stop_times ORDER BY trip_id, stop_sequence',
    );
    expect(times.rows.map((r) => [r.trip_id, r.stop_sequence, r.arrival_secs])).toEqual([
      ['T1', 1, 8 * 3600],
      ['T1', 2, null],
      ['T1', 3, 8 * 3600 + 25 * 60 + 30],
      ['T2', 1, 24 * 3600 + 50 * 60],
      ['T2', 2, 25 * 3600 + 10 * 60],
    ]);

    const calendar = await pool.query('SELECT start_date, end_date FROM gtfs_calendar');
    expect(calendar.rows).toEqual([{ start_date: '2026-01-05', end_date: '2026-12-31' }]);
  });

  it('skips a feed identical to the active one', async () => {
    const first = await load(FIXTURE, 'v1');
    const second = await load(FIXTURE, 'v1');

    expect(second).toEqual({
      status: 'skipped',
      reason: 'unchanged',
      feedVersionId: first.status === 'activated' ? first.feedVersionId : undefined,
    });
    expect(await versions()).toHaveLength(1);
  });

  it('supersedes the old version and prunes beyond the keep limit', async () => {
    await load(FIXTURE, 'v1', 1);
    await load(FIXTURE, 'v2', 1);
    const third = await load(FIXTURE, 'v3', 1);

    expect(await versions()).toMatchObject([
      { sha256: 'v2', status: 'superseded' },
      { sha256: 'v3', status: 'active' },
    ]);
    expect(third).toMatchObject({ prunedVersionIds: [expect.any(Number)] });

    const { rows } = await pool.query('SELECT DISTINCT feed_version_id FROM gtfs_stop_times');
    expect(rows).toHaveLength(2);
  });

  it('marks a bad feed failed and keeps the previous schedule active', async () => {
    await load(FIXTURE, 'v1');
    const bad = await fixtureCopy();
    await writeFile(path.join(bad, 'routes.txt'), 'route_id,route_short_name\nR1,N\n');

    await expect(load(bad, 'v2')).rejects.toThrow(
      new FeedError('routes.txt is missing required columns: route_type'),
    );

    const rows = await versions();
    expect(rows).toMatchObject([
      { sha256: 'v1', status: 'active' },
      { sha256: 'v2', status: 'failed' },
    ]);
    const leftovers = await pool.query('SELECT 1 FROM gtfs_stops WHERE feed_version_id = $1', [rows[1]!.id]);
    expect(leftovers.rowCount).toBe(0);
  });

  it('treats duplicate ids in a feed as a feed error', async () => {
    const dup = await fixtureCopy();
    await appendFile(path.join(dup, 'stops.txt'), 'S1,Duplicate,37.0,-122.0,\n');

    await expect(load(dup, 'v1')).rejects.toBeInstanceOf(FeedError);
    expect(await versions()).toMatchObject([{ status: 'failed' }]);
  });

  it('records broken cross-file references without failing the load', async () => {
    const orphans = await fixtureCopy();
    await appendFile(path.join(orphans, 'trips.txt'), 'R_GONE,NO_SERVICE,T3,Nowhere,0\n');
    await appendFile(path.join(orphans, 'stop_times.txt'), 'T3,09:00:00,09:00:00,S_GONE,1\n');

    const result = await load(orphans, 'v1');

    expect(result).toMatchObject({
      status: 'activated',
      validation: {
        trips_missing_route: 1,
        trips_missing_service: 1,
        stop_times_missing_trip: 0,
        stop_times_missing_stop: 1,
      },
    });
  });

  it('skips when another ingest for the operator holds the lock', async () => {
    const other = await pool.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(hashtext('static-ingest:TEST'))`);
      expect(await load(FIXTURE, 'v1')).toEqual({ status: 'skipped', reason: 'locked' });
    } finally {
      await other.query(`SELECT pg_advisory_unlock(hashtext('static-ingest:TEST'))`);
      other.release();
    }
  });
});
