import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/shared/i18n/messages/en';
import { zhTW } from '@/lib/shared/i18n/messages/zh-TW';
import { applyLocalePreference, getLocale, intlLocale, messagesFor, resolveLocale, setLocale, t } from '@/lib/shared/i18n';
import { defaultProjectTitle, isDefaultProjectTitle } from '@/lib/storage/models';

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** Every rendered string of a catalog: plain values, plus each function called
 * with placeholder arguments. */
function renderedCopy(node: unknown, trail = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[trail, node]];
  if (typeof node === 'function') {
    const args = Array.from({ length: node.length }, () => 'X');
    return [[trail, String((node as (...values: unknown[]) => unknown)(...args))]];
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => renderedCopy(value, trail ? `${trail}.${key}` : key));
  }
  return [];
}

afterEach(() => setLocale('zh-TW'));

describe('resolveLocale', () => {
  it.each([
    ['zh-TW', 'zh-TW'],
    ['zh_TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh-CN', 'zh-TW'],
    ['zh', 'zh-TW'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['ja', 'en'],
    ['fr-FR', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ] as const)('maps %s to %s', (tag, locale) => {
    expect(resolveLocale(tag)).toBe(locale);
  });
});

describe('catalogs', () => {
  it('leaves no Chinese in the English copy', () => {
    const untranslated = renderedCopy(en).filter(([, text]) => CJK.test(text));
    expect(untranslated).toEqual([]);
  });

  it('covers exactly the same keys in every locale', () => {
    const keys = (catalog: unknown) => renderedCopy(catalog).map(([key]) => key);
    expect(keys(en)).toEqual(keys(zhTW));
  });

  it('pluralizes English counts', () => {
    expect(en.mode.steps.itemCount(1)).toBe('1 step');
    expect(en.mode.steps.itemCount(3)).toBe('3 steps');
    expect(en.library.stepCount(1)).toBe('1 step');
  });
});

describe('active locale', () => {
  it('switches every read of t() and the Intl locale together', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t().common.startRecording).toBe('Start recording');
    expect(intlLocale()).toBe('en');
    setLocale('zh-TW');
    expect(t().common.startRecording).toBe('開始錄製');
    expect(messagesFor('en').common.startRecording).toBe('Start recording');
  });

  it("resolves 'auto' once, and again when the browser reports a language change", () => {
    const getUILanguage = vi.fn(() => 'zh-TW');
    const languageListeners: (() => void)[] = [];
    vi.stubGlobal('chrome', { i18n: { getUILanguage } });
    vi.stubGlobal('addEventListener', (type: string, listener: () => void) => {
      if (type === 'languagechange') languageListeners.push(listener);
    });
    try {
      applyLocalePreference('auto');
      expect(getLocale()).toBe('zh-TW');
      t();
      t();
      expect(getUILanguage).toHaveBeenCalledTimes(1);

      getUILanguage.mockReturnValue('en-US');
      for (const listener of languageListeners) listener();
      expect(getLocale()).toBe('en');
      expect(t().common.startRecording).toBe('Start recording');
      // A fixed choice still wins over the browser language.
      applyLocalePreference('zh-TW');
      expect(t().common.startRecording).toBe('開始錄製');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recognizes an untitled placeholder written under any locale', () => {
    const createdAt = Date.UTC(2026, 9, 15, 3, 4);
    setLocale('en');
    const englishTitle = defaultProjectTitle(createdAt);
    expect(englishTitle.startsWith('Untitled project · ')).toBe(true);
    setLocale('zh-TW');
    expect(isDefaultProjectTitle(englishTitle, createdAt)).toBe(true);
    expect(isDefaultProjectTitle(defaultProjectTitle(createdAt), createdAt)).toBe(true);
    expect(isDefaultProjectTitle('My project', createdAt)).toBe(false);
  });
});
