import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const schema = z.object({
  API_511_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  OPERATOR_ID: z.string().default('SF'),
  KEEP_FEED_VERSIONS: z.coerce.number().int().min(0).default(3),
  STATIC_INGEST_CRON: z.string().default('0 4 * * *'),
  LOG_LEVEL: z.string().default('info'),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
