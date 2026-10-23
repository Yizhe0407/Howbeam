import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Copy, Minus, Plus, Trash2 } from 'lucide-react';
import {
  IMAGE_EDIT_FONT_SIZES,
  IMAGE_EDIT_MARKER_RADII,
  IMAGE_EDIT_PRESET_COLORS,
  IMAGE_EDIT_STROKE_WIDTHS,
  SHAPE_FILLS,
  TEXT_LOOKS,
} from '@/lib/storage/image-edit-model';
import { IMAGE_EDIT_LIMITS } from '@/lib/storage/image-edit-model';
import type { ImageEditStyle, StyleField, StylePatch } from '@/lib/editor/image-edit-style';
import { hexToRgb } from '@/lib/editor/hsv-color';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DashedOutline } from '@/components/ui/dashed-outline';
import ImageEditColorPicker from './ImageEditColorPicker';

interface Props {
  fields: readonly StyleField[];
  style: ImageEditStyle;
  /** Number of the selected marker; only shown for a selected marker. */
  number?: number;
  onChange: (patch: StylePatch) => void;
}

interface CropProps {
  /** The pixel size the image will have after the crop, or null when not cropped. */
  size: { width: number; height: number } | null;
  onClear: () => void;
}

export interface ItemActions {
  onDuplicate?: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}

const pillButton =
  'flex h-8 items-center justify-center rounded-sm px-2.5 text-xs font-bold outline-none transition-colors focus-ring';

