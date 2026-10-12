import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import type { ColumnSpec, TableSpec } from './tables.ts';

/** A problem with the feed's contents. Retrying won't help until the publisher fixes it. */
export class FeedError extends Error {
  override name = 'FeedError';
}

const NULL_MARKER = '\\N';

/**
 * Streams one GTFS file into its table with COPY, tagging every row with the
 * feed version. Returns the number of rows loaded.
 */
export async function copyTable(
  client: pg.PoolClient,
  feedVersionId: number,
  spec: TableSpec,
  input: Readable,
): Promise<number> {
  const columns = ['feed_version_id', ...spec.columns.map((c) => c.column)];
  const copy = client.query(
    copyFrom(
      `COPY ${spec.table} (${columns.join(', ')}) FROM STDIN WITH (FORMAT csv, NULL '${NULL_MARKER}')`,
    ),
  );

  let rowCount = 0;
  await pipeline(
    input,
    parse({
      bom: true,
      columns: (header: string[]) => checkHeader(spec, header),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }),
    async function* (records: AsyncIterable<Record<string, string>>) {
      for await (const record of records) {
        rowCount++;
        const values = spec.columns.map((col) => fieldValue(spec, col, record, rowCount));
        yield toCsvLine([feedVersionId, ...values]);
      }
    },
    copy,
  );
  return rowCount;
}

function checkHeader(spec: TableSpec, header: string[]): string[] {
  const names = header.map((h) => h.trim());
  const missing = spec.columns
    .filter((c) => c.required && !names.includes(c.source ?? c.column))
    .map((c) => c.source ?? c.column);
  if (missing.length > 0) {
    throw new FeedError(`${spec.file} is missing required columns: ${missing.join(', ')}`);
  }
  return names;
}

function fieldValue(
  spec: TableSpec,
  col: ColumnSpec,
  record: Record<string, string>,
  row: number,
): string | number | null {
  const name = col.source ?? col.column;
  const raw = record[name] ?? '';
  if (raw === '') {
    if (col.defaultValue !== undefined) return col.defaultValue;
    if (col.required) throw new FeedError(`${spec.file} data row ${row}: ${name} is blank`);
    return null;
  }
  if (!col.parse) return raw;
  try {
    return col.parse(raw);
  } catch (err) {
    throw new FeedError(`${spec.file} data row ${row}: ${(err as Error).message}`);
  }
}

/** Encodes values as one line of COPY CSV. null becomes the NULL marker; '' stays an empty string. */
export function toCsvLine(values: (string | number | null)[]): string {
  return (
    values
      .map((v) => {
        if (v === null) return NULL_MARKER;
        const s = String(v);
        return /[",\r\n]/.test(s) || s === NULL_MARKER || s === ''
          ? `"${s.replaceAll('"', '""')}"`
          : s;
      })
      .join(',') + '\n'
  );
}

// Cross-file references that GTFS requires but publishers sometimes get wrong.
// These are recorded on the feed version rather than failing the load.
const VALIDATION_CHECKS: Record<string, string> = {
  trips_missing_route: `
    SELECT count(*)::int AS n FROM gtfs_trips t
    WHERE t.feed_version_id = $1 AND NOT EXISTS (
      SELECT 1 FROM gtfs_routes r WHERE r.feed_version_id = $1 AND r.route_id = t.route_id)`,
  trips_missing_service: `
    SELECT count(*)::int AS n FROM gtfs_trips t
    WHERE t.feed_version_id = $1
      AND NOT EXISTS (SELECT 1 FROM gtfs_calendar c
                      WHERE c.feed_version_id = $1 AND c.service_id = t.service_id)
      AND NOT EXISTS (SELECT 1 FROM gtfs_calendar_dates d
                      WHERE d.feed_version_id = $1 AND d.service_id = t.service_id)`,
  stop_times_missing_trip: `
    SELECT count(*)::int AS n FROM gtfs_stop_times st
    WHERE st.feed_version_id = $1 AND NOT EXISTS (
      SELECT 1 FROM gtfs_trips t WHERE t.feed_version_id = $1 AND t.trip_id = st.trip_id)`,
  stop_times_missing_stop: `
    SELECT count(*)::int AS n FROM gtfs_stop_times st
    WHERE st.feed_version_id = $1 AND NOT EXISTS (
      SELECT 1 FROM gtfs_stops s WHERE s.feed_version_id = $1 AND s.stop_id = st.stop_id)`,
};

export async function validateFeed(
  client: pg.PoolClient,
  feedVersionId: number,
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  for (const [check, sql] of Object.entries(VALIDATION_CHECKS)) {
    const { rows } = await client.query<{ n: number }>(sql, [feedVersionId]);
    results[check] = rows[0]?.n ?? 0;
  }
  return results;
}
