import { en } from './messages/en';
import { zhTW, type Messages } from './messages/zh-TW';
import { useSyncExternalStore } from 'react';
import { detectBrowserLanguage, documentLanguage, resolveLocale, type Locale } from './locale';

export type { Messages } from './messages/zh-TW';
export { SUPPORTED_LOCALES, resolveLocale, type Locale } from './locale';
export { LOCALE_NAMES } from './messages/locale-names';

/** What the user picked in the language switcher: a fixed locale, or follow
 * the browser UI language. */
export type LocalePreference = 'auto' | Locale;

const CATALOGS: Record<Locale, Messages> = {
  'zh-TW': zhTW,
  en,
};

let activePreference: LocalePreference = 'auto';

/** Cached because t() runs on every render. */
let browserLocale: Locale | null = null;
let followingLanguageChanges = false;

function resolveBrowserLocale(): Locale {
  if (browserLocale === null) {
    browserLocale = resolveLocale(detectBrowserLanguage());
    followLanguageChanges();
  }
  return browserLocale;
}

/** Only the navigator.language fallback can change mid-session. */
function followLanguageChanges(): void {
  if (followingLanguageChanges || typeof globalThis.addEventListener !== 'function') return;
  followingLanguageChanges = true;
  globalThis.addEventListener('languagechange', () => {
    updateLocale(() => {
      browserLocale = null;
    });
  });
}

function resolvePreference(preference: LocalePreference): Locale {
  return preference === 'auto' ? resolveBrowserLocale() : preference;
}

/**
 * The active UI copy. Read it at the moment text is rendered or produced —
 * never cache a string in module scope — so every surface follows the active
 * locale, including a locale set after the module loaded.
 */
export function t(): Messages {
  return CATALOGS[getLocale()];
}

/** The copy for an explicit locale, for code that must recognize text produced
 * under any locale (e.g. a stored placeholder title). */
export function messagesFor(locale: Locale): Messages {
  return CATALOGS[locale];
}

export function getLocale(): Locale {
  return resolvePreference(activePreference);
}

const listeners = new Set<() => void>();

/** Notifies subscribers when `change` alters the effective locale. */
function updateLocale(change: () => void): void {
  const before = getLocale();
  change();
  if (getLocale() === before) return;
  for (const listener of listeners) listener();
}

function applyPreference(preference: LocalePreference): void {
  updateLocale(() => {
    activePreference = preference;
    browserLocale = null;
  });
}

/** Switches to a fixed locale. */
export function setLocale(locale: Locale): void {
  applyPreference(locale);
}

/** Applies a stored preference; 'auto' keeps following the browser language. */
export function applyLocalePreference(preference: LocalePreference): void {
  applyPreference(preference);
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the calling component whenever the active locale changes. Used
 * at each React root: copy is read through t() during render, so re-rendering
 * the root is all a language switch needs. */
export function useActiveLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** BCP 47 tag for Intl formatting, sorting and case folding in the active locale. */
export function intlLocale(): string {
  return getLocale();
}

/** `lang` attribute for documents rendered in the active locale. */
export function documentLang(): string {
  return documentLanguage(getLocale());
}

/** Points an extension page's <html lang> and <title> at the active locale. */
export function localizeDocument(title: string): void {
  document.documentElement.lang = documentLang();
  document.title = title;
}
