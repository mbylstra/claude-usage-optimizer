import type { Meta, StoryObj } from '@storybook/react-vite';
import { UsageWindowCard } from './UsageWindowCard';
import {
  FIVE_HOUR_AHEAD,
  FIVE_HOUR_BEHIND,
  FIVE_HOUR_INACTIVE,
  FIVE_HOUR_ON_PACE,
  FIVE_HOUR_RESETTING,
  FIXTURE_NOW,
  SEVEN_DAY_AHEAD,
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

export const FiveHourAheadOfPace: Story = {
  args: { status: FIVE_HOUR_AHEAD },
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

export const WeeklyAheadOfPace: Story = {
  args: { status: SEVEN_DAY_AHEAD },
};

export const WeeklyBehindPace: Story = {
  args: { status: SEVEN_DAY_BEHIND },
};

export const WeeklyOpus: Story = {
  args: { status: SEVEN_DAY_OPUS_BEHIND },
};
