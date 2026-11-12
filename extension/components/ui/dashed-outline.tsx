import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/shared/utils';

const STROKE = 2;
/** Dash and gap target the same length; the real value is nudged so the pattern closes exactly. */
const TARGET_PERIOD = 14;

interface DashedOutlineProps {
  /** Corner radius in px, or 'full' for a pill. Match the parent's `rounded-*`. */
  radius: number | 'full';
  /** Pixels the outline extends past the parent's padding box on every side, e.g. 2 to sit on a 2px border. */
  outset?: number;
  /** For a control whose hover state draws a solid border in its place; a plain container keeps its outline. */
  hideOnHover?: boolean;
  className?: string;
}

/**
 * Dashed outline with airy, perfectly even dashes. CSS `border-style: dashed`
 * can't tune dash length or gap, and an SVG with a fixed dash pattern leaves
 * one odd-sized dash where the path wraps around. This measures its own box and
 * picks the dash period that divides the outline's perimeter exactly, so every
 * dash is the same length, corners included.
 *
 * Drop it in as the first child of a `relative` element. With `hideOnHover` it hides itself while
 * the parent is hovered, so a hover border can take its place. An outset past
 * the padding box needs a parent that doesn't clip its overflow.
 */
export function DashedOutline({ radius, outset = 0, hideOnHover = false, className }: DashedOutlineProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      ref={ref}
      aria-hidden="true"
      data-slot="dashed-outline"
      className={cn(
        'pointer-events-none absolute overflow-visible text-border',
        hideOnHover && '[:hover>&]:hidden',
        className,
      )}
      // Inline, so a parent's `[&>svg]:size-*` rule (Badge has one) can't shrink it.
      style={{
        top: -outset,
        left: -outset,
        width: `calc(100% + ${outset * 2}px)`,
        height: `calc(100% + ${outset * 2}px)`,
      }}
    >
      {size && <OutlineRect width={size.width} height={size.height} radius={radius} />}
    </svg>
  );
}

function OutlineRect({
  width,
  height,
  radius,
}: { width: number; height: number } & Pick<DashedOutlineProps, 'radius'>) {
  // Inset by half the stroke so the line is drawn fully inside the box.
  const w = width - STROKE;
  const h = height - STROKE;
  if (w <= 0 || h <= 0) return null;

  const r = Math.min(radius === 'full' ? Infinity : radius, w / 2, h / 2);
  const perimeter = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
  const dashCount = Math.max(1, Math.round(perimeter / TARGET_PERIOD));
  const half = perimeter / dashCount / 2;

  return (
    <rect
      x={STROKE / 2}
      y={STROKE / 2}
      width={w}
      height={h}
      rx={r}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeDasharray={`${half} ${half}`}
    />
  );
}
