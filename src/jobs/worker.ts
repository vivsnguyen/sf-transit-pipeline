import { UnrecoverableError, Worker } from 'bullmq';
import { config } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { FeedError } from '../gtfs/load.ts';
import { logger } from '../logger.ts';
import { FetchError } from '../static/fetch.ts';
import { runStaticIngest } from '../static/ingest.ts';
import { STATIC_INGEST_QUEUE, type StaticIngestJob, TIMEZONE, connection, staticIngestQueue } from './queues.ts';

const pool = createPool(config.DATABASE_URL);
const queue = staticIngestQueue();

// Upserting on every start keeps the schedule in sync with STATIC_INGEST_CRON.
await queue.upsertJobScheduler(
  'static-ingest-daily',
  { pattern: config.STATIC_INGEST_CRON, tz: TIMEZONE },
  {
    name: 'static-ingest',
    data: { operatorId: config.OPERATOR_ID },
    opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
  },
);

const worker = new Worker<StaticIngestJob>(
  STATIC_INGEST_QUEUE,
  async (job) => {
    try {
      return await runStaticIngest(pool, { ...config, OPERATOR_ID: job.data.operatorId });
    } catch (err) {
      // Don't burn retries (and rate limit) on errors that can't fix themselves.
      if (err instanceof FeedError || (err instanceof FetchError && !err.retryable)) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  },
  { connection, concurrency: 1 },
);

worker.on('completed', (job, result) => logger.info({ jobId: job.id, result }, 'Job completed'));
worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'Job failed'),
);
logger.info({ cron: config.STATIC_INGEST_CRON, tz: TIMEZONE }, 'Worker started');

async function shutdown() {
  logger.info('Shutting down');
  await worker.close();
  await queue.close();
  await pool.end();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
