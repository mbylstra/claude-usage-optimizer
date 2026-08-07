import type { Meta, StoryObj } from '@storybook/react-vite';
import { PaceIndicator } from './PaceIndicator';

const meta = {
  title: 'Usage/PaceIndicator',
  component: PaceIndicator,
  args: {
    paceStatus: 'onTrack',
    paceDeltaPercentagePoints: 0,
  },
} satisfies Meta<typeof PaceIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnTrack: Story = {};

export const AheadOfPace: Story = {
  args: { paceStatus: 'ahead', paceDeltaPercentagePoints: 12 },
};

export const BehindPace: Story = {
  args: { paceStatus: 'behind', paceDeltaPercentagePoints: -8 },
};

/** The singular case — worth a look because "1 points" is the classic slip. */
export const SinglePoint: Story = {
  args: { paceStatus: 'ahead', paceDeltaPercentagePoints: 1 },
};

export const FarAheadOfPace: Story = {
  args: { paceStatus: 'ahead', paceDeltaPercentagePoints: 47 },
};
