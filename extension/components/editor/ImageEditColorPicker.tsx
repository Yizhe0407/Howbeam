import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { hexToHsv, hsvToHex, parseHexInput, type Hsv } from '@/lib/editor/hsv-color';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  color: string;
  /** Called once per finished change (drag released, key pressed, hex entered), so each is one undo step. */
  onChange: (color: string) => void;
  children: ReactNode;
}

const thumb = 'pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ring-2 ring-border';

/** Tracks a pointer drag over `element`, reporting the position as fractions of its box. */
function useDrag(onMove: (x: number, y: number) => void, onEnd: () => void) {
  const dragging = useRef(false);
  const report = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onMove(
      Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    );
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      report(event);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (dragging.current) report(event);
    },
    onPointerUp: () => {
      if (!dragging.current) return;
      dragging.current = false;
      onEnd();
    },
  };
}

/** Arrow keys move by 1 step, with Shift by 10; returns the delta, or null for other keys. */
function arrowDelta(event: KeyboardEvent, horizontal: boolean): { dx: number; dy: number } | null {
  const step = event.shiftKey ? 10 : 1;
  switch (event.key) {
    case 'ArrowLeft': return { dx: -step, dy: 0 };
    case 'ArrowRight': return { dx: step, dy: 0 };
    case 'ArrowUp': return horizontal ? { dx: step, dy: 0 } : { dx: 0, dy: step };
    case 'ArrowDown': return horizontal ? { dx: -step, dy: 0 } : { dx: 0, dy: -step };
    default: return null;
  }
}

/** The custom colour picker: saturation/brightness area, hue bar and a hex field, in the site's own style. */
export default function ImageEditColorPicker({ color, onChange, children }: Props) {
  const copy = t().editor.imageEdit;
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color));
  const [hexDraft, setHexDraft] = useState(color.slice(1));
  const latest = useRef(hsv);
  latest.current = hsv;

  // Follow the selection; a grey keeps the hue the user had picked.
  useEffect(() => {
    if (hsvToHex(latest.current) === color) return;
    setHsv(hexToHsv(color));
    setHexDraft(color.slice(1));
  }, [color]);

  const preview = (next: Hsv) => {
    setHsv(next);
    setHexDraft(hsvToHex(next).slice(1));
  };
  const commit = (next: Hsv = latest.current) => {
    const hex = hsvToHex(next);
    if (hex !== color) onChange(hex);
  };
  const step = (next: Hsv) => {
    preview(next);
    commit(next);
  };

  const area = useDrag((x, y) => preview({ ...latest.current, s: x, v: 1 - y }), () => commit());
  const hue = useDrag((x) => preview({ ...latest.current, h: Math.min(359, x * 360) }), () => commit());

  const onAreaKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = arrowDelta(event, false);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    step({ ...hsv, s: clamp(hsv.s + delta.dx / 100), v: clamp(hsv.v + delta.dy / 100) });
  };
  const onHueKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = arrowDelta(event, true);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    step({ ...hsv, h: Math.min(359, Math.max(0, hsv.h + delta.dx)) });
  };

  const commitHex = () => {
    const parsed = parseHexInput(hexDraft);
    if (!parsed) {
      setHexDraft(hsvToHex(hsv).slice(1));
      return;
    }
    const next = hexToHsv(parsed);
    // A grey carries no hue of its own; keep the one on the bar.
    step(next.s === 0 ? { ...next, h: hsv.h } : next);
  };

  const current = hsvToHex(hsv);
  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-60 flex-col gap-3 p-3"
        aria-label={copy.customColor}
        // Keys typed here must not reach the editor's tool and zoom shortcuts.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label={copy.colorArea}
          aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onKeyDown={onAreaKey}
          {...area}
          className="relative h-36 cursor-crosshair touch-none rounded-sm border-2 border-border outline-none focus-ring"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})` }}
        >
          <span className={thumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: current }} />
        </div>

        <div
          role="slider"
          tabIndex={0}
          aria-label={copy.hue}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuemin={0}
          aria-valuemax={359}
          onKeyDown={onHueKey}
          {...hue}
          className="relative h-3.5 cursor-pointer touch-none rounded-full border-2 border-border outline-none focus-ring"
          style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        >
          <span className={cn(thumb, 'top-1/2')} style={{ left: `${(hsv.h / 359) * 100}%`, backgroundColor: pureHue }} />
        </div>

        <div className="flex items-center gap-2">
          <span className="size-8 shrink-0 rounded-full border-2 border-border" style={{ backgroundColor: current }} aria-hidden="true" />
          <label className="flex h-8 min-w-0 flex-1 items-center rounded-md border-2 border-input bg-card px-2 text-xs font-bold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
            <span className="text-muted-foreground" aria-hidden="true">#</span>
            <input
              value={hexDraft}
              aria-label={copy.hexInput}
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setHexDraft(event.target.value)}
              onBlur={commitHex}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitHex();
              }}
              className="min-w-0 flex-1 bg-transparent pl-1 font-mono uppercase tabular-nums text-foreground outline-none"
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
