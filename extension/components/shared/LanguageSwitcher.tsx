import { useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getLocalePreference, setLocalePreference } from '@/lib/runtime/locale-preference';
import { LOCALE_NAMES, SUPPORTED_LOCALES, t, type LocalePreference } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

interface Props {
  className?: string;
}

/**
 * The extension-wide language choice. The preference is stored once and every
 * surface — this page, other open pages, the background worker and the in-page
 * recording toolbar — switches as soon as it changes, without a reload.
 */
export default function LanguageSwitcher({ className }: Props) {
  const [preference, setPreference] = useState<LocalePreference>('auto');

  useEffect(() => {
    let active = true;
    void getLocalePreference()
      .then((stored) => {
        if (active) setPreference(stored);
      })
      .catch((error) => console.warn('[howbeam] failed to read the language preference', error));
    return () => {
      active = false;
    };
  }, []);

  async function choose(next: LocalePreference) {
    const previous = preference;
    setPreference(next);
    try {
      await setLocalePreference(next);
    } catch (error) {
      console.error('[howbeam] failed to save the language preference', error);
      setPreference(previous);
    }
  }

  return (
    <Select value={preference} onValueChange={(next) => void choose(next as LocalePreference)}>
      {/* Sticker treatment layered over the stock shadcn classes: 2px ink
          outline, flat card fill, and the shared focus-ring in place of the
          stock translucent ring. */}
      <SelectTrigger
        aria-label={t().language.label}
        className={cn(
          // Radix renders the value without forwarding className, so it is laid out
          // from here: it takes the free space and sits beside the icon.
          'h-8 gap-1.5 border-2 border-border bg-card px-2.5 text-xs font-bold text-foreground focus-ring focus-visible:border-border focus-visible:ring-0 data-[size=default]:h-8 dark:bg-card dark:hover:bg-secondary *:data-[slot=select-value]:flex-1',
          className,
        )}
      >
        <Languages aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      {/* A ring (drawn outside the box) rather than a border keeps the
          viewport's 4px padding the full inset, so the items' rounded-sm stays
          concentric. Not an outline: Radix pins `outline: none` inline. */}
      <SelectContent position="popper" className="border-0 ring-2 ring-border">
        <SelectItem value="auto" className="font-bold">{t().language.auto}</SelectItem>
        {SUPPORTED_LOCALES.map((locale) => (
          <SelectItem key={locale} value={locale} lang={locale} className="font-bold">
            {LOCALE_NAMES[locale]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
