import { normaliseExtensionSettings, type ExtensionSettings } from '@/lib/settingsTypes';

/**
 * The only module that reads or writes extension settings in
 * `chrome.storage.local`.
 */

const SETTINGS_STORAGE_KEY = 'settings';

export const SETTINGS_CHANGE_KEY = SETTINGS_STORAGE_KEY;

export async function readExtensionSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normaliseExtensionSettings(stored[SETTINGS_STORAGE_KEY]);
}

export async function writeExtensionSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}
