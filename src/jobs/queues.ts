import { Queue } from 'bullmq';
import { config } from '../config.ts';

export const connection = { url: config.REDIS_URL };

export const STATIC_INGEST_QUEUE = 'static-ingest';
export const TIMEZONE = 'America/Los_Angeles';

export interface StaticIngestJob {
  operatorId: string;
}

export function staticIngestQueue() {
  return new Queue<StaticIngestJob>(STATIC_INGEST_QUEUE, { connection });
}
