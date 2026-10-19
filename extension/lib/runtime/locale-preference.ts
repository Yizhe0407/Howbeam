import { browser } from 'wxt/browser';
import { applyLocalePreference, SUPPORTED_LOCALES, type LocalePreference } from '@/lib/shared/i18n';

const LOCALE_PREFERENCE_KEY = 'howbeam:localePreference';

function normalizePreference(value: unknown): LocalePreference {
  return value === 'auto' || (SUPPORTED_LOCALES as readonly unknown[]).includes(value)
    ? value as LocalePreference
    : 'auto';
}

export async function getLocalePreference(): Promise<LocalePreference> {
  const stored = await browser.storage.local.get(LOCALE_PREFERENCE_KEY);
  return normalizePreference(stored[LOCALE_PREFERENCE_KEY]);
}

/** Persists the switcher's choice. Every extension context — pages, the
 * background worker and the in-page recording toolbar — picks it up through
 * the storage change subscription in initLocalePreference(). */
export async function setLocalePreference(preference: LocalePreference): Promise<void> {
  await browser.storage.local.set({ [LOCALE_PREFERENCE_KEY]: preference });
  applyLocalePreference(preference);
}

/**
 * Applies the stored preference and keeps following it; resolves to a function
 * that stops following. Await it before the first render so a page never
 * flashes in the browser language first. A failed read keeps the
 * browser-derived locale, which is already active.
 */
export async function initLocalePreference(): Promise<() => void> {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && LOCALE_PREFERENCE_KEY in changes) {
      applyLocalePreference(normalizePreference(changes[LOCALE_PREFERENCE_KEY].newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  try {
    applyLocalePreference(await getLocalePreference());
  } catch (error) {
    console.warn('[howbeam] failed to read the language preference', error);
  }
  return () => browser.storage.onChanged.removeListener(listener);
}
