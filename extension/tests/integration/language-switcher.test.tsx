// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  return {
    values,
    listeners,
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
      const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: value }]));
      for (const listener of listeners) listener(changes, 'local');
    }),
  };
});

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: { get: storage.get, set: storage.set },
      onChanged: {
        addListener: (listener: never) => storage.listeners.add(listener),
        removeListener: (listener: never) => storage.listeners.delete(listener),
      },
    },
  },
}));

import LanguageSwitcher from '@/components/shared/LanguageSwitcher';
import { initLocalePreference } from '@/lib/runtime/locale-preference';
import { getLocale, setLocale, t, useActiveLocale } from '@/lib/shared/i18n';

function Page() {
  useActiveLocale();
  return (
    <>
      <LanguageSwitcher />
      <p>{t().common.startRecording}</p>
    </>
  );
}

// jsdom lacks the pointer-capture and scrolling APIs Radix Select calls.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/** Opens the language menu by keyboard and picks an option, as a user would. */
async function pick(name: string) {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  const option = await screen.findByRole('option', { name });
  option.focus();
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

beforeEach(() => {
  for (const key of Object.keys(storage.values)) delete storage.values[key];
  storage.listeners.clear();
  setLocale('zh-TW');
});

afterEach(() => {
  cleanup();
  setLocale('zh-TW');
});

describe('language switcher', () => {
  it('re-renders the page in the chosen language and stores the choice', async () => {
    render(<Page />);
    expect(screen.getByText('開始錄製')).toBeTruthy();

    expect(screen.getByRole('combobox', { name: '語言' })).toBeTruthy();
    await pick('English');

    await waitFor(() => expect(screen.getByText('Start recording')).toBeTruthy());
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeTruthy();
    expect(storage.values['howbeam:localePreference']).toBe('en');
  });

  it('follows the browser again when switched back to automatic', async () => {
    render(<Page />);
    await pick('English');
    await waitFor(() => expect(getLocale()).toBe('en'));

    await pick('Match browser');
    expect(storage.values['howbeam:localePreference']).toBe('auto');
    // The suite pins the browser language to zh-TW.
    await waitFor(() => expect(screen.getByText('開始錄製')).toBeTruthy());
  });
});

describe('initLocalePreference', () => {
  it('applies the stored choice and follows changes made in other contexts', async () => {
    storage.values['howbeam:localePreference'] = 'en';
    const stop = await initLocalePreference();
    expect(getLocale()).toBe('en');

    await storage.set({ 'howbeam:localePreference': 'zh-TW' });
    expect(getLocale()).toBe('zh-TW');

    stop();
    await storage.set({ 'howbeam:localePreference': 'en' });
    expect(getLocale()).toBe('zh-TW');
  });

  it('ignores an unknown stored value', async () => {
    storage.values['howbeam:localePreference'] = 'klingon';
    await initLocalePreference();
    expect(getLocale()).toBe('zh-TW');
  });
});
