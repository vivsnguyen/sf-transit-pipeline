const GTFS_TIME = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;

/**
 * Converts a GTFS time ("08:15:00", "25:30:00") to seconds after the start of
 * the service day. Hours can exceed 23 for trips that run past midnight.
 * Returns null for blank values, which GTFS allows on non-timepoint stops.
 */
export function parseGtfsTime(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = GTFS_TIME.exec(trimmed);
  if (!match) throw new Error(`Invalid GTFS time: "${value}"`);
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Converts a GTFS date ("20260112") to ISO format ("2026-01-12"). */
export function parseGtfsDate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d{8}$/.test(trimmed)) throw new Error(`Invalid GTFS date: "${value}"`);
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}
