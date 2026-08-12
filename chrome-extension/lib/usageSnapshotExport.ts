import { deriveUsageStatuses, findWindowStatus } from './usagePace';
import type { PaceStatus, UsageSnapshot, UsageWindowKind } from './usageTypes';

/**
 * The JSON handed to the autonomous-work scheduler via
 * `~/Downloads/claude-usage.json`.
 *
 * This file is a contract with `backend/run-autonomous-work.py`, so the
 * field names are deliberately stable and flat — the reader is a Python script,
 * not the popup. Every figure is nullable because a window the API did not
 * report is a real, expected state (see `UsageWindowSnapshot.resetsAt`), and the
 * scheduler must be able to tell "no data" from "zero".
 */
export interface UsageSnapshotExport {
  /** ISO 8601. The scheduler refuses to act on a stale file. */
  fetchedAt: string;
  /** Negative means behind an even burn. Null when the weekly window is inactive. */
  weeklyPaceDeltaMs: number | null;
  weeklyPaceStatus: PaceStatus | null;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  sevenDayOpusPercent: number | null;
}

function percentUsedFor(
  windowStatuses: ReturnType<typeof deriveUsageStatuses>,
  kind: UsageWindowKind,
): number | null {
  return findWindowStatus(windowStatuses, kind)?.percentUsed ?? null;
}

/**
 * Flattens a snapshot into the scheduler's view of it.
 *
 * `fetchedAt` doubles as the "now" the pace is derived against — the numbers in
 * the file describe the moment the snapshot was taken, and pinning both to one
 * instant keeps the file internally consistent.
 */
export function buildUsageSnapshotExport(
  snapshot: UsageSnapshot,
  fetchedAt: Date,
): UsageSnapshotExport {
  const windowStatuses = deriveUsageStatuses(snapshot, fetchedAt);
  const weeklyStatus = findWindowStatus(windowStatuses, 'sevenDay');

  return {
    fetchedAt: fetchedAt.toISOString(),
    weeklyPaceDeltaMs: weeklyStatus?.isActive ? weeklyStatus.paceDeltaMs : null,
    weeklyPaceStatus: weeklyStatus?.isActive ? weeklyStatus.paceStatus : null,
    fiveHourPercent: percentUsedFor(windowStatuses, 'fiveHour'),
    sevenDayPercent: percentUsedFor(windowStatuses, 'sevenDay'),
    sevenDayOpusPercent: percentUsedFor(windowStatuses, 'sevenDayOpus'),
  };
}
