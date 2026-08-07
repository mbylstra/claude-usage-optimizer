import { describe, expect, it } from 'vitest';
import { paceDescription } from '@/lib/paceDescription';
import { paceTone } from '@/lib/paceTone';
import type { DerivedWindowStatus } from '@/lib/usageTypes';
import {
  FIVE_HOUR_AHEAD_MODERATE,
  FIVE_HOUR_AHEAD_SEVERE,
  FIVE_HOUR_AHEAD_SLIGHT,
  FIVE_HOUR_BEHIND,
  FIVE_HOUR_ON_PACE,
  SEVEN_DAY_AHEAD_MODERATE,
  SEVEN_DAY_AHEAD_SEVERE,
  SEVEN_DAY_AHEAD_SLIGHT,
  SEVEN_DAY_BEHIND,
  SEVEN_DAY_ON_PACE,
} from './usageFixtures';

/**
 * The fixtures are run through the real pace engine, so they cannot show an
 * impossible state — but they can quietly land on the wrong rung of the ramp
 * and make a story called "slightly ahead" render red. That has happened once
 * already (see the Phase 3 note in plans/mvp-chrome-extension.md), so the tone
 * each story claims is asserted here.
 */

function toneAndCopy(status: DerivedWindowStatus): [string, string] {
  if (!status.isActive) throw new Error('expected an active window fixture');
  return [paceTone(status.paceStatus, status.paceSeverity), paceDescription(status.paceDeltaMs)];
}

describe('five-hour fixtures', () => {
  it('sit on the rung each story names', () => {
    expect(toneAndCopy(FIVE_HOUR_ON_PACE)).toEqual(['onPace', 'On pace']);
    expect(toneAndCopy(FIVE_HOUR_AHEAD_SLIGHT)).toEqual(['aheadSlight', '21m ahead of pace']);
    expect(toneAndCopy(FIVE_HOUR_AHEAD_MODERATE)).toEqual(['aheadModerate', '36m ahead of pace']);
    expect(toneAndCopy(FIVE_HOUR_AHEAD_SEVERE)).toEqual(['aheadSevere', '1h 24m ahead of pace']);
    expect(toneAndCopy(FIVE_HOUR_BEHIND)).toEqual(['behind', '1h 24m behind pace']);
  });
});

describe('weekly fixtures', () => {
  it('sit on the rung each story names', () => {
    expect(toneAndCopy(SEVEN_DAY_ON_PACE)).toEqual(['onPace', '27m ahead of pace']);
    expect(toneAndCopy(SEVEN_DAY_AHEAD_SLIGHT)).toEqual(['aheadSlight', '13h 54m ahead of pace']);
    expect(toneAndCopy(SEVEN_DAY_AHEAD_MODERATE)).toEqual(['aheadModerate', '1d 6h ahead of pace']);
    expect(toneAndCopy(SEVEN_DAY_AHEAD_SEVERE)).toEqual(['aheadSevere', '2d 21h ahead of pace']);
    expect(toneAndCopy(SEVEN_DAY_BEHIND)).toEqual(['behind', '1d 14h behind pace']);
  });
});
