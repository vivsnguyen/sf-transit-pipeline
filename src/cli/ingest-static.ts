// Usage:
//   npm run ingest:static                       download from 511 and load if changed
//   npm run ingest:static -- --file feed.zip    load a zip you already have (no API request)
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { zipSource } from '../gtfs/source.ts';
import { logger } from '../logger.ts';
import { hashFile } from '../static/fetch.ts';
import { loadFeedVersion, runStaticIngest } from '../static/ingest.ts';

const { values } = parseArgs({ options: { file: { type: 'string' } } });
const pool = createPool(config.DATABASE_URL);

try {
  const started = Date.now();
  const result = values.file
    ? await loadFeedVersion(pool, {
        operatorId: config.OPERATOR_ID,
        sha256: await hashFile(values.file),
        sourceUrl: `file://${path.resolve(values.file)}`,
        source: await zipSource(values.file),
        keepVersions: config.KEEP_FEED_VERSIONS,
      })
    : await runStaticIngest(pool, config);
  logger.info({ ...result, seconds: (Date.now() - started) / 1000 }, 'Static ingest finished');
} catch (err) {
  logger.error({ err }, 'Static ingest failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
