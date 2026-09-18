import type { UsageErrorInfo } from './usageTypes';

/**
 * Turns an error code into a headline naming the service that actually
 * failed.
 *
 * Shared between `UsagePopup` (the Claude section) and `CodexUsageSection`,
 * since both render a `UsageErrorInfo` — but the two read from different
 * services, so `service` is threaded through rather than hard-coded, or a
 * Codex-side `NOT_LOGGED_IN` would tell someone to sign in to Claude.ai.
 * `NO_ORGANIZATIONS` is Claude-only — `codexUsageSource.ts` never produces it
 * — so it stays hard-coded.
 */
export function errorHeadline(error: UsageErrorInfo, service = 'Claude.ai'): string {
  switch (error.code) {
    case 'NOT_LOGGED_IN':
      return `Not logged in to ${service}`;
    case 'NO_ORGANIZATIONS':
      return 'No Claude.ai account found';
    case 'NETWORK_ERROR':
      return `Could not reach ${service}`;
    case 'MALFORMED_RESPONSE':
      return `${service} sent something unexpected`;
    case 'HTTP_ERROR':
      return `${service} could not report your usage`;
    case 'HOST_UNAVAILABLE':
      return 'Could not reach the native host';
    default:
      return 'Could not load your usage';
  }
}

/**
 * Generic guidance for the Claude path only. The Codex path has better copy
 * available than a generic mapping could give it — `codex_usage.py` and
 * `codexUsageSource.ts` both write a specific, already-actionable
 * `error.message` ("run `codex login`", "Install it with `just
 * install-usage-host`") — so `CodexUsageSection` renders that message
 * directly instead of calling this.
 */
export function errorGuidance(error: UsageErrorInfo): string {
  switch (error.code) {
    case 'NOT_LOGGED_IN':
    case 'NO_ORGANIZATIONS':
      return 'Sign in to Claude.ai, then refresh.';
    case 'NETWORK_ERROR':
      return 'Check your connection and try again.';
    case 'HOST_UNAVAILABLE':
      return 'Install it with `just install-usage-host`, then refresh.';
    default:
      return 'This usually clears up on its own. Try again in a moment.';
  }
}
