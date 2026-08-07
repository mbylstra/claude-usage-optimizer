import type { Meta, StoryObj } from '@storybook/react-vite';
import { PaceIndicator } from './PaceIndicator';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

const meta = {
  title: 'Usage/PaceIndicator',
  component: PaceIndicator,
  args: {
    tone: 'onPace',
    paceDeltaMs: 0,
  },
} satisfies Meta<typeof PaceIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnPace: Story = {};

/**
 * The three rungs of the ahead ramp, at the five-hour window's thresholds:
 * 15m is slightly bad, 30m is half bad, an hour is bad.
 */
export const SlightlyAhead: Story = {
  args: { tone: 'aheadSlight', paceDeltaMs: 18 * MINUTES },
};

export const ModeratelyAhead: Story = {
  args: { tone: 'aheadModerate', paceDeltaMs: 41 * MINUTES },
};

export const SeverelyAhead: Story = {
  args: { tone: 'aheadSevere', paceDeltaMs: 1 * HOURS + 24 * MINUTES },
};

export const BehindPace: Story = {
  args: { tone: 'behind', paceDeltaMs: -(1 * HOURS + 5 * MINUTES) },
};

/**
 * Inside the thresholds: neutral colour, but the gap is still real minutes and
 * is still named. This is the case a bare "On pace" used to hide.
 */
export const WithinThresholdsButNotZero: Story = {
  args: { tone: 'onPace', paceDeltaMs: 11 * MINUTES },
};

/** The same ramp on a weekly window, where the rungs are 12h / 1d / 2d. */
export const WeeklySeverelyAhead: Story = {
  args: { tone: 'aheadSevere', paceDeltaMs: 2 * DAYS + 21 * HOURS },
};

export const WeeklyBehind: Story = {
  args: { tone: 'behind', paceDeltaMs: -(1 * DAYS + 14 * HOURS) },
};
