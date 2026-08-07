import { describe, expect, it } from 'vitest';
import { paceDescription } from './paceDescription';

describe('paceDescription', () => {
  it('describes being ahead of pace', () => {
    expect(paceDescription('ahead', 12.4)).toBe('12 points ahead of pace');
  });

  it('describes being behind pace without a minus sign', () => {
    expect(paceDescription('behind', -8.2)).toBe('8 points behind pace');
  });

  it('says "On pace" without a number when on track', () => {
    expect(paceDescription('onTrack', 2)).toBe('On pace');
    expect(paceDescription('onTrack', -4.9)).toBe('On pace');
  });

  it('uses the singular for a one-point gap', () => {
    expect(paceDescription('ahead', 1)).toBe('1 point ahead of pace');
    expect(paceDescription('behind', -1.2)).toBe('1 point behind pace');
  });
});
