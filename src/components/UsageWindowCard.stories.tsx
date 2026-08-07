import type { Meta, StoryObj } from '@storybook/react-vite';
import { UsageWindowCard } from './UsageWindowCard';
import {
  FIVE_HOUR_AHEAD_MODERATE,
  FIVE_HOUR_AHEAD_SEVERE,
  FIVE_HOUR_AHEAD_SLIGHT,
  FIVE_HOUR_BEHIND,
  FIVE_HOUR_INACTIVE,
  FIVE_HOUR_ON_PACE,
  FIVE_HOUR_RESETTING,
  FIXTURE_NOW,
  SEVEN_DAY_AHEAD_MODERATE,
  SEVEN_DAY_AHEAD_SEVERE,
  SEVEN_DAY_AHEAD_SLIGHT,
  SEVEN_DAY_BEHIND,
  SEVEN_DAY_ON_PACE,
  SEVEN_DAY_OPUS_BEHIND,
} from './usageFixtures';

const meta = {
  title: 'Usage/UsageWindowCard',
  component: UsageWindowCard,
  args: {
    status: FIVE_HOUR_ON_PACE,
    now: FIXTURE_NOW,
  },
  decorators: [
    (Story) => (
      <div className="w-[21rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UsageWindowCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FiveHourOnPace: Story = {};

/** ~21m ahead: past the 15m threshold, so yellow rather than neutral. */
export const FiveHourSlightlyAhead: Story = {
  args: { status: FIVE_HOUR_AHEAD_SLIGHT },
};

/** ~36m ahead — half an hour of a five-hour session already borrowed. */
export const FiveHourModeratelyAhead: Story = {
  args: { status: FIVE_HOUR_AHEAD_MODERATE },
};

/** 1h 24m ahead: red, because the session will not last the window. */
export const FiveHourSeverelyAhead: Story = {
  args: { status: FIVE_HOUR_AHEAD_SEVERE },
};

export const FiveHourBehindPace: Story = {
  args: { status: FIVE_HOUR_BEHIND },
};

/** No `resets_at` from the API — the window has not started. */
export const WindowInactive: Story = {
  args: { status: FIVE_HOUR_INACTIVE },
};

/** The snapshot predates a reset that has since happened. */
export const WindowResetting: Story = {
  args: { status: FIVE_HOUR_RESETTING },
};

export const WeeklyOnPace: Story = {
  args: { status: SEVEN_DAY_ON_PACE },
};

/** 13h 54m ahead across a week — worth noticing, not worth worrying about. */
export const WeeklySlightlyAhead: Story = {
  args: { status: SEVEN_DAY_AHEAD_SLIGHT },
};

/** 1d 6h ahead — over a day of the week's capacity borrowed early. */
export const WeeklyModeratelyAhead: Story = {
  args: { status: SEVEN_DAY_AHEAD_MODERATE },
};

/** 2d 21h ahead: the week runs out on Friday at this rate. */
export const WeeklySeverelyAhead: Story = {
  args: { status: SEVEN_DAY_AHEAD_SEVERE },
};

export const WeeklyBehindPace: Story = {
  args: { status: SEVEN_DAY_BEHIND },
};

export const WeeklyOpus: Story = {
  args: { status: SEVEN_DAY_OPUS_BEHIND },
};
