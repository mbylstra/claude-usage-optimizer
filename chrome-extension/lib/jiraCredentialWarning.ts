import type { QueueSourceName } from './settingsTypes';

/**
 * How loudly to say that the Jira credential is about to stop working.
 *
 * The API token this project uses carries a mandatory expiry of at most a year —
 * Atlassian policy, not a setting — so the credential *will* fail one day. The
 * whole case for choosing it over OAuth is that its expiry is a **scheduled
 * event with a date known at creation time**, which makes it a calendar reminder
 * rather than a 2 AM failure. This module is that reminder, and without it the
 * choice is indefensible.
 *
 * The clock is the extension's, not the run's: a run fires at 2 AM and only when
 * the week is behind pace, which may be never for a fortnight, whereas the
 * native host is spawned every five minutes for as long as Chrome is open. It
 * probes once a day and records the answer; this turns that record into a level.
 *
 * Pure — no browser APIs, no I/O. `JiraCredentialStatus` is the shape
 * `queue_source_jira.JiraStatus.to_json()` writes.
 */

export interface JiraCredentialStatus {
  /** Is there a credential on this machine at all? */
  configured: boolean;
  /** Did the last probe succeed? */
  ok: boolean;
  /** Why it failed: `unauthorised`, `forbidden`, `notFound`, `unreachable`, … */
  cause?: string | null;
  detail?: string | null;
  siteUrl?: string | null;
  accountEmail?: string | null;
  projectKey?: string | null;
  /** Days until the token expires, from the date recorded when it was pasted. */
  daysUntilExpiry?: number | null;
  /** ISO 8601, UTC. */
  checkedAt?: string | null;
}

/**
 * Where a warning is loud enough to appear. Each level includes the ones before
 * it, so a `badge` warning also shows in the banner and on the settings screen.
 */
/**
 * `blocking` is reserved for the one thing that genuinely stops a run — Jira
 * rejecting the credential outright. A recorded expiry date that has passed is
 * `badge`: just as loud, but it is a claim about a hand-typed date rather than
 * about the token, and the run will go on trying.
 */
export type JiraWarningLevel = 'none' | 'settings' | 'banner' | 'badge' | 'blocking';

const LEVEL_ORDER: readonly JiraWarningLevel[] = [
  'none',
  'settings',
  'banner',
  'badge',
  'blocking',
];

export interface JiraCredentialWarning {
  level: JiraWarningLevel;
  /** One sentence, for whichever surface is showing it. */
  message: string;
}

export const NO_JIRA_WARNING: JiraCredentialWarning = { level: 'none', message: '' };

const SETTINGS_WARNING_DAYS = 30;
const BANNER_WARNING_DAYS = 14;
const BADGE_WARNING_DAYS = 7;

/**
 * What to say about the credential, and how loudly.
 *
 * `queueSource` is taken rather than assumed because none of this applies to an
 * install that queues its work in `prompts.txt`: a stale credential there is a
 * fact about nothing.
 */
export function deriveJiraCredentialWarning(
  status: JiraCredentialStatus | null,
  queueSource: QueueSourceName,
): JiraCredentialWarning {
  if (queueSource !== 'jira' || status === null) return NO_JIRA_WARNING;

  if (!status.configured) {
    return {
      level: 'settings',
      message: 'No Jira credential on this machine — run `just set-jira-credentials`.',
    };
  }

  if (!status.ok) return describeFailedProbe(status);

  const daysUntilExpiry = status.daysUntilExpiry;
  if (typeof daysUntilExpiry !== 'number') return NO_JIRA_WARNING;

  // Loud, but not `blocking` — and the difference is the whole reason the
  // scheduler warns rather than refuses on this date. It is typed in by hand and
  // cannot be read back from any API, so "expired" here may equally mean the
  // token is dead or that somebody typed 2026 for 2027. Only Jira's own 401
  // knows which, and it is what actually stops a run.
  if (daysUntilExpiry < 0) {
    return {
      level: 'badge',
      message: `The recorded expiry for the Jira API token passed ${Math.abs(daysUntilExpiry)} days ago. Replace it with \`just set-jira-credentials\` — or correct the date there, if it was mistyped.`,
    };
  }

  const expiryMessage = `The Jira API token expires in ${daysUntilExpiry} ${
    daysUntilExpiry === 1 ? 'day' : 'days'
  } — run \`just set-jira-credentials\` to replace it.`;

  if (daysUntilExpiry <= BADGE_WARNING_DAYS) return { level: 'badge', message: expiryMessage };
  if (daysUntilExpiry <= BANNER_WARNING_DAYS) return { level: 'banner', message: expiryMessage };
  if (daysUntilExpiry <= SETTINGS_WARNING_DAYS)
    return { level: 'settings', message: expiryMessage };
  return NO_JIRA_WARNING;
}

/**
 * A failed probe, reported as itself.
 *
 * Being unreachable is the one failure that means nothing at all: a laptop is
 * offline most nights it is shut, and raising an alarm for that would train
 * somebody to ignore the one that matters.
 */
function describeFailedProbe(status: JiraCredentialStatus): JiraCredentialWarning {
  switch (status.cause) {
    case 'unreachable':
      return NO_JIRA_WARNING;
    case 'unauthorised':
      return {
        level: 'blocking',
        message: 'Jira rejected the API token. Runs will not start until it is replaced.',
      };
    case 'forbidden':
      return {
        level: 'badge',
        message: `This account no longer has permission on ${status.projectKey ?? 'the Jira project'}.`,
      };
    case 'notFound':
      return {
        level: 'badge',
        message: `The Jira project ${status.projectKey ?? ''} could not be found.`.trim(),
      };
    default:
      return { level: 'badge', message: 'The last check of the Jira queue failed.' };
  }
}

/** Is this warning at least as loud as `threshold`? */
export function warningReaches(
  warning: JiraCredentialWarning,
  threshold: JiraWarningLevel,
): boolean {
  return LEVEL_ORDER.indexOf(warning.level) >= LEVEL_ORDER.indexOf(threshold);
}