/** A labelled group of controls in the context bar. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-[11px] font-bold tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A row of mutually exclusive options. */
function Segmented<V extends string | number>({ label, value, options, onSelect }: {
  label: string;
  value: V;
  options: readonly { value: V; content: ReactNode; title: string }[];
  onSelect: (value: V) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.title}
          title={option.title}
          onClick={() => onSelect(option.value)}
          className={cn(
            pillButton,
            value === option.value ? 'bg-selected text-on-accent' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

function ColorControl({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const copy = t().editor.imageEdit;
  // A picked colour gets a swatch of its own, so the picker button never changes look.
  const swatches = (IMAGE_EDIT_PRESET_COLORS as readonly string[]).includes(color)
    ? IMAGE_EDIT_PRESET_COLORS
    : [...IMAGE_EDIT_PRESET_COLORS, color];
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={copy.colorLabel}>
      {swatches.map((swatch) => (
        <button
          key={swatch}
          type="button"
          role="radio"
          aria-checked={color === swatch}
          aria-label={swatch}
          title={swatch}
          onClick={() => onChange(swatch)}
          className={cn(
            'size-6 rounded-full border-2 outline-none transition-transform focus-ring',
            color === swatch ? 'scale-110 border-foreground ring-2 ring-card' : 'border-border-soft hover:scale-105',
          )}
          style={{ backgroundColor: swatch }}
        />
      ))}
      <ImageEditColorPicker color={color} onChange={onChange}>
        <button
          type="button"
          aria-label={copy.customColor}
          title={copy.customColor}
          className="group relative flex size-6 items-center justify-center rounded-full border-2 border-transparent text-muted-foreground outline-none transition-colors focus-ring hover:border-foreground hover:text-foreground data-[state=open]:border-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground"
        >
          <DashedOutline radius="full" outset={2} hideOnHover className="group-data-[state=open]:hidden" />
          <Plus className="size-3.5" strokeWidth={2.5} />
        </button>
      </ImageEditColorPicker>
    </div>
  );
}

function NumberStepper({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const copy = t().editor.imageEdit;
  const max = IMAGE_EDIT_LIMITS.maxMarkerNumber;
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
      <button type="button" aria-label={copy.numberDown} disabled={value <= 1} onClick={() => onChange(value - 1)} className={cn(pillButton, 'w-8 px-0 text-muted-foreground hover:bg-secondary disabled:opacity-40')}>
        <Minus className="size-3.5" />
      </button>
      <NumberField value={value} max={max} onChange={onChange} />
      <button type="button" aria-label={copy.numberUp} disabled={value >= max} onClick={() => onChange(value + 1)} className={cn(pillButton, 'w-8 px-0 text-muted-foreground hover:bg-secondary disabled:opacity-40')}>
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** The marker number, typed directly; committed on Enter or blur, clamped to 1…max. Arrow keys step it. */
function NumberField({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  const copy = t().editor.imageEdit;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const typed = Number.parseInt(draft, 10);
    if (!Number.isFinite(typed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(1, typed));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <input
      value={draft}
      inputMode="numeric"
      aria-label={copy.numberLabel}
      maxLength={String(max).length}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const next = Math.min(max, Math.max(1, value + (event.key === 'ArrowUp' ? 1 : -1)));
          if (next !== value) onChange(next);
        }
      }}
      className="h-7 w-10 rounded-sm bg-transparent text-center text-xs font-bold tabular-nums text-foreground outline-none transition-colors focus:bg-secondary"
    />
  );
}

/** The controls for what is selected, or for what the active tool draws next. Which controls appear comes from the field list. */
export default function ImageEditStylePanel({ fields, style, number, onChange }: Props) {
  const copy = t().editor.imageEdit;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label={copy.styleLabel}>
      {fields.map((field) => {
        switch (field) {
          case 'color':
            return <ColorControl key={field} color={style.color} onChange={(color) => onChange({ color })} />;
          case 'width':
            return (
              <Group key={field} label={copy.strokeLabel}>
                <Segmented
                  label={copy.strokeLabel}
                  value={style.strokeWidth}
                  onSelect={(strokeWidth) => onChange({ strokeWidth })}
                  options={IMAGE_EDIT_STROKE_WIDTHS.map((value) => ({
                    value,
                    title: copy.strokeWidths[value],
                    content: <span className="w-5 rounded-full bg-current" style={{ height: value }} aria-hidden="true" />,
                  }))}
                />
              </Group>
            );
          case 'fontSize':
            return (
              <Group key={field} label={copy.fontSizeLabel}>
                <Segmented
                  label={copy.fontSizeLabel}
                  value={style.fontSize}
                  onSelect={(fontSize) => onChange({ fontSize })}
                  options={IMAGE_EDIT_FONT_SIZES.map((value) => ({ value, title: copy.fontSizes[value], content: copy.fontSizes[value] }))}
                />
              </Group>
            );
          case 'look':
            return (
              <Group key={field} label={copy.lookLabel}>
                <Segmented
                  label={copy.lookLabel}
                  value={style.look}
                  onSelect={(look) => onChange({ look })}
                  options={TEXT_LOOKS.map((value) => ({
                    value,
                    title: copy.looks[value],
                    content: <LookSample look={value} color={style.color} />,
                  }))}
                />
              </Group>
            );
          case 'fill':
            return (
              <Group key={field} label={copy.fillLabel}>
                <Segmented
                  label={copy.fillLabel}
                  value={style.fill}
                  onSelect={(fill) => onChange({ fill })}
                  options={SHAPE_FILLS.map((value) => ({
                    value,
                    title: copy.fills[value],
                    content: (
                      <span
                        className="size-4 rounded-[4px] border-2 border-current"
                        style={value === 'tint' ? { backgroundColor: `color-mix(in srgb, ${style.color} 35%, transparent)` } : undefined}
                        aria-hidden="true"
                      />
                    ),
                  }))}
                />
              </Group>
            );
          case 'radius':
            return (
              <Group key={field} label={copy.radiusLabel}>
                <Segmented
                  label={copy.radiusLabel}
                  value={style.markerRadius}
                  onSelect={(markerRadius) => onChange({ markerRadius })}
                  options={IMAGE_EDIT_MARKER_RADII.map((value) => ({ value, title: copy.radii[value], content: copy.radii[value] }))}
                />
              </Group>
            );
          case 'number':
            return number === undefined ? null : (
              <Group key={field} label={copy.numberLabel}>
                <NumberStepper value={number} onChange={(next) => onChange({ number: next })} />
              </Group>
            );
        }
      })}
    </div>
  );
}

/** "Aa" drawn the way the look will render it, . */
function LookSample({ look, color }: { look: (typeof TEXT_LOOKS)[number]; color: string }) {
  const copy = t().editor.imageEdit;
  const dark = isDark(color);
  const edge = dark ? '#ffffff' : '#111111';
  return (
    <span
      className="rounded-[4px] px-1.5 text-sm leading-6 font-bold"
      style={{
        color,
        textShadow: look === 'outline' ? `-1px 0 ${edge}, 1px 0 ${edge}, 0 -1px ${edge}, 0 1px ${edge}` : undefined,
      }}
      aria-hidden="true"
    >
      {copy.lookSample}
    </span>
  );
}

function isDark(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

/** What the crop tool offers instead of style controls: the resulting size and a way to undo the crop. */
export function ImageEditCropPanel({ size, onClear }: CropProps) {
  const copy = t().editor.imageEdit;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-bold text-foreground tabular-nums">
        {size ? copy.cropSize(size.width, size.height) : copy.noCrop}
      </span>
      <button
        type="button"
        onClick={onClear}
        disabled={!size}
        className="flex h-8 items-center rounded-md border-2 border-border bg-card px-3 text-xs font-bold text-foreground outline-none transition-colors focus-ring hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
      >
        {copy.clearCrop}
      </button>
    </div>
  );
}

/** Duplicate, layer order and delete for the selected item. */
export function ImageEditItemActions({ onDuplicate, onBringToFront, onSendToBack, onDelete }: ItemActions) {
  const copy = t().editor.imageEdit;
  const action = (label: string, onClick: (() => void) | undefined, icon: ReactNode, danger = false) =>
    onClick && (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              'flex size-8 items-center justify-center rounded-sm outline-none transition-colors focus-ring',
              danger ? 'text-muted-foreground hover:bg-danger-soft hover:text-danger' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  return (
    <div className="flex items-center gap-0.5 rounded-md border-2 border-border bg-card p-0.5">
      {action(copy.duplicate, onDuplicate, <Copy className="size-4" />)}
      {action(copy.bringToFront, onBringToFront, <ArrowUpToLine className="size-4" />)}
      {action(copy.sendToBack, onSendToBack, <ArrowDownToLine className="size-4" />)}
      {action(copy.deleteSelected, onDelete, <Trash2 className="size-4" />, true)}
    </div>
  );
}
