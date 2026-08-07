import type { Meta, StoryObj } from '@storybook/react-vite';
import { PaceIndicator } from './PaceIndicator';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

const meta = {
  title: 'Usage/PaceIndicator',
  component: PaceIndicator,
  args: {
    paceStatus: 'onTrack',
    paceDeltaMs: 0,
  },
} satisfies Meta<typeof PaceIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnTrack: Story = {};

/** 12 points of a five-hour window. */
export const AheadOfPace: Story = {
  args: { paceStatus: 'ahead', paceDeltaMs: 36 * MINUTES },
};

export const BehindPace: Story = {
  args: { paceStatus: 'behind', paceDeltaMs: -(1 * HOURS + 5 * MINUTES) },
};

/**
 * Inside the ahead/behind tolerance: neutral colour, but the gap is still real
 * minutes and is still named. This is the case a bare "On pace" used to hide.
 */
export const WithinToleranceButNotZero: Story = {
  args: { paceStatus: 'onTrack', paceDeltaMs: 11 * MINUTES },
};

/** A weekly window, where the same percentage gap is worth days. */
export const WeeklyGapInDays: Story = {
  args: { paceStatus: 'ahead', paceDeltaMs: 3 * DAYS + 7 * HOURS },
};

export const FarAheadOfPace: Story = {
  args: { paceStatus: 'ahead', paceDeltaMs: 2 * HOURS + 20 * MINUTES },
};
