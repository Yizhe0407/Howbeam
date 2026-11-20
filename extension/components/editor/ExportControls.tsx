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
