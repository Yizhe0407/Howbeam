/** Every UI language Howbeam ships a message catalog for. */
export const SUPPORTED_LOCALES = ['zh-TW', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Used for any browser language Howbeam has no catalog for. */
const FALLBACK_LOCALE: Locale = 'en';

/**
 * Maps a BCP 47 language tag to a shipped catalog. Every Chinese variant reads
 * the Traditional Chinese catalog — the only Chinese one — and anything else
 * falls back to English.
 */
export function resolveLocale(tag: string | null | undefined): Locale {
  const normalized = (tag ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-TW';
  return FALLBACK_LOCALE;
}

/** The `lang` attribute value for documents rendered in a locale. */
export function documentLanguage(locale: Locale): string {
  return locale === 'zh-TW' ? 'zh-Hant' : 'en';
}

/**
 * The browser's UI language, from the same source Chrome uses to pick the
 * manifest's `_locales`, so the extension's chrome and its pages always agree.
 * Works in extension pages, the background worker and content scripts alike.
 */
export function detectBrowserLanguage(): string | undefined {
  const runtime = globalThis as {
    chrome?: { i18n?: { getUILanguage?: () => string } };
    navigator?: { language?: string };
  };
  try {
    const language = runtime.chrome?.i18n?.getUILanguage?.();
    if (language) return language;
  } catch {
    // Some contexts expose `chrome` without i18n access; fall through.
  }
  return runtime.navigator?.language;
}
