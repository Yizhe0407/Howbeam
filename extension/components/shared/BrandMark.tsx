import { cn } from '@/lib/shared/utils';
import Mascot from './Mascot';

/** The mascot plus wordmark the popup opens with; full pages get the same
 * pairing from AppHeader's home crumb. `heading` makes the wordmark the page's h1
 * for surfaces (the popup) that have no other title. */
export default function BrandMark({ className, heading = false }: { className?: string; heading?: boolean }) {
  const Wordmark = heading ? 'h1' : 'span';
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <Mascot />
      <Wordmark className="shrink-0 text-base font-bold text-foreground">Howbeam</Wordmark>
    </span>
  );
}
