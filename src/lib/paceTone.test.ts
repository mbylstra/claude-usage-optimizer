import { describe, expect, it } from 'vitest';
import { paceTone } from './paceTone';

describe('paceTone', () => {
  it('escalates through the ahead ramp', () => {
    expect(paceTone('ahead', 'slight')).toBe('aheadSlight');
    expect(paceTone('ahead', 'moderate')).toBe('aheadModerate');
    expect(paceTone('ahead', 'severe')).toBe('aheadSevere');
  });

  it('gives being behind one tone at every size', () => {
    expect(paceTone('behind', 'slight')).toBe('behind');
    expect(paceTone('behind', 'severe')).toBe('behind');
  });

  it('is neutral on track', () => {
    expect(paceTone('onTrack', 'none')).toBe('onPace');
  });
});
