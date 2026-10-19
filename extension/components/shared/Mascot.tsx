import mascotUrl from '@/assets/brand/mascot.svg';
import { cn } from '@/lib/shared/utils';

interface Props {
  className?: string;
}

/**
 * Howbeam's sticker mascot: a little screenshot frame with a face. The
 * artwork lives in assets/brand/mascot.svg, the same file the toolbar icons are
 * rendered from, so the two can never drift. Colours are fixed rather than
 * themed — like a sticker, it looks the same on a light or dark page.
 * Decorative only; callers supply any accessible name.
 */
export default function Mascot({ className }: Props) {
  return <img src={mascotUrl} alt="" aria-hidden="true" draggable={false} className={cn('size-7 shrink-0 select-none', className)} />;
}
