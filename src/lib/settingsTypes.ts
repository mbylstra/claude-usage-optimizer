/**
 * User-configurable extension settings. Pure types plus the default — no
 * browser APIs, no I/O.
 */

export interface ExtensionSettings {
  /**
   * Whether the user wants to be notified as a usage window approaches its
   * limit. The toggle is wired up end to end; the notifications themselves are
   * not implemented yet.
   */
  notificationsEnabled: boolean;
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  notificationsEnabled: false,
};
