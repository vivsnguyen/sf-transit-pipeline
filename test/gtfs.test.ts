import { describe, expect, it } from 'vitest';
import { toCsvLine } from '../src/gtfs/load.ts';
import { parseGtfsDate, parseGtfsTime } from '../src/gtfs/time.ts';

describe('parseGtfsTime', () => {
  it('converts times to seconds after service-day start', () => {
    expect(parseGtfsTime('00:00:00')).toBe(0);
    expect(parseGtfsTime('08:15:00')).toBe(8 * 3600 + 15 * 60);
  });

  it('allows hours past 24 for after-midnight trips', () => {
    expect(parseGtfsTime('25:30:00')).toBe(25 * 3600 + 30 * 60);
  });

  it('accepts unpadded hours, which some feeds use', () => {
    expect(parseGtfsTime(' 7:05:09')).toBe(7 * 3600 + 5 * 60 + 9);
  });

  it('returns null for blanks and rejects garbage', () => {
    expect(parseGtfsTime('')).toBeNull();
    expect(() => parseGtfsTime('8:15')).toThrow('Invalid GTFS time');
    expect(() => parseGtfsTime('08:61:00')).toThrow('Invalid GTFS time');
  });
});

describe('parseGtfsDate', () => {
  it('converts YYYYMMDD to ISO', () => {
    expect(parseGtfsDate('20260112')).toBe('2026-01-12');
    expect(parseGtfsDate('')).toBeNull();
    expect(() => parseGtfsDate('2026-01-12')).toThrow('Invalid GTFS date');
  });
});

describe('toCsvLine', () => {
  it('quotes only when needed and keeps null distinct from empty string', () => {
    expect(toCsvLine([1, 'plain', null, ''])).toBe('1,plain,\\N,""\n');
    expect(toCsvLine(['a,b', 'say "hi"', '\\N'])).toBe('"a,b","say ""hi""","\\N"\n');
  });
});
