import { useId, type ReactNode } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import type { PdfExportSettings } from '@/lib/export/pdf-export-settings';
import { t } from '@/lib/shared/i18n';

type PdfExportOptionsProps = {
  settings: PdfExportSettings;
  onChange: (settings: PdfExportSettings) => void;
  disabled: boolean;
};

const pageClass = 'flex flex-col justify-center gap-0.5 rounded-[3px] border-2 border-border bg-card p-[3px]';
const lineClass = 'block h-[3px] rounded-[1px] bg-foreground/35';
const blockClass = 'block h-1.5 rounded-[1px] bg-foreground/35';

/** Small drawings of the choice, so the options read without the labels. */
function PageGlyph({ orientation }: { orientation: PdfExportSettings['orientation'] }) {
  return orientation === 'portrait' ? (
    <span className={`${pageClass} h-8 w-6`}>
      <i className={lineClass} /><i className={lineClass} /><i className={lineClass} />
    </span>
  ) : (
    <span className={`${pageClass} h-6 w-8`}>
      <i className={lineClass} /><i className={lineClass} />
    </span>
  );
}

function LayoutGlyph({ layout }: { layout: PdfExportSettings['stepLayout'] }) {
  return layout === 'page-per-step' ? (
    <span className="flex gap-1">
      <span className={`${pageClass} h-6 w-[18px]`}><i className={blockClass} /></span>
      <span className={`${pageClass} h-6 w-[18px]`}><i className={blockClass} /></span>
    </span>
  ) : (
    <span className={`${pageClass} h-6 w-6`}>
      <i className={blockClass} /><i className={blockClass} />
    </span>
  );
}

function GroupLabel({ id, children }: { id: string; children: ReactNode }) {
  return <span id={id} className="mb-1.5 block text-[13px] font-bold text-muted-foreground">{children}</span>;
}

function CardGroup<Value extends string>({
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
      <GroupLabel id={labelId}>{label}</GroupLabel>
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

function PaperRow({
  value,
  onSelect,
  disabled,
}: {
  value: PdfExportSettings['paper'];
  onSelect: (value: PdfExportSettings['paper']) => void;
  disabled: boolean;
}) {
  const copy = t().editor.publish.pdf.options;
  const labelId = useId();
  return (
    <div className="flex items-center gap-3">
      <span id={labelId} className="w-14 shrink-0 text-[13px] font-bold text-muted-foreground">{copy.paper}</span>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onSelect(next as PdfExportSettings['paper'])}
        disabled={disabled}
        className="min-w-0 flex-1 grid-flow-col auto-cols-fr"
      >
        {([['a4', copy.a4], ['letter', copy.letter]] as const).map(([paper, label]) => (
          <RadioGroupItem key={paper} value={paper} className="min-w-0 truncate px-2 py-1.5 text-[13px] font-bold">
            {label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[13px] font-bold text-foreground">
      <span className="min-w-0 break-words">{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export default function PdfExportOptions({ settings, onChange, disabled }: PdfExportOptionsProps) {
  const copy = t().editor.publish.pdf.options;
  return (
    <div role="group" aria-label={copy.title} className="mt-4 flex flex-col gap-4">
      <CardGroup
        label={copy.orientation}
        value={settings.orientation}
        onSelect={(orientation) => onChange({ ...settings, orientation })}
        disabled={disabled}
        cards={[
          { value: 'portrait', label: copy.portrait, glyph: <PageGlyph orientation="portrait" /> },
          { value: 'landscape', label: copy.landscape, glyph: <PageGlyph orientation="landscape" /> },
        ]}
      />
      <CardGroup
        label={copy.layout}
        value={settings.stepLayout}
        onSelect={(stepLayout) => onChange({ ...settings, stepLayout })}
        disabled={disabled}
        cards={[
          { value: 'page-per-step', label: copy.pagePerStep, glyph: <LayoutGlyph layout="page-per-step" /> },
          { value: 'continuous', label: copy.continuous, glyph: <LayoutGlyph layout="continuous" /> },
        ]}
      />
      <PaperRow value={settings.paper} onSelect={(paper) => onChange({ ...settings, paper })} disabled={disabled} />
      <div className="flex flex-col gap-2.5">
        <SwitchRow
          label={copy.showFooter}
          checked={settings.showFooter}
          onCheckedChange={(showFooter) => onChange({ ...settings, showFooter })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
