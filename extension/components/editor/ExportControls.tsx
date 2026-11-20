import { useId, type ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import InlineAlert from '@/components/shared/InlineAlert';
import type { PublicationAction } from '@/lib/export/export-failure';
import { t } from '@/lib/shared/i18n';

interface FormatTabsProps<F extends PublicationAction> {
  formats: readonly F[];
  value: F;
  onChange: (format: F) => void;
  disabled: boolean;
  isUnavailable?: (format: F) => boolean;
}

/** The row of format tabs every export surface opens with. */
export function ExportFormatTabs<F extends PublicationAction>({ formats, value, onChange, disabled, isUnavailable }: FormatTabsProps<F>) {
  return (
    <RadioGroup
      aria-label={t().editor.publish.format}
      value={value}
      onValueChange={(next) => onChange(next as F)}
      disabled={disabled}
      className="flex gap-0 overflow-hidden rounded-md border-2 border-border bg-surface-raised"
    >
      {formats.map((format) => (
        <RadioGroupItem
          key={format}
          value={format}
          disabled={isUnavailable?.(format)}
          className="min-w-0 flex-1 truncate rounded-none border-0 border-r-2 px-1.5 py-2 text-[13px] font-bold last:border-r-0"
        >
          {t().editor.publish[format].tab}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

interface ActionsProps {
  error: string | null;
  notice: string | null;
  busyShown: boolean;
  label: string;
  disabled?: boolean;
  onDownload: () => void;
  onCancel: () => void;
}

/** The outcome message, the download button, and Cancel while an export runs. */
export function ExportActions({ error, notice, busyShown, label, disabled = false, onDownload, onCancel }: ActionsProps) {
  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="empty:hidden mb-3">
        {error && <InlineAlert>{error}</InlineAlert>}
        {!error && notice && (
          <p role="status" className="rounded-md border-2 border-border bg-brand-bg-soft px-3.5 py-2.5 text-xs font-bold text-foreground">
            {notice}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button className="min-w-0 flex-1" disabled={busyShown || disabled} onClick={onDownload}>
          {busyShown ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          <span className="truncate">{busyShown ? t().editor.publish.exporting : label}</span>
        </Button>
        {busyShown && (
          <Button variant="outline" onClick={onCancel}>
            {t().common.cancel}
          </Button>
        )}
      </div>
    </>
  );
}

/** One sheet of paper in the small drawings that label export choices. */
export const PAGE_SHEET_CLASS = 'flex flex-col justify-center gap-0.5 rounded-[3px] border-2 border-border bg-card p-[3px]';
const blockClass = 'block h-1.5 rounded-[1px] bg-foreground/35';

/** Two sheets with one block each, or one sheet holding both: separate pages or files versus one flow. */
export function PagesGlyph({ pages }: { pages: 1 | 2 }) {
  return pages === 2 ? (
    <span className="flex gap-1">
      <span className={`${PAGE_SHEET_CLASS} h-6 w-[18px]`}><i className={blockClass} /></span>
      <span className={`${PAGE_SHEET_CLASS} h-6 w-[18px]`}><i className={blockClass} /></span>
    </span>
  ) : (
    <span className={`${PAGE_SHEET_CLASS} h-6 w-6`}>
      <i className={blockClass} /><i className={blockClass} />
    </span>
  );
}

/** A labelled pair of choice cards, each a small drawing over a short name. */
export function ExportCardGroup<Value extends string>({
  label,
  value,
  onSelect,
  disabled,
  cards,
}: {
  label: string;
  value: Value;
  onSelect: (value: Value) => void;
  disabled: boolean;
  cards: readonly { value: Value; label: string; glyph: ReactNode }[];
}) {
  const labelId = useId();
  return (
    <div>
      <span id={labelId} className="mb-1.5 block text-[13px] font-bold text-muted-foreground">{label}</span>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onSelect(next as Value)}
        disabled={disabled}
        className="grid-cols-2"
      >
        {cards.map((card) => (
          <RadioGroupItem
            key={card.value}
            value={card.value}
            className="flex flex-col items-center gap-1.5 px-2 py-2.5 text-[13px] font-bold"
          >
            <span aria-hidden="true" className="flex h-8 items-center">{card.glyph}</span>
            <span className="max-w-full truncate">{card.label}</span>
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </div>
  );
}
