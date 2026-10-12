import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import unzipper from 'unzipper';

/** Where GTFS files are read from: a downloaded zip, or a plain directory (tests, local debugging). */
export interface FeedSource {
  /** Returns a stream of the named file, or null if the feed doesn't include it. */
  open(fileName: string): Promise<Readable | null>;
}

export async function zipSource(zipPath: string): Promise<FeedSource> {
  const directory = await unzipper.Open.file(zipPath);
  return {
    async open(fileName) {
      // Some publishers nest files in a folder inside the zip, so match on basename.
      const entry = directory.files.find(
        (f) => f.type === 'File' && path.posix.basename(f.path) === fileName,
      );
      return entry ? entry.stream() : null;
    },
  };
}

export function directorySource(dir: string): FeedSource {
  return {
    async open(fileName) {
      const filePath = path.join(dir, fileName);
      try {
        await access(filePath);
      } catch {
        return null;
      }
      return createReadStream(filePath);
    },
  };
}
