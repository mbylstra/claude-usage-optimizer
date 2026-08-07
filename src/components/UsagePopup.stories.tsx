import type { Meta, StoryObj } from '@storybook/react-vite';
import { buildUsagePopupData } from '@/lib/usagePopupData';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import { UsagePopup } from './UsagePopup';
import {
  AHEAD_OF_PACE_CACHE_ENTRY,
  BEHIND_PACE_CACHE_ENTRY,
  FIXTURE_NOW,
  INACTIVE_WINDOW_CACHE_ENTRY,
  LOGGED_OUT_CACHE_ENTRY,
  NETWORK_ERROR_CACHE_ENTRY,
  ON_PACE_CACHE_ENTRY,
  REFRESH_FAILED_CACHE_ENTRY,
  STALE_CACHE_ENTRY,
} from './usageFixtures';

/**
 * Stories go in via the same `buildUsagePopupData` the popup uses, so the states
 * shown here are exactly the states the extension can reach.
 */
function popupDataFor(entry: UsageCacheEntry | null) {
  return buildUsagePopupData(entry, FIXTURE_NOW);
}

const meta = {
  title: 'Usage/UsagePopup',
  component: UsagePopup,
  args: {
    data: popupDataFor(ON_PACE_CACHE_ENTRY),
    now: FIXTURE_NOW,
    isRefreshing: false,
    onRefresh: () => {},
    onOpenClaude: () => {},
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof UsagePopup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnPace: Story = {};

export const AheadOfPace: Story = {
  args: { data: popupDataFor(AHEAD_OF_PACE_CACHE_ENTRY) },
};

export const BehindPace: Story = {
  args: { data: popupDataFor(BEHIND_PACE_CACHE_ENTRY) },
};

/** First run: nothing cached and the first fetch still in flight. */
export const LoadingFirstRun: Story = {
  args: { data: popupDataFor(null), isRefreshing: true },
};

export const LoggedOut: Story = {
  args: { data: popupDataFor(LOGGED_OUT_CACHE_ENTRY) },
};

export const NetworkErrorNoData: Story = {
  args: { data: popupDataFor(NETWORK_ERROR_CACHE_ENTRY) },
};

/** Older than the staleness threshold, so the header says so. */
export const StaleData: Story = {
  args: { data: popupDataFor(STALE_CACHE_ENTRY) },
};

/** The refresh failed, but the previous figures are still worth showing. */
export const RefreshFailedWithCachedData: Story = {
  args: { data: popupDataFor(REFRESH_FAILED_CACHE_ENTRY) },
};

export const WindowInactive: Story = {
  args: { data: popupDataFor(INACTIVE_WINDOW_CACHE_ENTRY) },
};

export const Refreshing: Story = {
  args: { isRefreshing: true },
};
