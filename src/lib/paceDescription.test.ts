import { describe, expect, it } from 'vitest';
import { paceDescription, paceDirection } from './paceDescription';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

describe('paceDescription', () => {
  it('describes being ahead of pace as time', () => {
    expect(paceDescription(36 * MINUTES)).toBe('36m ahead of pace');
  });

  it('describes being behind pace without a minus sign', () => {
    expect(paceDescription(-(2 * HOURS + 10 * MINUTES))).toBe('2h 10m behind pace');
  });

  it('uses the compact two-unit span for week-sized gaps', () => {
    expect(paceDescription(-(3 * DAYS + 4 * HOURS))).toBe('3d 4h behind pace');
  });

  it('says "On pace" only when the gap is under a minute', () => {
    expect(paceDescription(0)).toBe('On pace');
    expect(paceDescription(59 * 1000)).toBe('On pace');
    expect(paceDescription(-59 * 1000)).toBe('On pace');
  });

  it('still names a gap that is inside the ahead/behind tolerance', () => {
    // 4 percentage points of a five-hour window: neutral colour, but 12 real
    // minutes, and the whole point of the change is that we say so.
    expect(paceDescription(12 * MINUTES)).toBe('12m ahead of pace');
  });

  it('treats a non-finite gap as on pace rather than rendering NaN', () => {
    expect(paceDescription(Number.NaN)).toBe('On pace');
  });
});

describe('paceDirection', () => {
  it('points the same way as the wording', () => {
    expect(paceDirection(12 * MINUTES)).toBe('ahead');
    expect(paceDirection(-12 * MINUTES)).toBe('behind');
    expect(paceDirection(30 * 1000)).toBe('even');
  });
});
