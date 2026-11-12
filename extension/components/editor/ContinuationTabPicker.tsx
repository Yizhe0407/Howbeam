import { Check, Globe } from 'lucide-react';
import type { ContinuationTabOption } from '@/lib/editor/editor-app-model';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  tabs: ContinuationTabOption[];
  selectedTabId: number | null;
  onSelect: (tabId: number) => void;
  disabled?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Tab list for 「改在其他頁面接續」; caller controls preselection, and only http(s) favicons render (others fall back to a generic globe icon). */
export default function ContinuationTabPicker({ tabs, selectedTabId, onSelect, disabled = false }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label={t().continuationTabs.label}
      className="app-scrollbar mt-3 max-h-52 overflow-y-auto rounded-md border-2 border-border"
    >
      {tabs.map((tab) => {
        const host = hostOf(tab.url);
        const selected = tab.id === selectedTabId;
        const favicon = tab.favIconUrl && /^https?:\/\//.test(tab.favIconUrl) ? tab.favIconUrl : null;
        return (
          <button
            key={tab.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'flex w-full items-center gap-2.5 border-b-2 border-border-soft px-3 py-2.5 text-left outline-none last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
              'transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-50',
              selected && 'bg-selected text-on-accent hover:bg-selected',
            )}
          >
            {favicon ? (
              <img src={favicon} alt="" aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <Globe className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-bold">{tab.title || host}</span>
              <span className={cn('block truncate text-xs', selected ? 'text-on-accent' : 'text-muted-foreground')}>
                {host}
              </span>
            </span>
            {selected && <Check className="size-4 shrink-0" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
