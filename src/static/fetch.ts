import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const DATAFEEDS_URL = 'https://api.511.org/transit/datafeeds';
const DOWNLOAD_TIMEOUT_MS = 120_000;

export class FetchError extends Error {
  override name = 'FetchError';
  constructor(
    message: string,
    /** Whether trying again later could succeed (rate limits, outages) or not (bad token). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface DownloadedFeed {
  zipPath: string;
  sha256: string;
  /** The URL without the API key, safe to log and store. */
  sourceUrl: string;
  cleanup(): Promise<void>;
}

/** Downloads an operator's static GTFS zip from 511. Uses one request of the hourly rate limit. */
export async function downloadStaticFeed(apiKey: string, operatorId: string): Promise<DownloadedFeed> {
  const url = new URL(DATAFEEDS_URL);
  url.searchParams.set('operator_id', operatorId);
  const sourceUrl = url.toString();
  url.searchParams.set('api_key', apiKey);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new FetchError(`Request to ${sourceUrl} failed: ${(err as Error).message}`, true);
  }
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const retryable = res.status === 429 || res.status >= 500;
    throw new FetchError(`511 returned ${res.status} for ${sourceUrl}: ${body}`, retryable);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtfs-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const zipPath = path.join(dir, `${operatorId}.zip`);
  try {
    await pipeline(Readable.fromWeb(res.body as NodeReadableStream), createWriteStream(zipPath));
    await assertZip(zipPath);
    return { zipPath, sha256: await hashFile(zipPath), sourceUrl, cleanup };
  } catch (err) {
    await cleanup();
    if (err instanceof FetchError) throw err;
    throw new FetchError(`Downloading ${sourceUrl} failed: ${(err as Error).message}`, true);
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

// 511 sometimes answers 200 with an error message instead of a zip.
async function assertZip(filePath: string): Promise<void> {
  const file = await open(filePath);
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(200), 0, 200, 0);
    if (bytesRead < 4 || buffer.toString('latin1', 0, 2) !== 'PK') {
      const preview = buffer.toString('utf8', 0, bytesRead).trim();
      throw new FetchError(`Expected a zip from 511 but got: ${preview}`, true);
    }
  } finally {
    await file.close();
  }
}
